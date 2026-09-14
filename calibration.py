# -*- coding: utf-8 -*-
"""
片盒焦面校准内核
测量: 在 3x3 或 5x5 网格录入胶片面相对毛玻璃基准的深度(mm, 正=片面向后沉,
      远离镜头), 区分 空载片槽 / 装片后 / 后背旋转180° 三种读数;
      网格行 0 = 片上沿, 列 0 = 片左沿(从镜头侧看片盒)。
拟合: 归一化坐标 u,v∈[-1,1] 上最小二乘拟合
      δ(u,v) = c + a·u + b·v + q·(u²+v²-2/3)
      c=平均深度, a/b=片面倾斜, q=局部弓曲(中心到边中的矢高, 二次项已零均值化)。
分析: 把拟合焦面带入当前后组位姿与光圈, 按网格返回焦移/弥散圈/超限区域;
      并生成 后背方向 / 后组轨道微调 / 收小光圈 三类比较方案,
      按 (超限面积, 最大弥散圈, 调整量) 排序。
单位: 内部一律 mm; 档案可记录 µm 读数, 拟合前换算。
"""
import copy
import math
import time

import camera_geometry as cg

CONDITIONS = ("empty", "loaded", "rotated")
COND_LABELS = {"empty": "空载片槽", "loaded": "装片后", "rotated": "后背旋转180°"}
ORIENTATIONS = {"landscape": "横幅", "portrait": "竖幅"}
GRID_CHOICES = (3, 5)
UM_PER_MM = 1000.0


# ---------------- 网格 ----------------
def grid_uv(i, j, n):
    """行 i(0=上) 列 j(0=左) -> 归一化坐标 (u 右+, v 上+)。"""
    u = -1.0 + 2.0 * j / (n - 1)
    v = 1.0 - 2.0 * i / (n - 1)
    return u, v


def eval_surface(surf, u, v):
    """拟合焦面深度 δ(u,v) mm。"""
    return (surf["c"] + surf["a"] * u + surf["b"] * v
            + surf["q"] * (u * u + v * v - 2.0 / 3.0))


def rotate_surface(surf, mode):
    """后背旋转后的等效焦面。rot180: 调头; rot90: 顺时针转竖/横幅(片幅互换)。"""
    s = dict(surf)
    if mode == "rot180":
        s["a"] = -surf["a"]
        s["b"] = -surf["b"]
    elif mode == "rot90":        # 横->竖 顺时针: a'=b, b'=-a
        s["a"] = surf["b"]
        s["b"] = -surf["a"]
        s["w"], s["h"] = surf.get("h"), surf.get("w")
    elif mode == "rot90ccw":     # 竖->横 逆时针
        s["a"] = -surf["b"]
        s["b"] = surf["a"]
        s["w"], s["h"] = surf.get("h"), surf.get("w")
    return s


# ---------------- 最小二乘拟合 ----------------
def _basis(u, v):
    return (1.0, u, v, u * u + v * v - 2.0 / 3.0)


def _solve(A, b):
    """n×n Gauss 消元(部分主元), 奇异返回 None。"""
    n = len(b)
    M = [A[i][:] + [b[i]] for i in range(n)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[piv][col]) < 1e-14:
            return None
        M[col], M[piv] = M[piv], M[col]
        for r in range(col + 1, n):
            f_ = M[r][col] / M[col][col]
            for k in range(col, n + 1):
                M[r][k] -= f_ * M[col][k]
    x = [0.0] * n
    for i in range(n - 1, -1, -1):
        s = M[i][n] - sum(M[i][j] * x[j] for j in range(i + 1, n))
        if abs(M[i][i]) < 1e-14:
            return None
        x[i] = s / M[i][i]
    return x


def fit_points(pts):
    """pts=[(u,v,y_mm)...] -> (c,a,b,q), 残差列。点数<4 返回 None。"""
    if len(pts) < 4:
        return None
    ata = [[0.0] * 4 for _ in range(4)]
    aty = [0.0] * 4
    for u, v, y in pts:
        p = _basis(u, v)
        for i in range(4):
            aty[i] += p[i] * y
            for j in range(4):
                ata[i][j] += p[i] * p[j]
    theta = _solve(ata, aty)
    if theta is None:
        return None
    resids = [y - (theta[0] + theta[1] * u + theta[2] * v
                   + theta[3] * (u * u + v * v - 2.0 / 3.0)) for u, v, y in pts]
    return theta, resids


