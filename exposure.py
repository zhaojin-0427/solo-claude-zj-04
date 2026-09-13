# -*- coding: utf-8 -*-
"""
曝光测算内核
链路: 测光值 -> 皮腔补偿(按光轴伸长/放大率) -> 滤镜倍率 -> 倒易律迭代
      -> 等效快门-光圈组合 -> 景深复核(复用 camera_geometry)。
单位: 时间 s, 光圈 f/, 测光 EV 以 ISO100 为基准。
"""
import copy
import math

import camera_geometry as cg

# 标准快门档位(秒): 机械快门 1s-1/500 + B 门长曝参考档
SHUTTER_STOPS = [
    ("1/500", 1 / 500), ("1/250", 1 / 250), ("1/125", 1 / 125),
    ("1/60", 1 / 60), ("1/30", 1 / 30), ("1/15", 1 / 15), ("1/8", 1 / 8),
    ("1/4", 1 / 4), ("1/2", 1 / 2), ("1", 1.0),
    ("2", 2.0), ("4", 4.0), ("8", 8.0), ("15", 15.0), ("30", 30.0),
    ("60", 60.0), ("120", 120.0), ("240", 240.0), ("480", 480.0),
]

INCIDENT_C = 250.0          # 入射式测光表常数 C
MAX_RECIP_ITER = 60         # 倒易律不动点迭代上限

# 倒易律曲线预设 [(测光时间 s, 修正系数)]; 近似值, 现场应按胶片 datasheet 校对
RECIP_PRESETS = {
    "none":    {"name": "无修正", "points": [[0.001, 1.0], [10000.0, 1.0]]},
    "generic": {"name": "通用乳剂(估算)",
                "points": [[1.0, 1.15], [10.0, 1.5], [100.0, 2.4], [1000.0, 4.5]]},
    "fp4":     {"name": "Ilford FP4+ (近似)",
                "points": [[1.0, 1.26], [10.0, 2.0], [100.0, 4.0], [1000.0, 9.0]]},
    "hp5":     {"name": "Ilford HP5+ (近似)",
                "points": [[1.0, 1.16], [10.0, 1.5], [100.0, 2.2], [1000.0, 3.5]]},
    "delta100": {"name": "Ilford Delta 100 (近似)",
                 "points": [[1.0, 1.1], [10.0, 1.3], [100.0, 1.9], [1000.0, 3.0]]},
    "trix":    {"name": "Kodak Tri-X 400 (近似)",
                "points": [[1.0, 1.2], [10.0, 1.6], [100.0, 2.5], [1000.0, 4.5]]},
    "portra":  {"name": "Kodak Portra (近似)",
                "points": [[1.0, 1.1], [10.0, 1.4], [100.0, 2.2], [1000.0, 4.0]]},
    "foma":    {"name": "Fomapan (近似, 修正强)",
                "points": [[1.0, 1.5], [10.0, 3.0], [100.0, 8.0], [1000.0, 20.0]]},
}


# ---------------- 默认设置 / 冻结 ----------------
def default_setup(state):
    cam = state["camera"]
    return {
        "meter": {"mode": "ev", "value": 12.0},   # ev: EV@ISO100; lux: 入射照度
        "iso": 100.0,
        "filter_factor": 1.0,
        "f_step": 1.0 / 3.0,                      # 光圈步进(EV)
        "aperture_min": 5.6,
        "aperture_max": 64.0,
        "shutters": [t for _, t in SHUTTER_STOPS],
        "reciprocity": {"preset": "none",
                        "points": [list(p) for p in RECIP_PRESETS["none"]["points"]]},
        "max_exposure": 480.0,                    # 最长曝光 s
        "bracket": {"levels": 1, "step": 1.0},    # 包围: 每侧级数 / 级差 EV
        "lock": {"shutter": False, "aperture": False},
        "selection": {"aperture": cam["aperture"], "shutter": None},
    }


