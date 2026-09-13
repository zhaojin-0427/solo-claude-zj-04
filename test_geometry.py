# -*- coding: utf-8 -*-
import math
import camera_geometry as cg

def approx(a, b, tol=1.0):
    return abs(a - b) <= tol

# 1) 无倾角: 物点固定 x=1000(后组在 0), 前组前移 Δ 满足 1/(1000-Δ)+1/Δ=1/f
#    近端解 Δ=183.77 (另一根 816.23 为物距 184 的放大态)
st = cg.default_state()
st["pose"]["front"]["tilt"] = 0
st["points"] = [{"name": "A", "x": 1000.0, "y": 0, "z": 0, "kind": "focus"}]
cg.autofocus(st)
r = cg.compute(st)
print("1 untilted: front.x=%.2f (期望~183.77), extension=%.2f, blur=%.5f"
      % (st["pose"]["front"]["x"], r["extension"], r["max_blur"]))
assert approx(st["pose"]["front"]["x"], 183.77, 0.5), st["pose"]["front"]["x"]
assert r["max_blur"] < 0.001, r["max_blur"]

# 2) 倾斜往返: 先由"后组前倾5°+前组位置"算出真实焦平面, 再用 construct 反解
f = 150.0
st_pre = cg.default_state()
st_pre["pose"]["rear"]["tilt"] = 5.0
st_pre["pose"]["front"]["x"] = 180.0
st_pre["points"] = [{"x": 1000, "y": 0, "z": 0, "kind": "focus"}]
r_pre = cg.compute(st_pre)
n_t = r_pre["subject_plane"]["n"]
d_t = r_pre["subject_plane"]["d"]
# 焦平面上两个点(光轴点 + 远点)
x0 = 1000
z0 = (d_t - n_t[0] * x0) / n_t[2]
x1 = 2000
z1 = (d_t - n_t[0] * x1) / n_t[2]
cam = st["camera"]
pose2 = cg.construct_pose(cam, n_t, d_t, [1, 0, 0], st_pre["pose"], {},
                          comp_points=[{"x": x0, "y": 0, "z": z0},
                                       {"x": x1, "y": 0, "z": z1}])
print("2 tilt construct rear tilt=%.3f (期望~5), front x=%.2f"
      % (pose2["rear"]["tilt"], pose2["front"]["x"]))
st2 = cg.json_like(st, pose2)
st2["points"] = [
    {"name": "near", "x": x0, "y": 0, "z": z0, "kind": "focus"},
    {"name": "far", "x": x1, "y": 0, "z": z1, "kind": "focus"},
]
r2 = cg.compute(st2)
print("  max blur=%.5f hinge=%s" % (r2["max_blur"], r2["hinge"]))
assert abs(pose2["rear"]["tilt"] - 5.0) < 0.5, pose2["rear"]["tilt"]
assert r2["max_blur"] < 0.005, r2["max_blur"]

# 3) 搜索: 两点确定一条线 -> 应找到侧倾方案
st3 = cg.default_state()
st3["points"] = [
    {"name": "near", "x": 900, "y": 0, "z": -200, "kind": "focus"},
    {"name": "far", "x": 1600, "y": 0, "z": 150, "kind": "focus"},
]
res3 = cg.search(st3, {"angle_step": 2.0, "angle_range": 15.0})
cs = res3.get("candidates", [])
print("3 search: %d candidates" % len(cs))
if cs:
    b = cs[0]
    print("  best blur=%.4f cost=%.2f rearTilt=%.2f frontTilt=%.2f ext=%.1f icm=%.1f"
          % (b["max_blur"], b["cost"], b["pose"]["rear"]["tilt"],
             b["pose"]["front"]["tilt"], b["extension"], b["ic_margin"]))

# 4) 三点平面拟合 + 构造
st4 = cg.default_state()
P = [[1200, -300, -150], [1500, 200, 50], [1800, 100, 250]]
st4["points"] = [{"x": p[0], "y": p[1], "z": p[2], "kind": "focus"} for p in P]
c4, n4 = cg.fit_plane(P)
d4 = cg.vdot(n4, c4)
pose4 = cg.construct_pose(cam, n4, d4, [1, 0, 0], st4["pose"], {},
                          comp_points=st4["points"])
