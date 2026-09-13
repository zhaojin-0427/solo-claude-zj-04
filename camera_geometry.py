# -*- coding: utf-8 -*-
"""
大画幅移轴相机几何内核
坐标系(单位 mm): x 指向被摄体, y 指向相机右侧(画面左侧), z 向上。
约定:
  后组(片盒)位姿 p_R, 框架 (n_R 法线, u_R 向上, r_R 向右)
  前组(镜头)位姿 p_F, 框架 (n_L, u_L, r_L)
框架由两次定轴旋转生成: 先绕世界 y 轴 tilt(俯仰), 再绕世界 z 轴 swing(摇摆):
  n = (cos t cos s, cos t sin s, -sin t)
  u = (sin t cos s, sin t sin s,  cos t)
  r = (-sin s, cos s, 0)
正 tilt = 前倾(法线朝下), 正 swing = 向 +y。
薄透镜 + 主光线 homography: X' = f/(f-d) (X - F), d=(X-F)·n_L
"""
import math

# ---------------- 基础向量 ----------------
def vadd(a, b): return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
def vsub(a, b): return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
def vscl(a, k): return [a[0] * k, a[1] * k, a[2] * k]
def vdot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def vcross(a, b):
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]]
def vnorm(a): return math.sqrt(vdot(a, a))
def vunit(a):
    n = vnorm(a)
    return [a[0] / n, a[1] / n, a[2] / n] if n > 1e-12 else [0.0, 0.0, 0.0]
def D2R(x): return x * math.pi / 180.0
def R2D(x): return x * 180.0 / math.pi
def clamp(x, lo, hi): return max(lo, min(hi, x))


def frame(tilt_deg, swing_deg):
    """返回 (n,u,r) 单位正交组(右手: n=u×r)。"""
    t, s = D2R(tilt_deg), D2R(swing_deg)
    ct, st, cs, ss = math.cos(t), math.sin(t), math.cos(s), math.sin(s)
    n = [ct * cs, ct * ss, -st]
    u = [st * cs, st * ss, ct]
    r = [-ss, cs, 0.0]
    return n, u, r


def frame_to_tilt_swing(n):
    return (R2D(math.asin(clamp(-n[2], -1, 1))),
            R2D(math.atan2(n[1], n[0])))


def build_frame_from_n(n):
    """由法线反推一组近似世界竖直的正交框架 (n,u,r)。"""
    n = vunit(n)
    up = vsub([0, 0, 1], vscl(n, vdot([0, 0, 1], n)))
    if vnorm(up) < 1e-9:
        up = vsub([0, 1, 0], vscl(n, vdot([0, 1, 0], n)))
    u = vunit(up)
    r = vcross(n, u)
    return n, u, r


# ---------------- 默认状态 ----------------
def default_state():
    return {
        "camera": {
            "film_w": 127.0, "film_h": 102.0,      # 4x5 横构图
            "focal": 150.0, "aperture": 22.0,
            "image_circle": 210.0,                 # 无穷远对焦时像场直径
            "coc": 0.10,
            "bellows_min": 60.0, "bellows_max": 450.0,
            "rail_max": 500.0,
            "max_tilt": 15.0, "max_swing": 15.0,
            "max_rise": 40.0, "max_shift": 40.0,
            "min_clearance": 18.0,
        },
        "pose": {
            "rear":  {"x": 0.0, "tilt": 0.0, "swing": 0.0, "rise": 0.0, "shift": 0.0},
            "front": {"x": 156.0, "tilt": 0.0, "swing": 0.0, "rise": 0.0, "shift": 0.0},
            "focus_mode": "auto", "focus_anchor": 0,
        },
        "points": [
            {"name": "近点", "x": 900.0, "y": 0.0, "z": -200.0, "kind": "focus"},
            {"name": "远点", "x": 1600.0, "y": 0.0, "z": 150.0, "kind": "focus"},
        ],
        "locks": {},
    }


# ---------------- 位姿拆解 ----------------
def std_pos(std):
    return [std["x"], std.get("shift", 0.0), std.get("rise", 0.0)]


def pose_frames(pose):
    R = frame(pose["rear"]["tilt"], pose["rear"]["swing"])
    L = frame(pose["front"]["tilt"], pose["front"]["swing"])
    return R, L


def conjugate_plane_rear(p_R, R, p_F, L, f):
    """
    返回后组坐标系下共轭主体平面 (A,B,C,D): A qx+B qy+C qz = D
    以及 c_R(后组原点在镜头系中的坐标, 后组坐标), e(光轴方向伸长)。
    """
    n_R, u_R, r_R = R
    n_L = L[0]
    # 后组坐标基下表达镜头法线
    b = [vdot(n_L, n_R), vdot(n_L, u_R), vdot(n_L, r_R)]
    c = [vdot(vsub(p_R, p_F), n_R),
         vdot(vsub(p_R, p_F), u_R),
         vdot(vsub(p_R, p_F), r_R)]
    cx = c[0]
    # 后组平面 (q-c)·ex=0 经 homography X'=F-f/(d-f)(X-F) 的共轭:
    # (f+cx bx) qx + cx by qy + cx bz qz = f cx
    A = f + cx * b[0]
    B = cx * b[1]
    C = cx * b[2]
    D = f * cx
    e = -vdot(vsub(p_R, p_F), n_L)   # 沿镜头光轴的伸长
    return (A, B, C, D), b, c, e


