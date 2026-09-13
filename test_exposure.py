# -*- coding: utf-8 -*-
"""曝光测算内核与 API 状态机校验。"""
import math
import os

import camera_geometry as cg
import exposure as ex


def fresh_state():
    st = cg.default_state()
    cg.autofocus(st)
    return ex.freeze_state(st)


def approx(a, b, tol=1e-6):
    return abs(a - b) <= tol


ST = fresh_state()

# 1) 测光换算: EV15 / ISO100 / f16 -> 1/128s; ISO400 -> 1/512s
setup = ex.default_setup(ST)
setup["meter"] = {"mode": "ev", "value": 15.0}
assert approx(ex.meter_time(setup, 16.0), 1 / 128, 1e-5)
setup["iso"] = 400.0
assert approx(ex.meter_time(setup, 16.0), 1 / 512, 1e-5)
# lux 模式: E=250 lux, ISO100, f/1 -> t = C/E/S = 0.01s
setup["meter"] = {"mode": "lux", "value": 250.0}
setup["iso"] = 100.0
assert approx(ex.meter_time(setup, 1.0), 0.01, 1e-9)
print("1 测光换算 OK")

# 2) 皮腔补偿 = (伸长/焦距)^2 = (1+m)^2
fb, ext, mag = ex.bellows_factor(ST)
assert approx(fb, (ext / 150.0) ** 2)
assert approx(mag, ext / 150.0 - 1.0)
assert fb > 1.0  # 默认态近摄, 必有补偿
print("2 皮腔补偿: 伸长 %.1fmm, 放大率 %.3f, 倍率 %.3f OK" % (ext, mag, fb))

# 3) 滤镜倍率叠加: t_target = t_meter * fb * ff
setup = ex.default_setup(ST)
setup["meter"] = {"mode": "ev", "value": 12.0}
setup["filter_factor"] = 2.0
out = ex.calc(ST, setup)
sel = out["selected"]
N = sel["aperture"]
assert approx(sel["t_target"], ex.meter_time(setup, N) * fb * 2.0, 1e-9)
print("3 滤镜叠加 OK")

# 4) 倒易律: 无修正恒等; 强修正收敛且变长; 超范围标记
setup["reciprocity"] = {"preset": "none",
                        "points": [list(p) for p in ex.RECIP_PRESETS["none"]["points"]]}
out = ex.calc(ST, setup)
assert approx(out["selected"]["t_actual"], out["selected"]["t_target"], 1e-9)
setup["meter"] = {"mode": "ev", "value": 2.0}   # 暗光长曝
setup["reciprocity"] = {"preset": "fp4",
                        "points": [list(p) for p in ex.RECIP_PRESETS["fp4"]["points"]]}
out = ex.calc(ST, setup)
sel = out["selected"]
assert sel["t_actual"] > sel["t_target"] * 1.5
# 手动验证不动点: t_actual = t_target * factor(t_actual)
k, _ = ex.factor_at(sel["t_actual"], setup["reciprocity"]["points"])
assert approx(sel["t_actual"], sel["t_target"] * k, 1e-3)
# 超出曲线范围(曲线最大 1000s, 强制更长)
setup["meter"] = {"mode": "ev", "value": -4.0}
out = ex.calc(ST, setup)
assert any(w["code"] == "reciprocity" and w["param"] == "reciprocity"
           for w in out["warnings"]), out["warnings"]
print("4 倒易律迭代/范围 OK (fp4: x%.2f)" % sel["recip_factor"])

# 5) 等效组合: 相邻整档光圈时间比为 2; 每行都有快门与模糊圆
setup = ex.default_setup(ST)
setup["meter"] = {"mode": "ev", "value": 10.0}
setup["f_step"] = 1.0
out = ex.calc(ST, setup)
combos = out["combos"]
assert len(combos) >= 5
grid = ex.aperture_grid(setup)          # 纯网格(不含冻结光圈插入行)
assert grid[-1] == setup["aperture_max"]
for g1, g2 in zip(grid, grid[1:]):
    if g2 == setup["aperture_max"] and g2 / g1 < math.sqrt(2):
        continue                        # 末尾 a_max 截断行
    assert approx(g2 / g1, math.sqrt(2), 1e-6)   # 1EV 步进: 光圈比 √2
