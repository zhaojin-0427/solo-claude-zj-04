# -*- coding: utf-8 -*-
"""
大画幅移轴对焦工作台 — Flask 入口
本机运行:  python3 app.py  (默认 http://127.0.0.1:5000)
"""
import json
import os
import sqlite3
import time

from flask import Flask, g, jsonify, request, send_from_directory

import camera_geometry as cg

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE, "workbench.db")

app = Flask(__name__, static_folder="static", static_url_path="/static")


# ---------------- 数据库 ----------------
def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            note TEXT DEFAULT '',
            created_at REAL,
            updated_at REAL,
            state_json TEXT NOT NULL,
            result_json TEXT
        )"""
    )
    conn.commit()
    conn.close()


# ---------------- 页面 ----------------
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/default")
def api_default():
    return jsonify(cg.default_state())


def _clean_state(data):
    """补全前端可能缺省的字段。"""
    base = cg.default_state()
    if not isinstance(data, dict):
        return base
    cam = dict(base["camera"])
    cam.update({k: float(v) for k, v in (data.get("camera") or {}).items()
                if k in cam})
    pose = json.loads(json.dumps(base["pose"]))
    for nm in ("rear", "front"):
        src = (data.get("pose") or {}).get(nm) or {}
        for k in pose[nm]:
            if k in src:
                pose[nm][k] = float(src[k])
    if "focus_mode" in (data.get("pose") or {}):
        pose["focus_mode"] = data["pose"]["focus_mode"]
    if "focus_anchor" in (data.get("pose") or {}):
        pose["focus_anchor"] = int(data["pose"]["focus_anchor"])
    pts = []
    for p in data.get("points") or []:
        pts.append({
            "name": str(p.get("name", "")),
            "x": float(p.get("x", 0)), "y": float(p.get("y", 0)),
            "z": float(p.get("z", 0)),
            "kind": p.get("kind", "focus"),
        })
    if not pts:
        pts = base["points"]
    subjects = []
    max_id = 0
    if data.get("subjects") is None and not data.get("points"):
        subjects = json.loads(json.dumps(base["subjects"]))
    for s in data.get("subjects") or []:
        typ = s.get("type", "vline")
        if typ not in ("vline", "hline", "rect"):
            typ = "vline"
        qs = []
        for q in (s.get("pts") or [])[:2]:
            qs.append([float(q[0]), float(q[1]), float(q[2])])
        if len(qs) < 2:
            continue
        sub = {"id": int(s.get("id") or 0), "type": typ,
               "name": str(s.get("name", ""))[:40],
               "must_keep": bool(s.get("must_keep")), "pts": qs}
        max_id = max(max_id, sub["id"])
        subjects.append(sub)
    for i, s in enumerate(subjects):
        if not s["id"]:
            max_id += 1
            s["id"] = max_id
    comp_in = data.get("comp") or {}
    comp = {
        "keep_margin": float(comp_in.get("keep_margin", base["comp"]["keep_margin"])),
        "persp_tol": float(comp_in.get("persp_tol", base["comp"]["persp_tol"])),
    }
    locks = {k: bool(v) for k, v in (data.get("locks") or {}).items()}
    return {"camera": cam, "pose": pose, "points": pts,
            "subjects": subjects, "comp": comp, "locks": locks}


@app.route("/api/compute", methods=["POST"])
def api_compute():
    state = _clean_state(request.get_json(force=True, silent=True) or {})
    if state["pose"].get("focus_mode", "auto") == "auto":
        cg.autofocus(state)
    t0 = time.time()
    result = cg.compute(state)
    result["elapsed_ms"] = round((time.time() - t0) * 1000, 1)
    return jsonify({"state": state, "result": result})


@app.route("/api/search", methods=["POST"])
def api_search():
    payload = request.get_json(force=True, silent=True) or {}
    state = _clean_state(payload.get("state") or payload)
    opts = payload.get("opts") or {}
    opts.setdefault("angle_step", 3.0)
    opts.setdefault("angle_range", state["camera"]["max_tilt"])
    t0 = time.time()
    out = cg.search(state, opts)
    out["elapsed_ms"] = round((time.time() - t0) * 1000, 1)
    return jsonify(out)


# ---------------- 方案存取 ----------------
@app.route("/api/plans", methods=["GET", "POST"])
def api_plans():
    conn = db()
    if request.method == "POST":
        data = request.get_json(force=True, silent=True) or {}
        name = (data.get("name") or "未命名方案").strip()[:80]
        note = str(data.get("note", ""))[:2000]
        state = _clean_state(data.get("state") or {})
        if state["pose"].get("focus_mode", "auto") == "auto":
            cg.autofocus(state)
        result = cg.compute(state)
        now = time.time()
        cur = conn.execute(
            "INSERT INTO plans(name,note,created_at,updated_at,state_json,result_json)"
            " VALUES(?,?,?,?,?,?)",
            (name, note, now, now,
             json.dumps(state, ensure_ascii=False),
             json.dumps(_brief(result), ensure_ascii=False)),
        )
        conn.commit()
        return jsonify({"id": cur.lastrowid})
    rows = conn.execute(
        "SELECT id,name,note,created_at,updated_at,result_json FROM plans"
        " ORDER BY updated_at DESC").fetchall()
    return jsonify([{"id": r["id"], "name": r["name"], "note": r["note"],
                     "created_at": r["created_at"], "updated_at": r["updated_at"],
                     "brief": json.loads(r["result_json"] or "null")} for r in rows])


@app.route("/api/plans/<int:pid>", methods=["GET", "DELETE", "PUT"])
def api_plan(pid):
    conn = db()
    row = conn.execute("SELECT * FROM plans WHERE id=?", (pid,)).fetchone()
    if row is None:
        return jsonify({"error": "方案不存在"}), 404
    if request.method == "GET":
        return jsonify({"id": row["id"], "name": row["name"], "note": row["note"],
                        "state": json.loads(row["state_json"]),
                        "result": json.loads(row["result_json"] or "null")})
    if request.method == "DELETE":
        conn.execute("DELETE FROM plans WHERE id=?", (pid,))
        conn.commit()
        return jsonify({"ok": True})
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or row["name"]).strip()[:80]
    note = str(data.get("note", row["note"]))[:2000]
    state = _clean_state(data.get("state") or json.loads(row["state_json"]))
    if state["pose"].get("focus_mode", "auto") == "auto":
        cg.autofocus(state)
    result = cg.compute(state)
    conn.execute(
        "UPDATE plans SET name=?,note=?,updated_at=?,state_json=?,result_json=? WHERE id=?",
        (name, note, time.time(),
         json.dumps(state, ensure_ascii=False),
         json.dumps(_brief(result), ensure_ascii=False), pid))
    conn.commit()
    return jsonify({"ok": True})


def _brief(result):
    """方案列表只存摘要, 减小体积。"""
    if not result:
        return None
    gg = result.get("ground_glass") or {}
    return {
        "extension": result.get("extension"),
        "max_blur": result.get("max_blur"),
        "ic_min_margin": result.get("ic_min_margin"),
        "f_number_eff": result.get("f_number_eff"),
        "min_clearance": result.get("min_clearance"),
        "warnings": result.get("warnings"),
        "max_persp": gg.get("max_persp"),
        "crop_margin": gg.get("min_margin"),
        "gg_violations": gg.get("violations"),
    }


if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5000, debug=False)