def freeze_state(state):
    """建单时冻结机位: 片幅/焦距/光圈/前后组位姿随 state 固化, 不再自动对焦。"""
    st = copy.deepcopy(state)
    st["pose"]["focus_mode"] = "manual"
    return st


def clean_setup(setup, state):
    """补全/校正前端提交的设置。"""
    base = default_setup(state)
    if not isinstance(setup, dict):
        return base
    out = dict(base)
    m = setup.get("meter") or {}
    mode = m.get("mode", "ev")
    out["meter"] = {"mode": mode if mode in ("ev", "lux") else "ev",
                    "value": max(0.001, _f(m.get("value"), 12.0))}
    out["iso"] = max(1.0, _f(setup.get("iso"), 100.0))
    out["filter_factor"] = max(0.1, _f(setup.get("filter_factor"), 1.0))
    out["f_step"] = _f(setup.get("f_step"), 1.0 / 3.0)
    if out["f_step"] not in (1.0 / 3.0, 0.5, 1.0):
        # 容忍浮点误差
        for cand in (1.0 / 3.0, 0.5, 1.0):
            if abs(out["f_step"] - cand) < 1e-6:
                out["f_step"] = cand
                break
        else:
            out["f_step"] = 1.0 / 3.0
    out["aperture_min"] = max(1.0, _f(setup.get("aperture_min"), 5.6))
    out["aperture_max"] = max(out["aperture_min"], _f(setup.get("aperture_max"), 64.0))
    sh = [float(t) for t in (setup.get("shutters") or []) if 1e-5 < float(t) < 1e5]
    out["shutters"] = sorted(set(sh)) or list(base["shutters"])
    rec = setup.get("reciprocity") or {}
    pts = []
    for p in rec.get("points") or []:
        try:
            t, k = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError):
            continue
        if t > 0 and k >= 1.0:
            pts.append([t, k])
    pts.sort(key=lambda q: q[0])
    if len(pts) < 2:
        pts = [list(p) for p in RECIP_PRESETS["none"]["points"]]
    out["reciprocity"] = {"preset": str(rec.get("preset", ""))[:40], "points": pts}
    out["max_exposure"] = max(0.01, _f(setup.get("max_exposure"), 480.0))
    br = setup.get("bracket") or {}
    out["bracket"] = {"levels": min(4, max(0, int(_f(br.get("levels"), 1)))),
                      "step": min(4.0, max(0.1, _f(br.get("step"), 1.0)))}
    lk = setup.get("lock") or {}
    out["lock"] = {"shutter": bool(lk.get("shutter")),
                   "aperture": bool(lk.get("aperture"))}
    sel = setup.get("selection") or {}
    ap = sel.get("aperture")
    shut = sel.get("shutter")
    out["selection"] = {
        "aperture": float(ap) if ap else base["selection"]["aperture"],
        "shutter": float(shut) if shut else None,
    }
    return out


def _f(v, dflt):
    try:
        return float(v)
    except (TypeError, ValueError):
        return dflt


# ---------------- 测光 / 补偿 ----------------
def meter_time(setup, N):
    """测光表直接给出的曝光时间(未作皮腔/滤镜补偿)。"""
    iso = setup["iso"]
    m = setup["meter"]
    if m["mode"] == "lux":
        return N * N * INCIDENT_C / (max(m["value"], 1e-6) * iso)
    return N * N * 100.0 / (2.0 ** m["value"] * iso)


def bellows_factor(state):
    """皮腔补偿: (光轴伸长/焦距)^2 = (1+m)^2。返回 (倍率, 伸长, 放大率)。"""
    cam = state["camera"]
    res = cg.compute(state, do_blur=False)
    e = res["extension"]
    f = max(cam["focal"], 1e-6)
    return (e / f) ** 2, e, e / f - 1.0