def world_plane(abcd, R, p_F):
    """后组坐标平面 -> 世界平面 (n,d): n·X=d。"""
    n_R, u_R, r_R = R
    A, B, C, D = abcd
    n = vadd(vadd(vscl(n_R, A), vscl(u_R, B)), vscl(r_R, C))
    nn = vnorm(n)
    n = vscl(n, 1.0 / nn)
    d = (vdot(n, p_F) + D / nn)
    return n, d


# ---------------- 自动对焦: 解前组轨道位置使对焦点落上焦平面 ----------------
def autofocus(state):
    cam, pose = state["camera"], state["pose"]
    f = cam["focal"]
    pts = [p for p in state["points"] if p.get("kind") == "focus"]
    if not pts or pose.get("focus_mode", "auto") != "auto":
        return
    idx = min(pose.get("focus_anchor", 0), len(pts) - 1)
    Q = [pts[idx]["x"], pts[idx]["y"], pts[idx]["z"]]

    R, L = pose_frames(pose)
    n_R, u_R, r_R = R
    n_L = L[0]
    rear = pose["rear"]
    fr = pose["front"]
    p_R = std_pos(rear)
    # 以前组 x=p_R.x 为基准(Δ=0)
    p_F0 = [p_R[0], fr.get("shift", 0.0), fr.get("rise", 0.0)]
    c0 = [vdot(vsub(p_R, p_F0), n_R),
          vdot(vsub(p_R, p_F0), u_R),
          vdot(vsub(p_R, p_F0), r_R)]
    q0 = [vdot(vsub(Q, p_F0), n_R),
          vdot(vsub(Q, p_F0), u_R),
          vdot(vsub(Q, p_F0), r_R)]
    b = [vdot(n_L, n_R), vdot(n_L, u_R), vdot(n_L, r_R)]
    # 共轭平面: (f+cx b0)qx + cx B = f cx, cx=c0x-Δ, qx=q0x-Δ
    B = b[1] * q0[1] + b[2] * q0[2]
    # b0 Δ² - Δ(f+c0x b0+b0 q0x+B) + f q0x+c0x(B-f)=0
    aa = b[0]
    bb = -(f + c0[0] * b[0] + b[0] * q0[0] + B)
    cc = f * q0[0] + c0[0] * (B - f)
    disc = bb * bb - 4 * aa * cc
    roots = []
    if disc >= 0:
        s = math.sqrt(disc)
        for Δ in ((-bb + s) / (2 * aa), (-bb - s) / (2 * aa)):
            p_F = [p_R[0] + Δ, p_F0[1], p_F0[2]]
            ξ = vdot(vsub(Q, p_F), n_L)
            e = -vdot(vsub(p_R, p_F), n_L)
            if ξ > f * 0.25 and e > f * 0.3:
                roots.append(Δ)
    if roots:
        # 选离当前前组位置最近的物理解, 保证拖动连续
        cur = fr["x"] - p_R[0]
        Δ = min(roots, key=lambda d: abs(d - cur))
    else:
        Δ = f  # 兜底
    fr["x"] = round(p_R[0] + Δ, 4)


# ---------------- 像点 / 虚焦圆 ----------------
def image_point(Q, p_F, n_L, f):
    """薄透镜 homography: X' = F - f/(d-f)(Q-F), d=(Q-F)·n_L。"""
    d = vdot(vsub(Q, p_F), n_L)
    if abs(d - f) < 1e-9:
        return None
    lam = -f / (d - f)
    return vadd(p_F, vscl(vsub(Q, p_F), lam))


def blur_diameter(Q, p_R, R, p_F, L, f, aperture_diam, samples=16):
    """
    以真实像点为锥顶、光圈圆为截面的光锥与片平面求交,
    数值采样取最大跨度(虚焦圆长径, mm)。
    """
    n_L, u_L, r_L = L
    Xp = image_point(Q, p_F, n_L, f)
    if Xp is None:
        return None
    n_R = R[0]
    hits = []
    for i in range(samples):
        a = 2 * math.pi * i / samples
        aper = vadd(vscl(u_L, math.cos(a) * aperture_diam / 2),
                    vscl(r_L, math.sin(a) * aperture_diam / 2))
        w = vsub(aper, vsub(Xp, p_F))  # 生成线方向(世界, 起点 Xp)
        denom = vdot(w, n_R)
        if abs(denom) < 1e-12:
            continue
        t = vdot(vsub(p_R, Xp), n_R) / denom
        hits.append(vadd(Xp, vscl(w, t)))
    if len(hits) < 2:
        return None
    cx = sum(h[0] for h in hits) / len(hits)
    cy = sum(h[1] for h in hits) / len(hits)
    cz = sum(h[2] for h in hits) / len(hits)
    return max(vnorm(vsub(h, [cx, cy, cz])) for h in hits) * 2.0