r4 = cg.compute(cg.json_like(st4, pose4))
print("4 3pt plane: rear tilt=%.2f swing=%.2f blur=%.5f"
      % (pose4["rear"]["tilt"], pose4["rear"]["swing"], r4["max_blur"]))
assert r4["max_blur"] < 0.02, r4["max_blur"]  # 角度网格精度, 远小于 CoC 0.1

# 5) 片平面投影 / 毛玻璃
st5 = cg.default_state()
cg.autofocus(st5)
r5 = cg.compute(st5)
gg5 = r5["ground_glass"]
assert gg5["film_w"] == st5["camera"]["film_w"]
assert gg5["ic_ellipse"] is not None
# 无倾角: 像场圈在片上为圆(两半轴相等)
assert abs(gg5["ic_ellipse"]["rx"] - gg5["ic_ellipse"]["ry"]) < 0.5
# 正对立面上的竖线应平行(汇聚≈0)
v = [s for s in gg5["subjects"] if s["type"] == "vline"][0]
assert v["metrics"].get("convergence", 0) < 0.5, v["metrics"]
# 矩形竖边汇聚必须基于真竖边 A-D / B-C: 无倾角正对时应为 0,
# 不能取横边 A-B / D-C 的夹角(此前会误报 ~6°)
rect0 = [s for s in gg5["subjects"] if s["type"] == "rect"][0]
assert rect0["metrics"].get("v_converge", 0) < 0.05, rect0["metrics"]
# 矩形有 4 条片上折线段(未被虚像剔除)
rect = [s for s in gg5["subjects"] if s["type"] == "rect"][0]
assert len(rect["segs"]) == 4, len(rect["segs"])
# 留边收紧 -> 必留矩形报 margin 违规
st5b = cg.default_state()
st5b["comp"]["keep_margin"] = 40.0
gg5b = cg.compute(st5b)["ground_glass"]
rectb = [s for s in gg5b["subjects"] if s["must_keep"]][0]
assert any(i["code"] == "margin" and i["level"] == "critical" for i in rectb["issues"])

# 横边倾斜指标必须持续返回, 与容差/是否报异常无关: 同一姿态仅改容差
st_t2 = cg.default_state()
st_t2["comp"]["persp_tol"] = 2.0
ht_low = [s for s in cg.compute(st_t2)["ground_glass"]["subjects"]
          if s["type"] == "rect"][0]["metrics"]["h_tilt"]
st5c = cg.default_state()
st5c["comp"]["persp_tol"] = 90.0
gg5c = cg.compute(st5c)["ground_glass"]
rectc = [s for s in gg5c["subjects"] if s["type"] == "rect"][0]
assert "h_tilt" in rectc["metrics"], rectc["metrics"]
assert abs(rectc["metrics"]["h_tilt"] - ht_low) < 1e-9
assert not any(i["code"] == "h_tilt" for i in rectc["issues"])  # 容差内不报异常

# 6) 倾斜后组: 像场圈为椭圆, 竖线出现汇聚
st6 = cg.default_state()
st6["pose"]["rear"]["tilt"] = 6.0
st6["pose"]["focus_mode"] = "manual"
gg6 = cg.compute(st6)["ground_glass"]
el6 = gg6["ic_ellipse"]
assert abs(el6["rx"] - el6["ry"]) > 0.5, (el6["rx"], el6["ry"])

# 7) 搜索新排序: oob -> max_persp -> -crop -> cost
res7 = cg.search(st5, {"angle_step": 5.0})
cs7 = res7["candidates"]
keys = [(c["oob"], round(c["max_persp"], 3), -round(c["crop_margin"], 2),
         round(c["cost"], 2)) for c in cs7]
assert keys == sorted(keys), keys[:5]
assert all("oob" in c and "max_persp" in c and "crop_margin" in c for c in cs7)

print("ALL GEOMETRY TESTS PASSED")
