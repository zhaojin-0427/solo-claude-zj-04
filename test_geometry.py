# -*- coding: utf-8 -*-
import math
import camera_geometry as cg

def approx(a, b, tol=1.0):
    return abs(a - b) <= tol

# 1) 无倾角: 150mm, 物距 1000mm(镜头到物平面), 像距应 = 176.47
st = cg.default_state()
st["pose"]["front"]["tilt"] = 0
st["points"] = [{"name": "A", "x": 1000.0, "y": 0, "z": 0, "kind": "focus"}]
cg.autofocus(st)
r = cg.compute(st)
print("1 untilted: front.x=%.2f (期望~176.47), extension=%.2f, blur=%.5f"
      % (st["pose"]["front"]["x"], r["extension"], r["max_blur"]))
assert approx(st["pose"]["front"]["x"], 176.47, 0.5), st["pose"]["front"]["x"]
assert r["max_blur"] < 0.001, r["max_blur"]

# 2) 倾斜: 后组前倾 θ, 主体平面应满足铰链规则。f=150, h=1000, θ=5°
f = 150.0
theta = math.radians(5.0)
J = f / math.sin(theta)   # 铰链距离(光轴)
n_t = [-math.cos(theta), 0, math.sin(theta)]  # 过 (h,0,0) 与铰链点的平面
# 平面过铰链点 (J,0,0)? 铰链在 qx=0 且沿 u 偏移 f*b_t/beta = f/sinθ 处
# 世界铰链点: 后组/镜头共面, 取侧视: 镜头 F=(e,0,0), 铰链 z=-?
# 直接构造: 平面经点 (h,0,0), 法线 n_t
d_t = cg.vdot(n_t, [1000, 0, 0])
cam = st["camera"]
pose2 = cg.construct_pose(cam, n_t, d_t, [1, 0, 0], st["pose"], {},
                          comp_points=[{"x": 1000, "y": 0, "z": 0}])
print("2 tilt construct rear tilt=%.3f (期望~5), front x=%.2f"
      % (pose2["rear"]["tilt"], pose2["front"]["x"]))
st2 = cg.json_like(st, pose2)
r2 = cg.compute(st2)
print("  max blur=%.5f hinge=%s" % (r2["max_blur"], r2["hinge"]))
# 点 (1000,0,0) 必须在焦平面上, blur≈0
assert r2["max_blur"] < 0.002, r2["max_blur"]
# 铰链点 x≈f/sinθ≈1720.9? 镜头在 e≈?
# 检查平面内另一远点也清晰
st2["points"].append({"name": "far", "x": 2000, "y": 0,
                      "z": math.tan(theta) * (2000 - 1000), "kind": "focus"})
r2b = cg.compute(st2)
print("  plane far point blur=%.5f" % r2b["max_blur"])
assert r2b["max_blur"] < 0.002, r2b["max_blur"]

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
assert r4["max_blur"] < 0.005, r4["max_blur"]

print("ALL GEOMETRY TESTS PASSED")