# ---------------- 碰撞: 板件网格最小间距 ----------------
def board_grid(P, u, r, hw, hh, n=5):
    pts = []
    for i in range(n):
        for j in range(n):
            a = -hw + 2 * hw * i / (n - 1)
            b = -hh + 2 * hh * j / (n - 1)
            pts.append(vadd(vadd(P, vscl(r, a)), vscl(u, b)))
    return pts


# ---------------- 主计算 ----------------
def compute(state, do_blur=True):
    cam = state["camera"]
    pose = state["pose"]
    f = cam["focal"]
    N = cam["aperture"]
    w, h = cam["film_w"], cam["film_h"]
    ic_r0 = cam["image_circle"] / 2.0
    coc = cam["coc"]
    aperture_diam = f / N

    R, L = pose_frames(pose)
    n_R, u_R, r_R = R
    n_L, u_L, r_L = L
    p_R = std_pos(pose["rear"])
    p_F = std_pos(pose["front"])

    abcd, b, c_R, e_opt = conjugate_plane_rear(p_R, R, p_F, L, f)
    n_s, d_s = world_plane(abcd, R, p_F)
    # 法线朝向相机(镜头一侧为正)
    if vdot(n_s, vsub(p_F, vadd(p_F, vscl(n_s, 100)))) > 0:
        pass
    if vdot(n_s, vsub(p_F, [0, 0, 0])) == 0:
        pass
    # 让 n_s 指向相机: 镜头到焦平面方向约 -n_s
    # 直接统一: 若对焦点在法线正侧则翻转
    fpts = [p for p in state["points"] if p.get("kind") == "focus"]
    if fpts:
        Q0 = [fpts[0]["x"], fpts[0]["y"], fpts[0]["z"]]
        if vdot(n_s, vsub(Q0, p_F)) > 0:
            n_s, d_s = vscl(n_s, -1), -d_s

    # 铰链线: qx=0 且 b·q=f (后组坐标)
    hinge = None
    beta2 = b[1] ** 2 + b[2] ** 2
    if beta2 > 1e-12:
        qh = [0.0, f * b[1] / beta2, f * b[2] / beta2]
        hinge = vadd(p_F, vadd(vadd(vscl(n_R, qh[0]), vscl(u_R, qh[1])),
                               vscl(r_R, qh[2])))
    # Scheimpflug 线取一个代表点: 后组平面与镜头平面交线上、靠近光轴的点
    # 解 c 平面内 b·(q-c)=0 最近点
    scheim = None
    if beta2 > 1e-12 or abs(b[0]) < 1 - 1e-9:
        # q = c + t*(b - bx*ex); 起点 c(c 在后组平面), 方向 ⊥ n_R
        dirv = [0.0, b[1], b[2]]
        t = -vdot(c_R, b) / max(beta2, 1e-15)
        qs = vadd(c_R, vscl(dirv, t))
        scheim = vadd(p_F, vadd(vadd(vscl(n_R, qs[0]), vscl(u_R, qs[1])),
                                vscl(r_R, qs[2])))

    # 景深楔形: 片平面沿法线平移 δ = coc * N_e
    bellows = vnorm(vsub(p_F, p_R))
    N_e = e_opt / aperture_diam if aperture_diam > 0 else N
    delta = coc * N_e
    wedges = []
    for sgn, label in ((-1, "near"), (1, "far")):
        # 片平面 qx = cx + sgn*δ  -> 等价修改 c: c' = c + sgn δ ex
        cxp = c_R[0] + sgn * delta
        A2 = f + cxp * b[0]
        B2 = cxp * b[1]
        C2 = cxp * b[2]
        D2 = f * cxp
        if abs(A2) > 1e-9:
            n2, d2 = world_plane((A2, B2, C2, D2), R, p_F)
            if fpts:
                if vdot(n2, vsub([fpts[0]["x"], fpts[0]["y"], fpts[0]["z"]], p_F)) > 0:
                    n2, d2 = vscl(n2, -1), -d2
            # 光轴上截距(前向), 用于区分近/远
            if abs(vdot(n2, n_L)) > 1e-9:
                ξ2 = (d2 - vdot(n2, p_F)) / vdot(n2, n_L)
            else:
                ξ2 = 1e9
            wedges.append({"label": label, "n": n2, "d": d2, "axis_dist": ξ2})
    wedges.sort(key=lambda w_: -w_["axis_dist"])  # 截距大=近

    # 片幅角点
    corners = []
    for sx in (-1, 1):
        for sz in (-1, 1):
            P = vadd(vadd(p_R, vscl(r_R, sx * w / 2)), vscl(u_R, sz * h / 2))
            corners.append(P)

    # 像场遮角: 角点到镜头光轴的垂直距离 vs 可用像场
    ic_r = ic_r0 * max(e_opt, 1e-6) / f
    ic_margins = []
    corner_info = []
    for P in corners:
        X = vsub(P, p_F)
        perp = vsub(X, vscl(n_L, vdot(X, n_L)))
        dist = vnorm(perp)
        m = ic_r - dist
        ic_margins.append(m)
        corner_info.append({"p": P, "dist": dist, "margin": m, "ok": m >= 0})

    # 主体点: 像位置、片上坐标、虚焦、构图
    points_out = []
    max_blur = 0.0
    for p in state["points"]:
        Q = [p["x"], p["y"], p["z"]]
        Xp = image_point(Q, p_F, n_L, f)
        rec = {"name": p.get("name", ""), "kind": p.get("kind", "focus"),
               "world": Q, "image": Xp}
        if Xp is not None:
            rec["s"] = vdot(vsub(Xp, p_R), r_R)
            rec["t"] = vdot(vsub(Xp, p_R), u_R)
            rec["comp_ok"] = abs(rec["s"]) <= w / 2 and abs(rec["t"]) <= h / 2
            rec["comp_margin"] = min(w / 2 - abs(rec["s"]), h / 2 - abs(rec["t"]))
        blur = None
        if do_blur:
            blur = blur_diameter(Q, p_R, R, p_F, L, f, aperture_diam)
        rec["blur"] = blur
        if blur is not None and p.get("kind") == "focus":
            max_blur = max(max_blur, blur)
        # 到焦平面的物方距离(mm)
        rec["plane_dist"] = abs(vdot(n_s, Q) - d_s)
        points_out.append(rec)

    # 机械检查
    warnings = []
    def warn(code, level, part, msg, detail=None):
        warnings.append({"code": code, "level": level, "part": part,
                         "msg": msg, "detail": detail})

    hw = cam["max_shift"] + w / 2 + 15
    hh = cam["max_rise"] + h / 2 + 15
    gA = board_grid(p_R, u_R, r_R, hw, hh)
    gB = board_grid(p_F, u_L, r_L, hw, hh)
    min_clear = min(vnorm(vsub(a, b_)) for a in gA for b_ in gB)
    if min_clear < cam["min_clearance"]:
        warn("collision", "critical", "standards",
             "前后组疑似碰撞/干涉，最小间距 %.1f mm（限值 %.0f）"
             % (min_clear, cam["min_clearance"]),
             {"clearance": min_clear})

    rail_sep = p_F[0] - p_R[0]
    if e_opt < cam["bellows_min"]:
        warn("bellows_min", "critical", "bellows",
             "皮腔压缩到 %.1f mm，低于下限 %.0f mm" % (e_opt, cam["bellows_min"]),
             {"value": e_opt})
    if e_opt > cam["bellows_max"] or bellows > cam["bellows_max"]:
        warn("bellows_max", "critical", "bellows",
             "皮腔拉伸 %.1f mm（板距 %.1f），超过上限 %.0f mm"
             % (e_opt, bellows, cam["bellows_max"]),
             {"value": e_opt, "bellows": bellows})
    if p_F[0] > cam["rail_max"]:
        warn("rail", "critical", "front_x",
             "前组超出轨道行程 %.0f mm（当前 %.1f）" % (cam["rail_max"], p_F[0]),
             {"value": p_F[0]})
    if p_R[0] < 0 or p_F[0] < 0 or p_R[0] > cam["rail_max"]:
        warn("rail_rear", "critical", "rear_x",
             "后组超出轨道行程范围", {"value": p_R[0]})

    for nm, std, pf in (("rear", pose["rear"], p_R), ("front", pose["front"], p_F)):
        if abs(std["tilt"]) > cam["max_tilt"] + 1e-6:
            warn("tilt_limit", "warn", nm + "_tilt",
                 "%s俯仰 %.2f° 超过限位 %.0f°"
                 % ("后组" if nm == "rear" else "前组", std["tilt"], cam["max_tilt"]),
                 {"value": std["tilt"]})
        if abs(std["swing"]) > cam["max_swing"] + 1e-6:
            warn("swing_limit", "warn", nm + "_swing",
                 "%s摇摆 %.2f° 超过限位 %.0f°"
                 % ("后组" if nm == "rear" else "前组", std["swing"], cam["max_swing"]),
                 {"value": std["swing"]})
        if abs(std["rise"]) > cam["max_rise"] + 1e-6:
            warn("rise_limit", "warn", nm + "_rise",
                 "%s升降 %.1f mm 超过限位 %.0f"
                 % ("后组" if nm == "rear" else "前组", std["rise"], cam["max_rise"]),
                 {"value": std["rise"]})
        if abs(std["shift"]) > cam["max_shift"] + 1e-6:
            warn("shift_limit", "warn", nm + "_shift",
                 "%s平移 %.1f mm 超过限位 %.0f"
                 % ("后组" if nm == "rear" else "前组", std["shift"], cam["max_shift"]),
                 {"value": std["shift"]})

    if min(ic_margins) < 0:
        bad = [i for i, m in enumerate(ic_margins) if m < 0]
        warn("image_circle", "critical", "image_circle",
             "像场遮角：%d 个片角超出镜头像场（最紧 %.1f mm，可用半径 %.1f）"
             % (len(bad), min(ic_margins), ic_r),
             {"min_margin": min(ic_margins), "radius": ic_r, "corners": bad})

    focus_err_pts = []
    for rec in points_out:
        if rec["kind"] == "focus" and rec["blur"] is not None and rec["blur"] > coc * 1.05:
            focus_err_pts.append(rec)
    if focus_err_pts:
        worst = max(focus_err_pts, key=lambda r: r["blur"])
        warn("focus", "warn", "focus",
             "对焦点虚焦：最大模糊圆 %.3f mm（容许 %.2f），%s 偏离焦平面 %.0f mm"
             % (worst["blur"], coc, worst["name"], worst["plane_dist"]),
             {"max_blur": worst["blur"], "point": worst["name"]})

    comp_bad = [r for r in points_out if r["kind"] == "comp" and not r.get("comp_ok", True)]
    if comp_bad:
        warn("composition", "warn", "composition",
             "构图点越出片幅：%s" % "、".join(r["name"] for r in comp_bad),
             {"points": [r["name"] for r in comp_bad]})

    # 视图几何
    views = build_views(state, p_R, R, p_F, L, n_s, d_s, wedges,
                        hinge, scheim, corners, ic_r, e_opt, f)

    return {
        "subject_plane": {"n": n_s, "d": d_s},
        "wedges": wedges,
        "hinge": hinge, "scheim": scheim,
        "extension": e_opt, "bellows": bellows,
        "aperture_diam": aperture_diam, "f_number_eff": N_e,
        "magnification": e_opt / max(f, 1e-6) - 1.0,
        "points": points_out,
        "corners": corner_info,
        "ic_radius": ic_r,
        "ic_min_margin": min(ic_margins),
        "max_blur": max_blur,
        "min_clearance": min_clear,
        "warnings": warnings,
        "views": views,
    }