by_ap = {round(c["aperture"], 2): c for c in combos}
for g1, g2 in zip(grid, grid[1:]):
    if g2 == setup["aperture_max"] and g2 / g1 < math.sqrt(2):
        continue
    c1, c2 = by_ap[round(g1, 2)], by_ap[round(g2, 2)]
    assert approx(c2["t_meter"] / c1["t_meter"], 2.0, 1e-6)
assert all("shutter" in c and "max_blur" in c for c in combos)
assert any(c["is_frozen"] for c in combos)       # 冻结光圈行在列
print("5 等效组合 OK (%d 行)" % len(combos))

# 6) 锁定快门反算光圈: 结果应使实际时间恰为锁定值
setup = ex.default_setup(ST)
setup["meter"] = {"mode": "ev", "value": 13.0}
setup["lock"] = {"shutter": True, "aperture": False}
setup["selection"]["shutter"] = 0.25
out = ex.calc(ST, setup)
sel = out["selected"]
assert sel["mode"] == "lock_shutter"
N_ex = sel["aperture_exact"]
t_check = ex.reciprocity_solve(
    ex.meter_time(setup, N_ex) * out["factors"]["bellows"] * 1.0,
    setup["reciprocity"]["points"])[0]
assert approx(t_check, 0.25, 1e-4)
print("6 锁定快门反算光圈 f/%.2f OK" % N_ex)

# 7) 手动组合(锁光圈+指定快门): 报告 EV 偏差
setup["lock"] = {"shutter": False, "aperture": True}
setup["selection"]["aperture"] = 22.0
setup["selection"]["shutter"] = 1.0     # 故意偏离所需时间
out = ex.calc(ST, setup)
sel = out["selected"]
assert sel["mode"] == "manual"
assert approx(sel["ev_err"], math.log2(1.0 / sel["t_actual"]), 1e-9)
assert any(w["code"] == "ev_mismatch" for w in out["warnings"])
print("7 手动组合偏差 %+.2f EV OK" % sel["ev_err"])

# 8) 景深点越界: 大光圈下对焦点模糊圆超 CoC, 警告含对焦点名
setup = ex.default_setup(ST)
setup["meter"] = {"mode": "ev", "value": 10.0}
setup["selection"]["aperture"] = 5.6    # 开到最大
out = ex.calc(ST, setup)
dof = [w for w in out["warnings"] if w["code"] == "dof"]
assert dof and dof[0]["param"] == "aperture" and dof[0]["point"], out["warnings"]
names = [p["name"] for p in ST["points"]]
assert dof[0]["point"] in names
print("8 景深越界定位: 对焦点「%s」OK" % dof[0]["point"])

# 9) 快门范围 / 最长曝光
setup = ex.default_setup(ST)
setup["meter"] = {"mode": "ev", "value": 20.0}   # 极亮, 超最快快门
out = ex.calc(ST, setup)
assert any(w["code"] == "shutter_range" and w["param"] == "shutter"
           for w in out["warnings"])
setup["meter"] = {"mode": "ev", "value": 5.0}
setup["max_exposure"] = 4.0
out = ex.calc(ST, setup)
assert any(w["code"] == "max_exposure" for w in out["warnings"])
print("9 快门范围/最长曝光 OK")

# 10) 包围: 级数1 级差1 -> 3 张, 无倒易律时目标时间比 1:2:4
setup = ex.default_setup(ST)
setup["meter"] = {"mode": "ev", "value": 10.0}
setup["bracket"] = {"levels": 1, "step": 1.0}
out = ex.calc(ST, setup)
br = out["brackets"]
assert len(br) == 3 and br[0]["label"] == "-1" and br[2]["label"] == "+1"
assert approx(br[1]["t_target"] / br[0]["t_target"], 2.0, 1e-9)
assert approx(br[2]["t_target"] / br[0]["t_target"], 4.0, 1e-9)
print("10 包围序列 OK")