def fit_condition(m, n, w, h):
    """单种读数 n×n 网格(mm) -> 拟合报告。测点不足返回 error。"""
    pts, cells_in = [], []
    for i, row in enumerate(m or []):
        for j, val in enumerate(row):
            if val is None:
                continue
            u, v = grid_uv(i, j, n)
            pts.append((u, v, float(val)))
            cells_in.append((i, j, u, v, float(val)))
    if len(pts) < 4:
        return {"error": "测点不足（至少 4 点）", "count": len(pts)}
    got = fit_points(pts)
    if got is None:
        return {"error": "测点退化，无法拟合", "count": len(pts)}
    (c, a, b, q), resids = got
    rms = math.sqrt(sum(r * r for r in resids) / len(resids))
    cells = []
    for (i, j, u, v, y), r in zip(cells_in, resids):
        cells.append({"i": i, "j": j, "u": round(u, 6), "v": round(v, 6),
                      "meas": y, "fit": y - r, "resid": r})
    hw, hh = max(w / 2.0, 1e-9), max(h / 2.0, 1e-9)
    return {
        "c": c, "a": a, "b": b, "q": q,
        "offset_mm": c,                       # 平均深度
        "tilt_s_deg": math.degrees(math.atan(a / hw)),   # 左右倾斜
        "tilt_t_deg": math.degrees(math.atan(b / hh)),   # 上下倾斜
        "bow_mm": q,                          # 弓曲矢高(中心->边中)
        "rms": rms, "max_resid": max(abs(r) for r in resids),
        "count": len(pts), "cells": cells,
    }


def surface_from_fit(fc, w, h, n):
    return {"c": fc["c"], "a": fc["a"], "b": fc["b"], "q": fc["q"],
            "w": w, "h": h, "grid": n}


def build_fit(meas_mm, n, w, h):
    """
    三种读数(mm) -> 完整拟合结果:
      conditions  每条件 倾斜/弓曲/RMS/逐点残差
      surface     工作焦面(取装片后)
      film_extra  胶片自身变形(装片-空载)
      rot_disagree_mm  旋转180°读数与装片读数镜像的最大偏差(方向敏感性)
    """
    conds = {}
    for name in CONDITIONS:
        m = meas_mm.get(name)
        conds[name] = fit_condition(m, n, w, h) if m else None
    out = {"grid": n, "film_w": w, "film_h": h, "unit": "mm",
           "conditions": conds, "surface": None,
           "film_extra": None, "rot_disagree_mm": None,
           "computed_at": time.time()}
    ld, em, rt = conds["loaded"], conds["empty"], conds["rotated"]
    if ld and "c" in ld:
        out["surface"] = surface_from_fit(ld, w, h, n)
    # 胶片自身变形 = 装片 - 空载(逐有效点)
    if ld and em and "c" in ld and "c" in em:
        diff = [[None] * n for _ in range(n)]
        for i in range(n):
            for j in range(n):
                lv = (meas_mm["loaded"][i] or [None] * n)[j]
                ev = (meas_mm["empty"][i] or [None] * n)[j]
                if lv is not None and ev is not None:
                    diff[i][j] = lv - ev
        fe = fit_condition(diff, n, w, h)
        if fe and "c" in fe:
            out["film_extra"] = fe
    # 旋转一致性: 旋转后 (i,j) 对应旋转前 (n-1-i, n-1-j)
    if ld and rt and meas_mm.get("rotated"):
        worst = 0.0
        for i in range(n):
            for j in range(n):
                rv = (meas_mm["rotated"][i] or [None] * n)[j]
                lv = (meas_mm["loaded"][n - 1 - i] or [None] * n)[n - 1 - j]
                if rv is not None and lv is not None:
                    worst = max(worst, abs(rv - lv))
        out["rot_disagree_mm"] = worst
    return out