# ---------------- 视图(俯视/侧视)线段 ----------------
def plane_view_line(n, d, view, win):
    """求平面与视图平面的交线, 裁剪到窗口。view: 'side' (y=0) / 'top' (z=0)。"""
    if view == "side":
        # n_x x + n_z z = d (y=0)
        a_, b_, c_ = n[0], n[2], d
        x0, x1, y0, y1 = win["xmin"], win["xmax"], win["zmin"], win["zmax"]
    else:
        a_, b_, c_ = n[0], n[1], d
        x0, x1, y0, y1 = win["xmin"], win["xmax"], win["ymin"], win["ymax"]
    pts = []
    if abs(b_) > 1e-12:
        for x in (x0, x1):
            pts.append((x, (c_ - a_ * x) / b_))
    if abs(a_) > 1e-12:
        for y in (y0, y1):
            pts.append(((c_ - b_ * y) / a_, y))
    # 取落在窗口附近的两点
    inside = []
    for (x, y) in pts:
        if x0 - 1e-6 <= x <= x1 + 1e-6 and y0 - 1e-6 <= y <= y1 + 1e-6:
            inside.append((x, y))
    if len(inside) >= 2:
        # 选相距最远的两个
        best = (inside[0], inside[1])
        bd = 0
        for i in range(len(inside)):
            for j in range(i + 1, len(inside)):
                dd = (inside[i][0] - inside[j][0]) ** 2 + (inside[i][1] - inside[j][1]) ** 2
                if dd > bd:
                    bd, best = dd, (inside[i], inside[j])
        p1, p2 = best
    elif len(inside) == 1:
        p1 = p2 = inside[0]
    else:
        return None
    if view == "side":
        return [{"x": p1[0], "z": p1[1]}, {"x": p2[0], "z": p2[1]}]
    return [{"x": p1[0], "y": p1[1]}, {"x": p2[0], "y": p2[1]}]