# 11) 几何联动: 选定光圈下返回楔形/毛玻璃/对焦点
assert out["geometry"]["views_side"]["win"]
assert out["geometry"]["ground_glass"]["film_w"] == ST["camera"]["film_w"]
assert any(p["blur"] is not None for p in out["geometry"]["points"])
print("11 几何联动 OK")

# 11b) 锁定互斥: 同时提交双锁, 清洗后快门锁定生效、光圈锁定被清除
setup = ex.default_setup(ST)
setup["lock"] = {"shutter": True, "aperture": True}
setup["selection"]["shutter"] = 0.5
cleaned = ex.clean_setup(setup, ST)
assert cleaned["lock"]["shutter"] and not cleaned["lock"]["aperture"]
out = ex.calc(ST, setup)
assert out["selected"]["mode"] == "lock_shutter"
assert not out["setup"]["lock"]["aperture"]
# 单锁光圈不受影响
setup["lock"] = {"shutter": False, "aperture": True}
cleaned = ex.clean_setup(setup, ST)
assert cleaned["lock"]["aperture"] and not cleaned["lock"]["shutter"]
out = ex.calc(ST, setup)
assert out["selected"]["mode"] == "manual"
print("11b 锁定互斥 OK")

# ---------------- API 状态机 ----------------
import app as web

web.DB_PATH = "/tmp/test_exposure_api.db"
if os.path.exists(web.DB_PATH):
    os.remove(web.DB_PATH)
web.init_db()
client = web.app.test_client()

# 从当前状态建单(草稿)
r = client.post("/api/exposure/sheets", json={
    "name": "测试单A", "state": cg.default_state()}).get_json()
sid = r["id"]
one = client.get(f"/api/exposure/sheets/{sid}").get_json()
assert one["status"] == "draft" and one["result"]["selected"]
assert one["state"]["pose"]["focus_mode"] == "manual"     # 已冻结机位
# 草稿可改
r = client.put(f"/api/exposure/sheets/{sid}",
               json={"setup": {"iso": 200}}).get_json()
assert r.get("ok")
one = client.get(f"/api/exposure/sheets/{sid}").get_json()
assert one["setup"]["iso"] == 200
# 确认 -> 冻结
r = client.post(f"/api/exposure/sheets/{sid}/confirm", json={}).get_json()
assert r["status"] == "confirmed"
one = client.get(f"/api/exposure/sheets/{sid}").get_json()
assert one["result"]["selected"]["aperture"]
# 已确认只读
r = client.put(f"/api/exposure/sheets/{sid}", json={"setup": {"iso": 400}})
assert r.status_code == 409
# 拍摄 -> 只读
r = client.post(f"/api/exposure/sheets/{sid}/shoot", json={}).get_json()
assert r["status"] == "shot"
r = client.put(f"/api/exposure/sheets/{sid}", json={"setup": {"iso": 400}})
assert r.status_code == 409
# 复制 -> 新草稿可改
r = client.post(f"/api/exposure/sheets/{sid}/duplicate", json={}).get_json()
sid2 = r["id"]
two = client.get(f"/api/exposure/sheets/{sid2}").get_json()
assert two["status"] == "draft" and "副本" in two["name"]
r = client.put(f"/api/exposure/sheets/{sid2}",
               json={"setup": {"iso": 400}}).get_json()
assert r.get("ok")
# 从已保存方案建单
r = client.post("/api/plans", json={"name": "方案X", "state": cg.default_state()}).get_json()
pid = r["id"]
r = client.post("/api/exposure/sheets", json={"name": "测试单B", "plan_id": pid}).get_json()
sid3 = r["id"]
three = client.get(f"/api/exposure/sheets/{sid3}").get_json()
assert three["plan_id"] == pid
# 列表与删除
lst = client.get("/api/exposure/sheets").get_json()
assert len(lst) == 3 and all("status_label" in s for s in lst)
for i in (sid, sid2, sid3):
    client.delete(f"/api/exposure/sheets/{i}")
assert client.get("/api/exposure/sheets").get_json() == []
os.remove(web.DB_PATH)
print("12 API 状态机(草稿->已确认->已拍摄->复制) OK")

print("ALL EXPOSURE TESTS PASSED")