# ---------------- 数据清洗 ----------------
def clean_meas(meas, n):
    """校验/补全 n×n 读数网格; 全空条件记 None。"""
    out = {}
    for name in CONDITIONS:
        m = (meas or {}).get(name)
        if not isinstance(m, list):
            out[name] = None
            continue
        grid = []
        for i in range(n):
            src = m[i] if i < len(m) and isinstance(m[i], list) else []
            row = []
            for j in range(n):
                v = src[j] if j < len(src) else None
                try:
                    row.append(float(v) if v is not None and v != "" else None)
                except (TypeError, ValueError):
                    row.append(None)
            grid.append(row)
        out[name] = None if all(v is None for r in grid for v in r) else grid
    return out


def meas_to_mm(meas, unit):
    """读数按档案单位换算为 mm。"""
    k = 0.001 if unit == "µm" else 1.0
    out = {}
    for name, m in (meas or {}).items():
        if m is None:
            out[name] = None
        else:
            out[name] = [[None if v is None else v * k for v in row] for row in m]
    return out


def clean_calib_snapshot(data):
    """校验随 state 携带/提交分析的校准快照(不可变)。"""
    if not isinstance(data, dict):
        return None
    surf = data.get("surface")
    if not isinstance(surf, dict):
        return None
    try:
        surface = {"c": float(surf["c"]), "a": float(surf["a"]),
                   "b": float(surf["b"]), "q": float(surf["q"])}
    except (KeyError, TypeError, ValueError):
        return None

    def _f(v, d=0.0):
        try:
            return float(v)
        except (TypeError, ValueError):
            return d

    surface["w"] = _f(surf.get("w"))
    surface["h"] = _f(surf.get("h"))
    try:
        g = int(float(surf.get("grid", data.get("grid", 3))))
    except (TypeError, ValueError):
        g = 3
    surface["grid"] = g if g in GRID_CHOICES else 3
    try:
        ver = int(float(data.get("version") or 0))
    except (TypeError, ValueError):
        ver = 0
    try:
        pid = int(float(data.get("profile_id") or 0))
    except (TypeError, ValueError):
        pid = 0
    ori = str(data.get("orientation", "landscape"))
    return {
        "profile_id": pid, "version": ver,
        "label": str(data.get("label", ""))[:120],
        "orientation": ori if ori in ORIENTATIONS else "landscape",
        "unit": "µm" if data.get("unit") == "µm" else "mm",
        "grid": surface["grid"],
        "surface": surface,
    }


# ---------------- 焦移 / 弥散圈分析 ----------------
def ctx_from_state(state, aperture=None, rear_dx=0.0):
    """由机位状态构造分析上下文(光轴伸长/有效光圈/后组法线轴向分量)。"""
    st = state
    if rear_dx:
        st = copy.deepcopy(state)
        st["pose"]["rear"]["x"] = st["pose"]["rear"].get("x", 0.0) + rear_dx
    res = cg.compute(st, do_blur=False)
    cam = st["camera"]
    R, L = cg.pose_frames(st["pose"])
    return {"extension": res["extension"], "f": cam["focal"],
            "aperture": float(aperture or cam["aperture"]),
            "coc": cam["coc"], "film_w": cam["film_w"], "film_h": cam["film_h"],
            "n_rx": R[0][0], "n_lx": L[0][0],
            "magnification": res["magnification"]}