def proj(p, view):
    return {"x": p[0], "v": p[2] if view == "side" else p[1],
            "z": p[2], "y": p[1]}


def build_views(state, p_R, R, p_F, L, n_s, d_s, wedges, hinge, scheim,
                corners, ic_r, e, f):
    xs = [0, p_R[0], p_F[0]] + [p["x"] for p in state["points"]]
    ys = [p_R[1], p_F[1]] + [p["y"] for p in state["points"]]
    zs = [p_R[2], p_F[2]] + [p["z"] for p in state["points"]]
    pad_x = max(80, (max(xs) - min(xs)) * 0.08)
    side_win = {"xmin": min(xs) - 60, "xmax": max(xs) + pad_x,
                "zmin": min(zs) - 220, "zmax": max(zs) + 220}
    top_win = {"xmin": min(xs) - 60, "xmax": max(xs) + pad_x,
               "ymin": min(ys) - 260, "ymax": max(ys) + 260}

    def std_seg(P, vec, half):
        return [vsub(P, vscl(vec, half)), vadd(P, vscl(vec, half))]

    def pack(p):
        return {"x": p[0], "y": p[1], "z": p[2]}

    views = {}
    cam = state["camera"]
    board_h = cam["film_h"] + 30
    board_w = cam["film_w"] + 30

    # 像场锥: 光轴与两条生成线
    gamma = math.atan2(ic_r, max(e, 1e-6))

    for view, win, vec, half in (
            ("side", side_win, None, board_h / 2),
            ("top", top_win, None, board_w / 2)):
        uaxis = R[1] if view == "side" else R[2]
        laxis = L[1] if view == "side" else L[2]
        # 片板/镜头板
        rear_seg = std_seg(p_R, uaxis, half)
        front_seg = std_seg(p_F, laxis, half)
        bellows_quad = [
            vadd(p_R, vscl(uaxis, half)), vadd(p_F, vscl(laxis, half)),
            vsub(p_F, vscl(laxis, half)), vsub(p_R, vscl(uaxis, half)),
        ]
        # 像场锥生成线
        cone = []
        for sg in (-1, 1):
            vdir = vunit(vadd(vscl(L[0], math.cos(gamma)),
                              vscl(laxis, sg * math.sin(gamma))))
            cone.append([pack(p_F), pack(vadd(p_F, vscl(vdir, 6000)))])

        plane_line = plane_view_line(n_s, d_s, view, win)
        wedge_lines = []
        for w_ in wedges:
            ln = plane_view_line(w_["n"], w_["d"], view, win)
            if ln:
                wedge_lines.append({"label": w_["label"], "line": ln})

        v = {
            "win": win,
            "rear": {"center": pack(p_R),
                     "seg": [pack(rear_seg[0]), pack(rear_seg[1])]},
            "front": {"center": pack(p_F),
                      "seg": [pack(front_seg[0]), pack(front_seg[1])]},
            "bellows": [pack(q) for q in bellows_quad],
            "cone": cone,
            "axis": [pack(p_F), pack(vadd(p_F, vscl(L[0], 6000)))],
            "subject_line": plane_line,
            "wedges": wedge_lines,
            "hinge": pack(hinge) if hinge else None,
            "scheim": pack(scheim) if scheim else None,
            "corners": [pack(c) for c in corners],
            "points": [{"x": p["x"], "y": p["y"], "z": p["z"],
                        "kind": p.get("kind", "focus"), "name": p.get("name", "")}
                       for p in state["points"]],
            "rear_normal": pack(R[0]), "front_normal": pack(L[0]),
        }
        views[view] = v
    return views