# ---------------- 倒易律 ----------------
def factor_at(t, pts):
    """曲线 log-log 插值。返回 (系数, 是否在曲线范围内)。"""
    if t <= pts[0][0]:
        return pts[0][1], abs(t - pts[0][0]) < 1e-9 or t >= pts[0][0]
    if t >= pts[-1][0]:
        return pts[-1][1], t <= pts[-1][0]
    lo, hi = 0, len(pts) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if pts[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    t1, f1 = pts[lo]
    t2, f2 = pts[hi]
    lt = math.log(t)
    r = (lt - math.log(t1)) / (math.log(t2) - math.log(t1))
    return math.exp(math.log(f1) + r * (math.log(f2) - math.log(f1))), True


def reciprocity_solve(t_target, pts):
    """
    迭代求解倒易律修正: t_actual = t_target * factor(t_actual)。
    返回 (t_actual, 系数, 在曲线范围内, 迭代次数)。
    """
    t = t_target
    for i in range(MAX_RECIP_ITER):
        k, _ = factor_at(t, pts)
        t_new = t_target * k
        if abs(t_new - t) <= 1e-6 * max(1.0, t_new):
            t = t_new
            break
        t = t_new
    k, inside = factor_at(t, pts)
    return t, k, inside, i + 1


# ---------------- 档位 ----------------
def aperture_grid(setup, include=None):
    """按步进生成光圈档位序列; include 中的值(如冻结光圈)保证在列。"""
    a_min, a_max, step = setup["aperture_min"], setup["aperture_max"], setup["f_step"]
    vals = []
    k = 0
    while True:
        N = a_min * 2.0 ** (k * step / 2.0)
        if N > a_max * (1 + 1e-9):
            break
        vals.append(N)
        k += 1
    if not vals or abs(vals[-1] - a_max) > 1e-9:
        vals.append(a_max)
    for extra in (include or []):
        if extra and a_min - 1e-9 <= extra <= a_max + 1e-9 and \
           all(abs(extra - v) > 1e-6 for v in vals):
            vals.append(extra)
    return sorted(vals)


def nearest_aperture(setup, N):
    """吸附到最近步进档位(对数空间)。"""
    grid = aperture_grid(setup)
    return min(grid, key=lambda g: abs(math.log(g / N)))


def nearest_shutter(setup, t):
    """最近可用快门档位(对数空间)。返回 (档位秒, 是否在可用范围内)。"""
    sh = setup["shutters"]
    best = min(sh, key=lambda s: abs(math.log(s / t)))
    return best, sh[0] - 1e-12 <= t <= sh[-1] + 1e-12


def shutter_label(t):
    if t >= 1:
        return ("%g" % round(t, 2)) + "s"
    return "1/%d" % round(1.0 / t)


# ---------------- 景深复核(按光圈重算几何, 带缓存) ----------------
_BLUR_CACHE = {}


def _state_sig(state):
    import json
    cam = state["camera"]
    keys = ("film_w", "film_h", "focal", "image_circle", "coc")
    return json.dumps([[cam[k] for k in keys], state["pose"], state["points"]],
                      sort_keys=True)


def blur_at(state, sig, N):
    """光圈 N 下的最大模糊圆与最差对焦点。"""
    key = (sig, round(N, 4))
    if key in _BLUR_CACHE:
        return _BLUR_CACHE[key]
    st = copy.deepcopy(state)
    st["camera"]["aperture"] = N
    res = cg.compute(st)
    worst = None
    for rec in res["points"]:
        if rec["kind"] == "focus" and rec["blur"] is not None:
            if worst is None or rec["blur"] > worst["blur"]:
                worst = rec
    out = {"max_blur": res["max_blur"],
           "worst_point": worst["name"] if worst else None,
           "worst_blur": worst["blur"] if worst else None,
           "result": res}
    if len(_BLUR_CACHE) > 400:
        _BLUR_CACHE.clear()
    _BLUR_CACHE[key] = out
    return out


# ---------------- 主计算 ----------------
def calc(state, setup):
    """
    返回曝光测算全量结果:
      factors  修正链路(皮腔/滤镜/倒易律)
      combos   等效快门-光圈组合(每档光圈一行)
      selected 当前选定组合(含锁定反算与 EV 误差)
      brackets 包围序列
      warnings 越界警告(定位参数与对焦点)
      geometry 选定光圈下的几何(景深楔形/毛玻璃/对焦点)
    """
    setup = clean_setup(setup, state)
    st = freeze_state(state)
    cam = st["camera"]
    coc = cam["coc"]
    sig = _state_sig(st)

    fb, ext, mag = bellows_factor(st)
    ff = setup["filter_factor"]
    pts = setup["reciprocity"]["points"]
    f0 = cam["aperture"]                     # 冻结光圈

    def chain(N):
        """光圈 N 下的完整修正链。"""
        t_m = meter_time(setup, N)
        t_t = t_m * fb * ff
        t_a, k, inside, it = reciprocity_solve(t_t, pts)
        return {"t_meter": t_m, "t_target": t_t, "t_actual": t_a,
                "recip_factor": k, "recip_inside": inside, "recip_iter": it}

    def issues_for(N, ch):
        """单组合的越界检查, 返回 (问题列表, 景深信息)。"""
        iss = []
        sh, in_range = nearest_shutter(setup, ch["t_actual"])
        if not in_range:
            iss.append({"code": "shutter_range", "param": "shutter",
                        "msg": "光圈 f/%g 需要 %s，超出可用快门范围（%s–%s）"
                               % (N, shutter_label(ch["t_actual"]),
                                  shutter_label(setup["shutters"][0]),
                                  shutter_label(setup["shutters"][-1]))})
        elif abs(math.log2(sh / ch["t_actual"])) > 0.5:
            iss.append({"code": "shutter_step", "param": "shutter",
                        "msg": "光圈 f/%g 最近快门档位 %s 偏差 %.1f EV"
                               % (N, shutter_label(sh),
                                  math.log2(sh / ch["t_actual"]))})
        if ch["t_actual"] > setup["max_exposure"]:
            iss.append({"code": "max_exposure", "param": "max_exposure",
                        "msg": "光圈 f/%g 实际曝光 %s 超过最长曝光 %s"
                               % (N, shutter_label(ch["t_actual"]),
                                  shutter_label(setup["max_exposure"]))})
        if not ch["recip_inside"]:
            iss.append({"code": "reciprocity", "param": "reciprocity",
                        "msg": "光圈 f/%g 实际曝光 %s 超出倒易律曲线范围（%s–%s）"
                               % (N, shutter_label(ch["t_actual"]),
                                  shutter_label(pts[0][0]),
                                  shutter_label(pts[-1][0]))})
        dof = blur_at(st, sig, N)
        if dof["max_blur"] > coc:
            iss.append({"code": "dof", "param": "aperture",
                        "point": dof["worst_point"],
                        "msg": "光圈 f/%g 景深不足：对焦点「%s」模糊圆 %.3f mm（容许 %.2f）"
                               % (N, dof["worst_point"] or "?", dof["worst_blur"], coc)})
        return iss, dof

    # ---- 等效组合表 ----
    combos = []
    for N in aperture_grid(setup, include=[f0]):
        ch = chain(N)
        sh, _ = nearest_shutter(setup, ch["t_actual"])
        iss, dof = issues_for(N, ch)
        combos.append({
            "aperture": round(N, 2),
            "is_frozen": abs(N - f0) < 1e-6,
            "t_meter": ch["t_meter"], "t_target": ch["t_target"],
            "t_actual": ch["t_actual"], "recip_factor": ch["recip_factor"],
            "shutter": sh, "shutter_label": shutter_label(sh),
            "ev_err": math.log2(sh / ch["t_actual"]),
            "max_blur": dof["max_blur"], "worst_point": dof["worst_point"],
            "issues": iss, "ok": not iss,
        })

    # ---- 选定组合 ----
    sel = setup["selection"]
    lock = setup["lock"]
    warnings = []
    if lock["shutter"] and sel.get("shutter"):
        # 锁定快门: 反算精确光圈, 再吸附步进档位
        t_lock = sel["shutter"]
        N_exact = solve_aperture(setup, fb * ff, pts, t_lock)
        N_snap = nearest_aperture(setup, N_exact)
        ch = chain(N_snap)
        ev_err = math.log2(t_lock / ch["t_actual"])
        selected = {"mode": "lock_shutter", "aperture": N_snap,
                    "aperture_exact": N_exact, "shutter": t_lock,
                    "shutter_label": shutter_label(t_lock),
                    "t_actual": ch["t_actual"], "t_target": ch["t_target"],
                    "t_meter": ch["t_meter"], "recip_factor": ch["recip_factor"],
                    "ev_err": ev_err, "chain": ch}
        iss, dof = issues_for(N_snap, ch)
        if abs(ev_err) > 0.05:
            warnings.append({"code": "ev_mismatch", "param": "aperture",
                             "msg": "锁定快门 %s：吸附光圈 f/%.1f（精确需 f/%.1f），曝光偏差 %+.2f EV"
                                    % (shutter_label(t_lock), N_snap, N_exact, ev_err)})
        warnings.extend(iss)
    elif lock["aperture"] and sel.get("shutter"):
        # 锁定光圈 + 指定快门: 手动组合, 报告曝光偏差
        N = sel.get("aperture") or f0
        t_man = sel["shutter"]
        ch = chain(N)
        ev_err = math.log2(t_man / ch["t_actual"])
        selected = {"mode": "manual", "aperture": N,
                    "aperture_exact": N, "shutter": t_man,
                    "shutter_label": shutter_label(t_man),
                    "t_actual": ch["t_actual"], "t_target": ch["t_target"],
                    "t_meter": ch["t_meter"], "recip_factor": ch["recip_factor"],
                    "ev_err": ev_err, "chain": ch}
        iss, dof = issues_for(N, ch)
        if abs(ev_err) > 0.05:
            warnings.append({"code": "ev_mismatch", "param": "shutter",
                             "msg": "手动组合 f/%g + %s：需要 %s，曝光偏差 %+.2f EV"
                                    % (N, shutter_label(t_man),
                                       shutter_label(ch["t_actual"]), ev_err)})
        warnings.extend(iss)
    else:
        N = sel.get("aperture") or f0
        ch = chain(N)
        sh, _ = nearest_shutter(setup, ch["t_actual"])
        ev_err = math.log2(sh / ch["t_actual"])
        selected = {"mode": "lock_aperture", "aperture": N,
                    "aperture_exact": N, "shutter": sh,
                    "shutter_label": shutter_label(sh),
                    "t_actual": ch["t_actual"], "t_target": ch["t_target"],
                    "t_meter": ch["t_meter"], "recip_factor": ch["recip_factor"],
                    "ev_err": ev_err, "chain": ch}
        iss, dof = issues_for(N, ch)
        warnings.extend(iss)

    # ---- 包围序列(以选定光圈为基准, 改时间) ----
    brackets = []
    br = setup["bracket"]
    N_sel = selected["aperture"]
    ch_sel = chain(N_sel)
    for i in range(-br["levels"], br["levels"] + 1):
        t_t = ch_sel["t_target"] * 2.0 ** (i * br["step"])
        t_a, k, inside, _ = reciprocity_solve(t_t, pts)
        sh, in_range = nearest_shutter(setup, t_a)
        brackets.append({"label": "%+d" % i if i else "0",
                         "ev": i * br["step"],
                         "t_target": t_t, "t_actual": t_a,
                         "shutter": sh, "shutter_label": shutter_label(sh),
                         "recip_inside": inside,
                         "in_range": in_range,
                         "over_max": t_a > setup["max_exposure"]})

    # ---- 选定光圈下的几何(景深楔形/毛玻璃) ----
    geo = blur_at(st, sig, N_sel)["result"]

    return {
        "setup": setup,
        "frozen": {"aperture": f0, "focal": cam["focal"],
                   "film_w": cam["film_w"], "film_h": cam["film_h"],
                   "coc": coc},
        "factors": {"bellows": fb, "bellows_ev": math.log2(fb),
                    "filter": ff, "filter_ev": math.log2(ff),
                    "extension": ext, "magnification": mag,
                    "recip_factor": selected["recip_factor"],
                    "recip_ev": math.log2(max(selected["recip_factor"], 1e-9))},
        "combos": combos,
        "selected": selected,
        "brackets": brackets,
        "warnings": warnings,
        "geometry": {
            "max_blur": geo["max_blur"],
            "f_number_eff": geo["f_number_eff"],
            "wedges": geo["wedges"],
            "subject_plane": geo["subject_plane"],
            "views_side": geo["views"]["side"],
            "points": [{"name": p["name"], "kind": p["kind"], "world": p["world"],
                        "blur": p["blur"], "s": p.get("s"), "t": p.get("t")}
                       for p in geo["points"]],
            "ground_glass": geo["ground_glass"],
        },
    }


def solve_aperture(setup, factor_bf, pts, t_lock):
    """锁定快门 t_lock, 二分反算所需光圈(使倒易律修正后时间恰为 t_lock)。"""
    def actual(N):
        t_t = meter_time(setup, N) * factor_bf
        return reciprocity_solve(t_t, pts)[0]
    lo, hi = 1.0, 128.0
    if actual(hi) < t_lock:
        return hi
    if actual(lo) > t_lock:
        return lo
    for _ in range(48):
        mid = math.sqrt(lo * hi)
        if actual(mid) < t_lock:
            lo = mid
        else:
            hi = mid
    return math.sqrt(lo * hi)


# ---------------- 自检 ----------------
if __name__ == "__main__":
    st = cg.default_state()
    cg.autofocus(st)
    st = freeze_state(st)
    setup = default_setup(st)
    # EV15 ISO100 f/16 -> 1/125 (t=256/32768≈1/128)
    setup["meter"] = {"mode": "ev", "value": 15.0}
    setup["selection"]["aperture"] = 16.0
    t = meter_time(setup, 16.0)
    assert abs(t - 1 / 128) < 1e-4, t
    # 皮腔补偿: 默认态伸长~165mm/150mm -> fb≈1.21
    fb, ext, mag = bellows_factor(st)
    assert abs(fb - (ext / 150.0) ** 2) < 1e-9
    # 倒易律: 无修正时 t_actual == t_target
    out = calc(st, setup)
    assert abs(out["selected"]["t_actual"] - out["selected"]["t_target"]) < 1e-9
    # 强修正曲线: t_actual > t_target 且迭代收敛
    setup["reciprocity"] = {"preset": "fp4",
                            "points": [list(p) for p in RECIP_PRESETS["fp4"]["points"]]}
    setup["meter"] = {"mode": "ev", "value": 4.0}   # 暗光, 长曝
    out2 = calc(st, setup)
    sel = out2["selected"]
    assert sel["t_actual"] > sel["t_target"]
    print("fp4 长曝: t_target=%.2fs -> t_actual=%.2fs (x%.2f, %d 次迭代)"
          % (sel["t_target"], sel["t_actual"], sel["recip_factor"],
             sel["chain"]["recip_iter"]))
    # 锁定快门反算光圈: EV15 ISO100 1/125 -> f/16 附近(含皮腔补偿则更大)
    setup["meter"] = {"mode": "ev", "value": 15.0}
    setup["reciprocity"] = {"preset": "none",
                            "points": [list(p) for p in RECIP_PRESETS["none"]["points"]]}
    setup["lock"] = {"shutter": True, "aperture": False}
    setup["selection"]["shutter"] = 1 / 125
    out3 = calc(st, setup)
    N_ex = out3["selected"]["aperture_exact"]
    print("锁定 1/125s: 精确光圈 f/%.2f (皮腔补偿需开光圈, 应小于 16)" % N_ex)
    assert 11.0 < N_ex < 16.0
    print("曝光内核自检通过。")