def grid_analysis(state, calib, ctx=None, overrides=None):
    """
    拟合焦面 + 当前后组位姿/光圈 -> 按网格的焦移/弥散圈/超限区域。
    overrides: aperture(收小光圈), rear_dx(后组轨道微调 mm), film_swap(片幅旋转)。
    ctx 由 camera_geometry.compute 在集成时传入, 避免重复计算与递归。
    """
    ov = overrides or {}
    if ctx is None:
        ctx = ctx_from_state(state, aperture=ov.get("aperture"),
                             rear_dx=float(ov.get("rear_dx") or 0.0))
    elif ov.get("aperture"):
        ctx = dict(ctx)
        ctx["aperture"] = float(ov["aperture"])
    if ov.get("film_swap"):
        ctx = dict(ctx)
        ctx["film_w"], ctx["film_h"] = ctx["film_h"], ctx["film_w"]
    cam = state["camera"]
    surf = calib["surface"]
    n = int(surf.get("grid") or calib.get("grid") or 3)
    if n not in GRID_CHOICES:
        n = 3
    w, h = float(ctx["film_w"]), float(ctx["film_h"])
    f, N, coc = ctx["f"], ctx["aperture"], ctx["coc"]
    e = ctx["extension"]
    n_eff = e * N / max(f, 1e-9)          # 有效光圈(像侧)
    dx = float(ov.get("rear_dx") or 0.0)
    d_off = dx * ctx.get("n_rx", 1.0)     # 轨道微调在片法线方向的补偿量
    m = e / max(f, 1e-9) - 1.0
    k_subj = 1.0 / (m * m) if m > 0.02 else None   # 物方焦移系数 (ξ/f)²

    cells = []
    max_blur = max_abs = sum_abs = 0.0
    over_n = 0
    for i in range(n):
        for j in range(n):
            u, v = grid_uv(i, j, n)
            delta = eval_surface(surf, u, v) - d_off
            blur = abs(delta) / n_eff
            over = blur > coc
            over_n += 1 if over else 0
            max_blur = max(max_blur, blur)
            max_abs = max(max_abs, abs(delta))
            sum_abs += abs(delta)
            cells.append({
                "i": i, "j": j, "u": round(u, 6), "v": round(v, 6),
                "s": round(u * w / 2.0, 3), "t": round(v * h / 2.0, 3),
                "delta": round(delta, 6), "blur": round(blur, 6),
                "shift_subj": round(delta * k_subj, 3) if k_subj else None,
                "over": over})
    # 超限面积: 细密采样估计
    S = 31
    sover = 0
    for ii in range(S):
        for jj in range(S):
            u = -1.0 + 2.0 * jj / (S - 1)
            v = 1.0 - 2.0 * ii / (S - 1)
            if abs(eval_surface(surf, u, v) - d_off) / n_eff > coc:
                sover += 1
    pct = 100.0 * sover / (S * S)
    note = ""
    sw, sh = surf.get("w") or 0.0, surf.get("h") or 0.0
    if sw and abs(sw - w) > 1.0 or sh and abs(sh - h) > 1.0:
        note = "校准片幅 %gx%g 与当前片幅 %gx%g 不一致" % (sw, sh, w, h)
    return {
        "label": calib.get("label", ""), "grid": n, "unit": calib.get("unit", "mm"),
        "cells": cells, "over_cells": over_n,
        "max_blur": max_blur, "max_abs_delta": max_abs,
        "mean_abs_delta": sum_abs / (n * n),
        "over_area_pct": pct, "over_area_mm2": pct / 100.0 * w * h,
        "n_eff": n_eff, "tolerance": coc, "extension": e, "aperture": N,
        "subj_shift_factor": k_subj, "film_w": w, "film_h": h,
        "note": note,
    }


def _summary(an):
    return {"over_pct": an["over_area_pct"], "over_mm2": an["over_area_mm2"],
            "max_blur": an["max_blur"], "mean_abs_delta": an["mean_abs_delta"],
            "max_abs_delta": an["max_abs_delta"]}