# ---------------- 平面拟合(>=3 点) ----------------
def fit_plane(points):
    c = [sum(p[i] for p in points) / len(points) for i in range(3)]
    cov = [[0.0] * 3 for _ in range(3)]
    for p in points:
        d = vsub(p, c)
        for i in range(3):
            for j in range(3):
                cov[i][j] += d[i] * d[j]
    # Jacobi 求最小特征值对应特征向量
    n = smallest_eigenvector(cov)
    return c, n


def smallest_eigenvector(A):
    a = [row[:] for row in A]
    V = [[1.0 if i == j else 0.0 for j in range(3)] for i in range(3)]
    for _ in range(50):
        off = max(abs(a[0][1]), abs(a[0][2]), abs(a[1][2]))
        if off < 1e-14:
            break
        for p, q in ((0, 1), (0, 2), (1, 2)):
            if abs(a[p][q]) < 1e-16:
                continue
            tau = (a[q][q] - a[p][p]) / (2 * a[p][q])
            t = (1.0 if tau >= 0 else -1.0) / (abs(tau) + math.sqrt(1 + tau * tau))
            c = 1 / math.sqrt(1 + t * t)
            s = t * c
            for k in range(3):
                akp, akq = a[k][p], a[k][q]
                a[k][p] = c * akp - s * akq
                a[k][q] = s * akp + c * akq
            for k in range(3):
                apk, apq = a[p][k], a[q][k]
                a[p][k] = c * apk - s * apq
                a[q][k] = s * apk + c * apq
            for k in range(3):
                vkp, vkq = V[k][p], V[k][q]
                V[k][p] = c * vkp - s * vkq
                V[k][q] = s * vkp + c * vkq
    vals = [a[i][i] for i in range(3)]
    j = min(range(3), key=lambda i: vals[i])
    return [V[i][j] for i in range(3)]


# ---------------- 构造性求解: 给定目标平面与前组姿态, 反求后组/位移 ----------------
def construct_pose(cam, target_n, target_d, n_L, base_pose, locks,
                   comp_points=None):
    """
    给定目标焦平面 m·X=d(m 指向相机一侧, h=d-m·F 为镜头到平面的有符号距离)、
    前组法线 n_L, 反求后组姿态与伸长。
    闭式关系(镜头坐标):
      w = m-(m·n_L)n_L ; sinα=(f/h)|w| ; bx=sqrt(1-sin^2)
      n_R = (n_L-(f/h)w)/bx
      c_x = h / (m_x-(h/f)bx)   (后组原点在镜头坐标沿 n_R 的分量, h>0)
    构图: 片幅横向偏移 c_y,c_z 取主体点像在片上坐标均值。
    """
    f = cam["focal"]
    n_L, u_L, r_L = build_frame_from_n(n_L)
    tF, sF = frame_to_tilt_swing(n_L)
    bf, bs = base_pose["front"], base_pose["rear"]

    Fy = bf["shift"] if locks.get("front_shift") else 0.0
    Fz = bf["rise"] if locks.get("front_rise") else 0.0
    xr = bs["x"] if locks.get("rear_x") else 0.0
    Fx_fixed = bf["x"] if locks.get("front_x") else None
    pts = comp_points or []

    Fx = Fx_fixed if Fx_fixed is not None else (xr + f)
    p_R = None
    for _ in range(40):
        F = [Fx, Fy, Fz]
        h = target_d - vdot(target_n, F)
        if abs(h) < 1e-6:
            return None
        w = vsub(target_n, vscl(n_L, vdot(target_n, n_L)))
        sin_a = (f / h) * math.sqrt(vdot(w, w))
        if sin_a >= 1.0 - 1e-9:
            return None
        bx = math.sqrt(max(0.0, 1 - sin_a * sin_a))
        n_R = vunit(vsub(n_L, vscl(w, f / h / max(bx, 1e-12))))
        _, u_R, r_R = build_frame_from_n(n_R)
        r_R = vcross(n_R, u_R)
        mR = [vdot(target_n, n_R), vdot(target_n, u_R), vdot(target_n, r_R)]

        cy = cz = 0.0
        if pts:
            sy = sz = 0.0
            for p in pts:
                Q = [p["x"], p["y"], p["z"]]
                Xp = image_point(Q, F, n_L, f)
                if Xp is None:
                    continue
                rel = vsub(Xp, F)
                sy += vdot(rel, u_R)
                sz += vdot(rel, r_R)
            cy, cz = sy / len(pts), sz / len(pts)
        cy = clamp(cy, -cam["max_shift"] - 2, cam["max_shift"] + 2)
        cz = clamp(cz, -cam["max_rise"] - 2, cam["max_rise"] + 2)

        den = mR[0] - (h / f) * bx
        if abs(den) < 1e-12:
            return None
        cx = h / den
        p_R = vadd(vadd(vadd(F, vscl(n_R, cx)), vscl(u_R, cy)), vscl(r_R, cz))
        if Fx_fixed is not None:
            if locks.get("rear_x") and abs(p_R[0] - xr) > 2.0:
                return None
            break
        Fx_new = Fx + (xr - p_R[0])
        if abs(Fx_new - Fx) < 1e-7:
            Fx = Fx_new
            break
        Fx = 0.5 * Fx + 0.5 * Fx_new
    if p_R is None:
        return None
    tR, sR = frame_to_tilt_swing(n_R)
    return {
        "rear":  {"x": p_R[0], "tilt": tR, "swing": sR,
                  "rise": p_R[2], "shift": p_R[1]},
        "front": {"x": F[0], "tilt": tF, "swing": sF,
                  "rise": Fz, "shift": Fy},
        "focus_mode": "manual", "focus_anchor": 0,
    }


# ---------------- 搜索 ----------------
def search(state, opts=None):
    opts = opts or {}
    cam = state["camera"]
    pose = state["pose"]
    locks = state.get("locks", {})
    fpts = [p for p in state["points"] if p.get("kind") == "focus"]
    cpts = [p for p in state["points"] if p.get("kind") == "comp"]
    if not fpts:
        return {"error": "请至少添加一个对焦点"}

    step = opts.get("angle_step", 2.0)
    rng = opts.get("angle_range", cam["max_tilt"])
    comp_locked = locks.get("composition", False)

    # 目标平面族
    planes = _candidate_planes(fpts)
    if planes is None:
        return {"error": "对焦点无法确定有效平面"}

    base_pose = pose
    results = []
    seen = set()

    tf_lock = pose["front"]["tilt"] if locks.get("front_tilt") else None
    sf_lock = pose["front"]["swing"] if locks.get("front_swing") else None
    tf_vals = [tf_lock] if tf_lock is not None else [round(-rng + i * step, 3)
                                                     for i in range(int(2 * rng / step) + 1)]
    sf_vals = [sf_lock] if sf_lock is not None else [round(-rng + i * step, 3)
                                                     for i in range(int(2 * rng / step) + 1)]

    for n_t, d_t in planes:
        if vdot(n_t, [-1, 0, 0]) <= 0:
            n_t, d_t = vscl(n_t, -1), -d_t
        for tf in tf_vals:
            for sf in sf_vals:
                n_L = frame(tf, sf)[0]
                cand = construct_pose(cam, n_t, d_t, n_L, base_pose, locks,
                                      comp_points=cpts or fpts)
                if cand is None:
                    continue
                _apply_locks(cand, pose, locks)
                if not _within_limits(cand, cam, locks):
                    continue
                key = _pose_key(cand)
                if key in seen:
                    continue
                seen.add(key)
                st2 = json_like(state, cand)
                res = compute(st2, do_blur=True)
                if res["max_blur"] > cam["coc"] * 1.15:
                    continue
                if comp_locked and any(w["code"] == "composition" for w in res["warnings"]):
                    continue
                if any(w["code"] in ("collision", "bellows_min", "bellows_max",
                                     "rail", "rail_rear", "image_circle")
                       for w in res["warnings"]):
                    # 硬性机械/像场问题: 保留但标注, 默认排序靠后
                    hard = True
                else:
                    hard = False
                cost = movement_cost(pose, cand)
                results.append({
                    "pose": cand,
                    "max_blur": res["max_blur"],
                    "ic_margin": res["ic_min_margin"],
                    "cost": cost,
                    "extension": res["extension"],
                    "hard_warn": hard,
                    "warnings": len(res["warnings"]),
                    "hinge": res["hinge"],
                    "subject_plane": res["subject_plane"],
                    "wedges": res["wedges"],
                    "views": res["views"],
                })
    results.sort(key=lambda r: (round(r["max_blur"], 4), r["hard_warn"], r["warnings"],
                                -round(r["ic_margin"], 2), round(r["cost"], 2)))
    return {"candidates": results[:40]}