def compare_schemes(state, calib, opts=None):
    """
    三类调整方案比较(机位锁定与否仅影响轨道微调范围):
      后背方向(旋转180°/转竖横幅) / 后组轨道微调 / 收小光圈。
    按 (超限面积, 最大弥散圈, 调整量) 排序。
    """
    opts = opts or {}
    lock = bool(opts.get("lock_pos", True))
    a_max = float(opts.get("aperture_max") or 64.0)
    cam = state["camera"]
    base = grid_analysis(state, calib)
    schemes = []
    # 后背方向
    ori = calib.get("orientation", "landscape")
    rot90 = "rot90" if ori == "landscape" else "rot90ccw"
    for mode, label, note, cost, swap in (
            ("rot180", "后背旋转180°", "片盒调头，构图不变", 2.0, False),
            (rot90, "后背转竖幅" if ori == "landscape" else "后背转横幅",
             "需重新构图", 4.0, True)):
        cal2 = dict(calib)
        cal2["surface"] = rotate_surface(calib["surface"], mode)
        an = grid_analysis(state, cal2, overrides={"film_swap": swap})
        schemes.append({"kind": "orientation", "label": label, "note": note,
                        "apply": {"orientation": mode}, "cost": cost,
                        **_summary(an)})
    # 后组轨道微调(锁定机位时仅 ±2mm 细调)
    rng, step = (2.0, 0.5) if lock else (8.0, 1.0)
    dx = -rng
    while dx <= rng + 1e-9:
        if abs(dx) > 1e-9:
            an = grid_analysis(state, calib, overrides={"rear_dx": dx})
            schemes.append({"kind": "rail", "label": "后组轨道 %+.1f mm" % dx,
                            "note": "机位锁定·微调" if lock else "轨道调整",
                            "apply": {"rear_dx": dx}, "cost": abs(dx),
                            **_summary(an)})
        dx += step
    # 收小光圈(1/3 档步进, 至多 8/3 档)
    n0 = cam["aperture"]
    for k in (1, 2, 3, 4, 6, 8):
        N = n0 * 2.0 ** (k / 3.0)
        if N > a_max + 1e-9:
            continue
        an = grid_analysis(state, calib, overrides={"aperture": N})
        stops = k / 3.0
        schemes.append({"kind": "aperture", "label": "收光圈到 f/%.1f" % N,
                        "note": "%+g 档" % stops,
                        "apply": {"aperture": round(N, 2)},
                        "cost": stops * 1.5, **_summary(an)})
    schemes.sort(key=lambda s: (round(s["over_pct"], 3),
                                round(s["max_blur"], 4), round(s["cost"], 3)))
    return {"base": _summary(base), "schemes": schemes[:24]}


# ---------------- 自检 ----------------
if __name__ == "__main__":
    # 合成表面: c=0.05 a=0.08 b=-0.04 q=0.06, 5x5 无噪声应精确还原
    n = 5
    m = [[0.05 + 0.08 * grid_uv(i, j, n)[0] - 0.04 * grid_uv(i, j, n)[1]
          + 0.06 * (grid_uv(i, j, n)[0] ** 2 + grid_uv(i, j, n)[1] ** 2 - 2 / 3)
          for j in range(n)] for i in range(n)]
    fc = fit_condition(m, n, 127.0, 102.0)
    assert abs(fc["c"] - 0.05) < 1e-9 and abs(fc["a"] - 0.08) < 1e-9
    assert abs(fc["b"] + 0.04) < 1e-9 and abs(fc["q"] - 0.06) < 1e-9
    assert fc["rms"] < 1e-9
    print("拟合还原: c=%.3f a=%.3f b=%.3f q=%.3f rms=%.2e (通过)"
          % (fc["c"], fc["a"], fc["b"], fc["q"], fc["rms"]))
    # 分析: 均匀后沉 1.0mm, f/5.6 下应超限
    st = cg.default_state()
    cg.autofocus(st)
    st["camera"]["aperture"] = 5.6
    calib = {"label": "自检", "grid": 3,
             "surface": {"c": 1.0, "a": 0.0, "b": 0.0, "q": 0.0,
                         "w": 127.0, "h": 102.0, "grid": 3}}
    an = grid_analysis(st, calib)
    n_eff = an["n_eff"]
    assert abs(an["max_blur"] - 1.0 / n_eff) < 1e-6
    assert an["over_area_pct"] > 99.0
    print("分析: 有效光圈 f/%.1f, 弥散圈 %.3f mm, 超限 %.0f%% (通过)"
          % (n_eff, an["max_blur"], an["over_area_pct"]))
    # 方案: 轨道 +1mm 应基本消除; 收光圈降低弥散圈
    out = compare_schemes(st, calib, {"lock_pos": False})
    rail = [s for s in out["schemes"] if s["kind"] == "rail"]
    best = min(rail, key=lambda r: r["over_pct"])
    assert best["over_pct"] < 1.0, best
    ap = [s for s in out["schemes"] if s["kind"] == "aperture"]
    assert ap and ap[0]["max_blur"] < out["base"]["max_blur"]
    print("方案: 最优轨道 %s (超限 %.0f%%), 光圈方案 %d 个 (通过)"
          % (best["label"], best["over_pct"], len(ap)))
    print("校准内核自检通过。")