def _candidate_planes(fpts):
    pts = [[p["x"], p["y"], p["z"]] for p in fpts]
    if len(pts) >= 3:
        c, n = fit_plane(pts)
        # 检验共线/共面程度
        resid = max(abs(vdot(n, vsub(p, c))) for p in pts)
        if resid < 1e-6:
            return _plane_family_line(pts[:2])
        return [(vunit(n), vdot(n, c))]
    if len(pts) == 2:
        return _plane_family_line(pts)
    # 单点: 过点的平面族, 法线朝相机半球
    out = []
    P = pts[0]
    for t_deg in range(0, 61, 10):
        for s_deg in range(0, 360, 30):
            t, s = D2R(t_deg), D2R(s_deg)
            n = [-math.cos(t), math.cos(t) * math.sin(s), -math.sin(t) * math.cos(s)]
            n = vunit(n)
            out.append((n, vdot(n, P)))
    out.append(([-1.0, 0.0, 0.0], -P[0]))  # 正对零倾角
    return out


def _plane_family_line(pts):
    P1, P2 = pts
    d = vsub(P2, P1)
    dl = vnorm(d)
    if dl < 1e-9:
        P = P1
        return [([-1.0, 0.0, 0.0], -P[0])]
    a = vunit(d)
    # 候选法线: 与线垂直, 绕线旋转; 偏向朝相机
    # 取一个不平行的参考
    ref = [0.0, 0.0, 1.0]
    if abs(vdot(a, ref)) > 0.95:
        ref = [0.0, 1.0, 0.0]
    e1 = vunit(vsub(ref, vscl(a, vdot(ref, a))))
    e2 = vcross(a, e1)
    out = []
    for deg in range(0, 360, 10):
        th = D2R(deg)
        n = vunit(vadd(vscl(e1, math.cos(th)), vscl(e2, math.sin(th))))
        if n[0] > -0.05:   # 法线需大致朝相机
            continue
        out.append((n, vdot(n, P1)))
    return out


def _apply_locks(cand, base, locks):
    for nm in ("rear", "front"):
        for key, lk in (("tilt", nm + "_tilt"), ("swing", nm + "_swing"),
                        ("rise", nm + "_rise"), ("shift", nm + "_shift"),
                        ("x", nm + "_x")):
            if locks.get(lk):
                cand[nm][key] = base[nm][key]


def _within_limits(cand, cam, locks):
    for nm in ("rear", "front"):
        s = cand[nm]
        if abs(s["tilt"]) > cam["max_tilt"] + 1e-6 and not locks.get(nm + "_tilt"):
            return False
        if abs(s["swing"]) > cam["max_swing"] + 1e-6 and not locks.get(nm + "_swing"):
            return False
        if abs(s["rise"]) > cam["max_rise"] + 1e-6 and not locks.get(nm + "_rise"):
            return False
        if abs(s["shift"]) > cam["max_shift"] + 1e-6 and not locks.get(nm + "_shift"):
            return False
        if s["x"] < -1e-6 or s["x"] > cam["rail_max"] + 1e-6:
            return False
    sep = cand["front"]["x"] - cand["rear"]["x"]
    if sep < cam["bellows_min"] * 0.5 or sep > cam["bellows_max"] * 1.2:
        return False
    return True


def movement_cost(base, cand):
    w_angle, w_lin = 1.0, 0.15
    c = 0.0
    for nm in ("rear", "front"):
        c += w_angle * abs(cand[nm]["tilt"] - base[nm]["tilt"])
        c += w_angle * abs(cand[nm]["swing"] - base[nm]["swing"])
        c += w_lin * abs(cand[nm]["rise"] - base[nm]["rise"])
        c += w_lin * abs(cand[nm]["shift"] - base[nm]["shift"])
        c += w_lin * abs(cand[nm]["x"] - base[nm]["x"])
    return c


def _pose_key(cand):
    return tuple(round(cand[nm][k], 2) for nm in ("rear", "front")
                 for k in ("x", "tilt", "swing", "rise", "shift"))


def json_like(state, cand):
    import copy
    st = copy.deepcopy(state)
    st["pose"] = cand
    return st
