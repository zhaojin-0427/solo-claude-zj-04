/* 大画幅移轴对焦工作台 — 前端逻辑(原生 JS + SVG) */
"use strict";

let STATE = null;
let RESULT = null;
let activeTab = "rear";
let compareCandidates = [];   // 叠加比较的候选
let searchCandidates = [];
let flashTimer = null;
let drawTool = "";            // "", "vline","hline","rect","keep"
let drawing = null;           // {kind, pts}
let selectedSubjectId = null;
let ggInvert = true;
let lastSubjSig = "";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";

// SVG presentation 属性对 CSS 变量支持不一致, 这里用具体色值
const C = {
  grid: "#2a2f3a", rear: "#6ea8fe", front: "#ffb454",
  plane: "#4cc38a", wedge: "rgba(76,195,138,0.14)",
  hinge: "#e879f9", bad: "#ef6a5e", accent: "#4aa8ff",
};

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in (attrs || {})) {
    if (k === "text") e.textContent = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  if (parent) parent.appendChild(e);
  return e;
}

async function api(path, body) {
  const opt = body ? { method: "POST", headers: { "Content-Type": "application/json" },
                       body: JSON.stringify(body) } : {};
  const r = await fetch(path, opt);
  return r.json();
}

function flash(msg) {
  const f = $("flash");
  f.textContent = msg; f.style.display = "block";
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (f.style.display = "none"), 2200);
}

/* ---------------- 初始化 ---------------- */
async function init() {
  STATE = await api("/api/default");
  ggInvert = true;
  bindInputs();
  bindLocks();
  bindPoints();
  bindViews();
  bindHeader();
  bindSubjectUI();
  syncControls();
  await recompute(true);
}

/* ---------------- 输入控件 ---------------- */
const CAM_FIELDS = ["film_w","film_h","focal","aperture","image_circle","coc",
  "bellows_min","bellows_max","rail_max","min_clearance",
  "max_tilt","max_swing","max_rise","max_shift"];

const POSE_DEFS = [
  ["tilt","俯仰 °",0.1], ["swing","摇摆 °",0.1],
  ["rise","升降 mm",1], ["shift","平移 mm",1], ["x","轨道 x mm",1],
];

function bindInputs() {
  for (const id of CAM_FIELDS) {
    $(id).addEventListener("change", async () => {
      STATE.camera[id] = parseFloat($(id).value) || 0;
      await recompute();
    });
  }
  $("tabRear").onclick = () => { activeTab = "rear"; setTab(); };
  $("tabFront").onclick = () => { activeTab = "front"; setTab(); };
  $("autoFocus").onchange = (e) => {
    STATE.pose.focus_mode = e.target.checked ? "auto" : "manual";
    recompute();
  };
  $("focusAnchor").onchange = (e) => {
    STATE.pose.focus_anchor = parseInt(e.target.value, 10) || 0;
    recompute();
  };
  $("keepMargin").onchange = (e) => {
    STATE.comp.keep_margin = parseFloat(e.target.value) || 0;
    recompute();
  };
  $("perspTol").onchange = (e) => {
    STATE.comp.persp_tol = parseFloat(e.target.value) || 0;
    recompute();
  };
  $("ggInvert").onchange = (e) => { ggInvert = e.target.checked; drawGroundGlass(); };
  setTab();
}

function setTab() {
  $("tabRear").classList.toggle("on", activeTab === "rear");
  $("tabFront").classList.toggle("on", activeTab === "front");
  const box = $("nudges");
  box.innerHTML = "";
  for (const [key, label, step] of POSE_DEFS) {
    const wrap = document.createElement("div");
    wrap.className = "fld";
    wrap.innerHTML = `<label>${label}</label>
      <input type="number" step="${step}" id="nudge_${key}">`;
    box.appendChild(wrap);
    wrap.querySelector("input").addEventListener("change", async (e) => {
      STATE.pose[activeTab][key] = parseFloat(e.target.value) || 0;
      await recompute(true);
    });
  }
  syncNudges();
}

function syncControls() {
  for (const id of CAM_FIELDS) $(id).value = round3(STATE.camera[id]);
  $("keepMargin").value = round3((STATE.comp || {}).keep_margin ?? 8);
  $("perspTol").value = round3((STATE.comp || {}).persp_tol ?? 2);
  $("ggInvert").checked = ggInvert;
  $("autoFocus").checked = STATE.pose.focus_mode !== "manual";
  for (const k in STATE.locks || {}) {
    const lab = document.querySelector(`#locks label[data-k="${k}"] input`);
    if (lab) lab.checked = !!STATE.locks[k];
  }
  renderPoints();
  syncNudges();
}

function syncNudges() {
  for (const [key] of POSE_DEFS) {
    const inp = $(`nudge_${key}`);
    if (inp) inp.value = round3(STATE.pose[activeTab][key]);
  }
}

function round3(x) { return Math.round(x * 1000) / 1000; }

function bindLocks() {
  document.querySelectorAll("#locks label").forEach((lab) => {
    lab.querySelector("input").addEventListener("change", (e) => {
      const k = lab.dataset.k;
      STATE.locks[k] = e.target.checked;
      lab.classList.toggle("on", e.target.checked);
      if (k === "camera_pos") {
        for (const kk of ("rear_x", "front_x")) {
          STATE.locks[kk] = e.target.checked;
          const l2 = document.querySelector(`#locks label[data-k="${kk}"]`);
          if (l2) { l2.querySelector("input").checked = e.target.checked;
                    l2.classList.toggle("on", e.target.checked); }
        }
      }
    });
  });
}

/* ---------------- 对焦点表 ---------------- */
function bindPoints() {
  $("addFocus").onclick = () => addPoint("focus");
  $("addComp").onclick = () => addPoint("comp");
}

function addPoint(kind) {
  const n = STATE.points.length + 1;
  STATE.points.push({ name: (kind === "focus" ? "对焦" : "构图") + n,
    x: 1000, y: 0, z: 0, kind });
  renderPoints();
  recompute();
}

function renderPoints() {
  const tb = $("ptsBody");
  tb.innerHTML = "";
  STATE.points.forEach((p, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input data-f="name" value="${p.name}"></td>
      <td><input data-f="x" type="number" step="10" value="${round3(p.x)}"></td>
      <td><input data-f="y" type="number" step="10" value="${round3(p.y)}"></td>
      <td><input data-f="z" type="number" step="10" value="${round3(p.z)}"></td>
      <td><span class="tag ${p.kind}">${p.kind === "focus" ? "对焦" : "构图"}</span></td>
      <td><button class="ghost danger" data-del>×</button></td>`;
    tr.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("change", () => {
        const f = inp.dataset.f;
        p[f] = f === "name" ? inp.value : parseFloat(inp.value) || 0;
        if (f !== "name") recompute(); else renderAnchor();
      });
    });
    tr.querySelector("[data-del]").onclick = () => {
      STATE.points.splice(i, 1);
      renderPoints();
      recompute();
    };
    tb.appendChild(tr);
  });
  renderAnchor();
}

function renderAnchor() {
  const sel = $("focusAnchor");
  const cur = STATE.pose.focus_anchor;
  sel.innerHTML = "";
  STATE.points.forEach((p, i) => {
    const o = document.createElement("option");
    o.value = i; o.textContent = p.name;
    sel.appendChild(o);
  });
  sel.value = Math.min(cur, Math.max(0, STATE.points.length - 1));
}

/* ---------------- 计算 ---------------- */
let recomputeToken = 0;
async function recompute(syncNudgeToo) {
  const token = ++recomputeToken;
  const { state, result } = await api("/api/compute", STATE);
  if (token !== recomputeToken) return;
  STATE = state; RESULT = result;
  renderAll(syncNudgeToo);
}

function renderAll(syncNudgeToo) {
  drawView("sideSvg", "side");
  drawView("topSvg", "top");
  drawGroundGlass();
  renderMetrics();
  renderWarnings();
  renderPoints();
  renderSubjectList();
  if (syncNudgeToo) syncNudges();
}

/* ---------------- SVG 视图 ---------------- */
function drawView(svgId, kind) {
  const svg = $(svgId);
  svg.innerHTML = "";
  const v = RESULT.views[kind];
  const W = 800, H = 600, PAD = 30;
  const win = v.win;
  const xmin = win.xmin, xmax = win.xmax;
  let vmin, vmax;
  if (kind === "side") { vmin = win.zmin; vmax = win.zmax; }
  else { vmin = win.ymin; vmax = win.ymax; }
  const sx = (W - 2 * PAD) / (xmax - xmin);
  const syv = (H - 2 * PAD) / (vmax - vmin);
  const sc = Math.min(sx, syv);
  const ox = PAD + ((W - 2 * PAD) - (xmax - xmin) * sc) / 2;
  const oy = PAD + ((H - 2 * PAD) - (vmax - vmin) * sc) / 2;
  function X(x) { return ox + (x - xmin) * sc; }
  function V(z) { return H - (oy + (z - vmin) * sc); }
  function P(p) { return [X(p.x), V(kind === "side" ? p.z : p.y)]; }

  // 网格 + 刻度(每 500mm)
  const gGrid = el("g", {}, svg);
  for (let x = Math.ceil(xmin / 500) * 500; x <= xmax; x += 500) {
    el("line", { x1: X(x), y1: PAD, x2: X(x), y2: H - PAD,
      stroke: C.grid, "stroke-width": 1 }, gGrid);
    const t = el("text", { x: X(x), y: H - PAD + 16, fill: "#6b7484",
      "font-size": 9, "text-anchor": "middle" }, gGrid);
    t.textContent = x;
  }
  for (let z = Math.ceil(vmin / 500) * 500; z <= vmax; z += 500) {
    el("line", { x1: PAD, y1: V(z), x2: W - PAD, y2: V(z),
      stroke: C.grid, "stroke-width": 1 }, gGrid);
    const t = el("text", { x: 6, y: V(z) + 3, fill: "#6b7484", "font-size": 9 }, gGrid);
    t.textContent = z;
  }

  // 景深楔形: 近/远界线之间沿光轴填充示意多边形
  if (v.subject_line) {
    const wedgePts = [];
    for (const w of v.wedges) {
      if (w.line) wedgePts.push(w.line);
    }
    if (wedgePts.length === 2) {
      const a = wedgePts[0], b = wedgePts[1];
      el("polygon", {
        points: `${P(a[0])[0]},${P(a[0])[1]} ${P(a[1])[0]},${P(a[1])[1]} ` +
                `${P(b[1])[0]},${P(b[1])[1]} ${P(b[0])[0]},${P(b[0])[1]}`,
        fill: C.wedge, stroke: "none"
      }, svg);
    }
    for (const w of v.wedges) {
      if (!w.line) continue;
      const [p1, p2] = w.line.map(P);
      el("line", { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
        stroke: "#2f6f4f", "stroke-width": 1, "stroke-dasharray": "5 4" }, svg);
    }
    // 焦平面
    const [s1, s2] = v.subject_line.map(P);
    el("line", { x1: s1[0], y1: s1[1], x2: s2[0], y2: s2[1],
      stroke: C.plane, "stroke-width": 2 }, svg);
  }

  // 光轴
  const [ax1, ax2] = [P(v.axis[0]), P(v.axis[1])];
  el("line", { x1: ax1[0], y1: ax1[1], x2: ax2[0], y2: ax2[1],
    stroke: "#566074", "stroke-width": 1, "stroke-dasharray": "2 3" }, svg);
  // 像场锥
  for (const c of v.cone) {
    const [c1, c2] = [P(c[0]), P(c[1])];
    el("line", { x1: c1[0], y1: c1[1], x2: c2[0], y2: c2[1],
      stroke: "rgba(74,168,255,.25)", "stroke-width": 1 }, svg);
  }

  // 皮腔
  const bell = v.bellows.map(P).map(q => q.join(",")).join(" ");
  el("polygon", { points: bell, fill: "rgba(120,120,130,.10)",
    stroke: "#6b7484", "stroke-width": 1, "stroke-dasharray": "3 3" }, svg);

  // 叠加比较的候选(淡色焦平面)
  for (const cc of compareCandidates) {
    const cv = cc.views[kind];
    if (cv && cv.subject_line) {
      const [a, b] = cv.subject_line.map(P);
      el("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1],
        stroke: cc.color, "stroke-width": 1.5, "stroke-dasharray": "8 3",
        opacity: 0.7 }, svg);
    }
  }

  // 铰链点/线
  if (v.hinge) {
    const [hx, hy] = P(v.hinge);
    if (hx > PAD - 50 && hx < W - PAD + 50 && hy > PAD - 50 && hy < H - PAD + 50) {
      el("circle", { cx: hx, cy: hy, r: 5, fill: C.hinge }, svg);
      const t = el("text", { x: hx + 7, y: hy - 6, fill: C.hinge, "font-size": 10 }, svg);
      t.textContent = "铰链";
    }
  }

  // 片幅角点(像场遮角用)
  v.corners.forEach((cp, i) => {
    const [cx2, cy2] = P(cp);
    const info = RESULT.corners[i];
    el("circle", { cx: cx2, cy: cy2, r: 2.5,
      fill: info.ok ? "#8a93a6" : C.bad }, svg);
  });

  // 勾线主体
  drawViewSubjects(svg, v, P, kind);

  // 前/后组板 + 拖拽热区
  drawStandard(svg, v.rear, "rear", C.rear, P, kind);
  drawStandard(svg, v.front, "front", C.front, P, kind);

  // 对焦点 / 构图点
  v.points.forEach((p, i) => {
    const [px, py] = P(p);
    const info = RESULT.points[i];
    const color = p.kind === "focus"
      ? (info && info.blur != null && info.blur > STATE.camera.coc ? C.bad : C.plane)
      : C.accent;
    el("circle", { cx: px, cy: py, r: 5, fill: color, stroke: "#0d0f13",
      "stroke-width": 1.5, class: "hit", "data-drag": "point", "data-i": i }, svg);
    const t = el("text", { x: px + 8, y: py - 7, fill: color, "font-size": 10 }, svg);
    t.textContent = p.name;
  });
}

const SUBJ_COLORS = { vline: "#fbbf24", hline: "#38bdf8", rect: "#f472b6", keep: "#ef6a5e" };

function drawViewSubjects(svg, v, P, kind) {
  (v.subjects || []).forEach((s) => {
    const color = s.must_keep ? SUBJ_COLORS.keep : SUBJ_COLORS[s.type];
    const sel = s.id === selectedSubjectId;
    const pts = s.poly.map(P);
    // 透明宽热区, 便于点选/整段拖动
    if (pts.length >= 2) {
      el("polyline", { points: pts.map(q => q.join(",")).join(" "),
        class: "hit", fill: "none", "data-drag": "subject",
        "data-sid": s.id, "data-kind": kind }, svg);
    }
    el("polyline", {
      points: pts.map(q => q.join(",")).join(" "),
      fill: s.type === "rect" ? "rgba(244,114,182,0.07)" : "none",
      stroke: color, "stroke-width": sel ? 2.5 : 1.6,
      "stroke-dasharray": s.must_keep ? "6 2" : "none",
      style: sel ? "filter:drop-shadow(0 0 4px " + color + ")" : "",
    }, svg);
    // 端点(闭合矩形的最后一点与首点重复, 用 ends)
    s.ends.forEach((q, ei) => {
      const [hx, hy] = P(q);
      el("rect", { x: hx - 4, y: hy - 4, width: 8, height: 8,
        fill: "#0d0f13", stroke: color, "stroke-width": 1.6,
        class: "hit", "data-drag": "subj_end", "data-sid": s.id,
        "data-ei": ei, "data-kind": kind }, svg);
    });
    // 标签
    const lx = pts[0][0], ly = pts[0][1];
    const t = el("text", { x: lx + 6, y: ly + (kind === "side" ? -8 : 12),
      fill: color, "font-size": 10 }, svg);
    t.textContent = s.name + (s.must_keep ? " 🔒" : "");
  });
  // 正在勾画的临时线
  if (drawing && drawing.kind === kind && drawing.cur) {
    const a = P(drawing.start), b = P(drawing.cur);
    el("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1],
      stroke: "#fff", "stroke-width": 1, "stroke-dasharray": "4 3" }, svg);
  }
}

function drawStandard(svg, std, which, color, P, kind) {
  const [p1, p2] = std.seg.map(P);
  const c = P(std.center);
  el("line", { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
    stroke: color, "stroke-width": 5, "stroke-linecap": "round" }, svg);
  // 法线小箭头(前组朝被摄体 +x, 后组朝 -x)
  const dir = which === "front" ? 1 : -1;
  el("line", { x1: c[0], y1: c[1], x2: c[0] + 16 * dir, y2: c[1],
    stroke: color, "stroke-width": 1.5 }, svg);
  // 拖拽热区: 整板
  const midx = (p1[0] + p2[0]) / 2, midy = (p1[1] + p2[1]) / 2;
  const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const angle = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) * 180 / Math.PI;
  el("line", { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
    class: "hit", "data-drag": "standard", "data-which": which,
    "data-kind": kind }, svg);
  const t = el("text", { x: midx, y: midy - len / 2 - 6, fill: color,
    "font-size": 10, "text-anchor": "middle",
    transform: `rotate(${-angle},${midx},${midy})` }, svg);
  t.textContent = which === "rear" ? "后组" : "前组";
}

/* ---------------- 拖拽 ---------------- */
function bindViews() {
  ["sideSvg", "topSvg"].forEach((id) => {
    const svg = $(id);
    svg.addEventListener("pointerdown", startDrag);
  });
  window.addEventListener("pointermove", moveDrag);
  window.addEventListener("pointerup", endDrag);
}

let drag = null;

// 与 drawView 完全一致的投影参数, 用于屏幕坐标反解世界坐标
function viewTransform(kind, rect) {
  const W = 800, H = 600, PAD = 30;
  const win = RESULT.views[kind].win;
  const xmin = win.xmin, xmax = win.xmax;
  const vmin = kind === "side" ? win.zmin : win.ymin;
  const vmax = kind === "side" ? win.zmax : win.ymax;
  // preserveAspectRatio="xMidYMid meet": 等比缩放并在元素内居中,
  // 元素与 viewBox 画布之间可能有双向留白
  const meet = Math.min(rect.width / W, rect.height / H);
  const offX = (rect.width - W * meet) / 2;
  const offY = (rect.height - H * meet) / 2;
  const sc = Math.min((W - 2 * PAD) / (xmax - xmin), (H - 2 * PAD) / (vmax - vmin));
  const ox = PAD + ((W - 2 * PAD) - (xmax - xmin) * sc) / 2;
  const oy = PAD + ((H - 2 * PAD) - (vmax - vmin) * sc) / 2;
  return { xmin, vmin, ox, oy, sc, meet, offX, offY, pxPerUnit: meet * sc };
}

function screenToWorld(svgEl, kind, cx, cy) {
  const rect = svgEl.getBoundingClientRect();
  const T = viewTransform(kind, rect);
  // 先扣除 meet 居中留白, 再从像素换回到 viewBox(800×600)坐标
  const vx = (cx - rect.left - T.offX) / T.meet;
  const vy = (cy - rect.top - T.offY) / T.meet;
  const x = T.xmin + (vx - T.ox) / T.sc;
  const v = T.vmin + (600 - vy - T.oy) / T.sc;
  return { x, v };
}

function startDrag(e) {
  const t = e.target.closest("[data-drag]");
  const svg = e.currentTarget;
  const kind = svg.id === "sideSvg" ? "side" : "top";

  // 勾画模式: 在视图空白处按下开始画线
  if (drawTool) {
    const need = { vline: "side", rect: "side", keep: "side", hline: "top" }[drawTool];
    if (need !== kind) {
      flash(drawTool === "hline" ? "横线请在俯视图勾画" : "竖线/矩形请在侧视图勾画");
      return;
    }
    e.preventDefault();
    const w = screenToWorld(svg, kind, e.clientX, e.clientY);
    const q = viewPoint(kind, w.x, w.v);
    drawing = { kind, tool: drawTool, start: q, cur: q, svgId: svg.id };
    svg.setPointerCapture(e.pointerId);
    return;
  }

  if (!t) return;
  e.preventDefault();
  drag = {
    type: t.dataset.drag, which: t.dataset.which, kind, svg,
    lastX: e.clientX, lastY: e.clientY,
    startX: e.clientX, startY: e.clientY,
    orig: JSON.parse(JSON.stringify(STATE.pose)),
    pointIndex: t.dataset.i != null ? parseInt(t.dataset.i, 10) : null,
    sid: t.dataset.sid != null ? parseInt(t.dataset.sid, 10) : null,
    endIndex: t.dataset.ei != null ? parseInt(t.dataset.ei, 10) : null,
    subjOrig: null,
  };
  if (drag.type === "subject" || drag.type === "subj_end") {
    drag.subjOrig = JSON.parse(
      JSON.stringify(STATE.subjects.find(s => s.id === drag.sid)));
    selectedSubjectId = drag.sid;
    renderSubjectList();
  }
  svg.setPointerCapture(e.pointerId);
}

function viewPoint(kind, x, v) {
  // 侧视图勾画: 给定 x 与 z; 俯视图: x 与 y, 其余坐标取 0。
  // 返回 {x,y,z} 对象, 与视图投影 P(p) 的字段访问保持一致。
  if (kind === "side") return { x, y: 0, z: v };
  return { x, y: v, z: 0 };
}

let dragScheduled = false;
let drawScheduled = false;
async function moveDrag(e) {
  if (drawing) {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(() => {
      drawScheduled = false;
      if (!drawing) return;
      const w = screenToWorld($(drawing.svgId), drawing.kind, e.clientX, e.clientY);
      drawing.cur = viewPoint(drawing.kind, Math.max(1, w.x), w.v);
      drawView("sideSvg", "side");
      drawView("topSvg", "top");
    });
    return;
  }
  if (!drag) return;
  if (dragScheduled) return;
  dragScheduled = true;
  requestAnimationFrame(async () => {
    dragScheduled = false;
    // 自按下点累计的总位移, 每帧从原始姿态重算, 完整保留连续拖动
    const dxPx = e.clientX - drag.startX;
    const dyPx = e.clientY - drag.startY;
    if (drag.type === "point") {
      const w = screenToWorld(drag.svg, drag.kind, e.clientX, e.clientY);
      const p = STATE.points[drag.pointIndex];
      if (p) {
        p.x = Math.max(1, w.x);
        if (drag.kind === "side") p.z = w.v; else p.y = w.v;
      }
    } else if (drag.type === "standard") {
      applyStandardDrag(e, dxPx, dyPx);
    } else if (drag.type === "subj_end") {
      applySubjectEndDrag(e);
    } else if (drag.type === "subject") {
      applySubjectMoveDrag(e, dxPx, dyPx);
    }
    await recompute(true);
  });
}

// 拖主体端点: 端点在两个视图内的约束坐标联动
function applySubjectEndDrag(ev) {
  const sub = STATE.subjects.find(s => s.id === drag.sid);
  if (!sub) return;
  const w = screenToWorld(drag.svg, drag.kind, ev.clientX, ev.clientY);
  const idx = drag.endIndex;
  const q = sub.pts[idx >= sub.pts.length ? 0 : idx];
  const o = drag.subjOrig.pts[idx >= drag.subjOrig.pts.length ? 0 : idx];
  if (sub.type === "vline") {
    // 竖线: 同一端点 x,y 固定, 侧视改 z; 俯视改 x,y
    if (drag.kind === "side") { q[0] = o[0]; q[1] = o[1]; q[2] = w.v; }
    else { q[0] = Math.max(1, w.x); q[1] = w.v; q[2] = o[2]; }
    // 保持竖直: 两端 x,y 相同
    const other = sub.pts[idx === 0 ? 1 : 0];
    other[0] = q[0]; other[1] = q[1];
  } else if (sub.type === "hline") {
    // 横线: z 固定, 俯视改 x,y; 侧视改 x,z(高度)
    if (drag.kind === "top") { q[0] = Math.max(1, w.x); q[1] = w.v; q[2] = o[2]; }
    else { q[0] = Math.max(1, w.x); q[1] = o[1]; q[2] = w.v; }
    // 两端同高
    const other = sub.pts[idx === 0 ? 1 : 0];
    other[2] = q[2];
  } else {
    // 竖直矩形立面: 存储对角 A=pts[0](左下), C=pts[1](右上),
    // 派生 B=右下(C.x,C.y,A.z), D=左上(A.x,A.y,C.z)。
    // 拖派生角点时, 把新 (x,z) 或 (x,y) 拆回 A/C 对应坐标分量。
    const A = sub.pts[0], C = sub.pts[1];
    if (drag.kind === "side") {
      // 侧视给 (x,z); y 保持原值, 以对角原值为基准拆分
      if (idx === 0) { A[0] = Math.max(1, w.x); A[2] = w.v; }
      else if (idx === 2) { C[0] = Math.max(1, w.x); C[2] = w.v; }
      else if (idx === 1) { C[0] = Math.max(1, w.x); A[2] = w.v; }   // B
      else { A[0] = Math.max(1, w.x); C[2] = w.v; }                  // D
    } else {
      // 俯视给 (x,y)
      if (idx === 0) { A[0] = Math.max(1, w.x); A[1] = w.v; }
      else if (idx === 2) { C[0] = Math.max(1, w.x); C[1] = w.v; }
      else if (idx === 1) { C[0] = Math.max(1, w.x); C[1] = w.v; }   // B 同 C
      else { A[0] = Math.max(1, w.x); A[1] = w.v; }                  // D 同 A
    }
  }
}

function applySubjectMoveDrag(ev, dxPx, dyPx) {
  const sub = STATE.subjects.find(s => s.id === drag.sid);
  if (!sub) return;
  const T = viewTransform(drag.kind, drag.svg.getBoundingClientRect());
  const mmPx = 1 / T.pxPerUnit;
  const dx = dxPx * mmPx;
  const dz = -dyPx * mmPx;   // 屏幕向上为 z+
  const orig = drag.subjOrig.pts;
  sub.pts.forEach((q, i) => {
    q[0] = Math.max(1, orig[i][0] + dx);
    if (drag.kind === "side") { q[2] = orig[i][2] + dz; }
    else { q[1] = orig[i][1] + dz; }
  });
}

// 累计拖拽(自按下点): 水平像素 -> 轨道; 垂直像素 -> 倾角(0.15°/px);
// Shift+垂直 -> 升降/平移。每帧从 orig 姿态重算, 连续多段不丢位移。
function applyStandardDrag(ev, dxPx, dyPx) {
  const which = drag.which, kind = drag.kind;
  const std = STATE.pose[which];
  const orig = drag.orig[which];
  const T = viewTransform(kind, drag.svg.getBoundingClientRect());
  const mmPx = 1 / T.pxPerUnit;
  if (ev.shiftKey) {
    const dmm = -dyPx * mmPx;
    if (kind === "side")
      std.rise = clampNum(orig.rise + dmm, -STATE.camera.max_rise, STATE.camera.max_rise);
    else
      std.shift = clampNum(orig.shift + dmm, -STATE.camera.max_shift, STATE.camera.max_shift);
    return;
  }
  // 水平拖动改变轨道(前后组), 纵向改变倾角
  const dTrack = dxPx * mmPx;
  std.x = orig.x + dTrack;
  const dAng = dyPx * 0.15;
  if (kind === "side")
    std.tilt = clampNum(orig.tilt + dAng, -STATE.camera.max_tilt, STATE.camera.max_tilt);
  else
    std.swing = clampNum(orig.swing + dAng, -STATE.camera.max_swing, STATE.camera.max_swing);
  STATE.pose.focus_mode = "manual";
}

window.addEventListener("keydown", (e) => { window.__shift = e.shiftKey; });
window.addEventListener("keyup", (e) => { window.__shift = e.shiftKey; });

function clampNum(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function endDrag(e) {
  // 勾画完成: 提交新主体
  if (drawing) {
    const d = drawing;
    drawing = null;
    const dist = Math.hypot(d.cur.x - d.start.x,
      d.kind === "side" ? d.cur.z - d.start.z : d.cur.y - d.start.y);
    if (dist > 30) commitSubject(d);
    else { drawView("sideSvg", "side"); drawView("topSvg", "top"); }
    return;
  }
  if (drag && drag.type === "standard" && STATE.pose.focus_mode === "manual"
      && $("autoFocus").checked) {
    STATE.pose.focus_mode = "auto";
    recompute(true);
  }
  drag = null;
}

function commitSubject(d) {
  const a0 = [d.start.x, d.start.y, d.start.z];
  const b0 = [d.cur.x, d.cur.y, d.cur.z];
  let A = a0.slice(), B = b0.slice();
  let type = d.tool;
  let mustKeep = false;
  if (d.tool === "keep") { type = "rect"; mustKeep = true; }
  if (type === "vline") {
    // 竖直: 上端 z 大; 两端 x,y 相同
    if (B[2] < A[2]) [A, B] = [B, A];
    B[0] = A[0]; B[1] = A[1];
  } else if (type === "hline") {
    if (B[0] < A[0]) [A, B] = [B, A];
    B[2] = A[2];
  } else {
    // 矩形: A 左下 (z 小), C 右上 (z 大)
    if (B[2] < A[2]) [A, B] = [B, A];
  }
  const id = (STATE.subjects.reduce((m, s) => Math.max(m, s.id || 0), 0) || 0) + 1;
  const typeName = { vline: "竖线", hline: "横线", rect: "矩形" }[type];
  const sub = { id, type, name: typeName + id, must_keep: mustKeep, pts: [A, B] };
  STATE.subjects.push(sub);
  selectedSubjectId = id;
  drawTool = ""; updateToolButtons();
  flash("已添加" + (mustKeep ? "必留边界" : typeName));
  recompute(true);
}

/* ---------------- 毛玻璃(片平面投影) ---------------- */
function drawGroundGlass() {
  const svg = $("ggSvg");
  if (!svg || !RESULT || !RESULT.ground_glass) return;
  svg.innerHTML = "";
  const gg = RESULT.ground_glass;
  const VW = 320, VH = 400, PAD = 26;
  const w = gg.film_w, h = gg.film_h;
  const sc = Math.min((VW - 2 * PAD) / w, (VH - 2 * PAD) / h);
  const ox = (VW - w * sc) / 2, oy = (VH - h * sc) / 2;
  // 片上 (s 向右, t 向上) -> SVG。毛玻璃倒像: 上下左右均翻转
  function M(s, t) {
    const sx = ggInvert ? -s : s, sy = ggInvert ? -t : t;
    return [ox + (w / 2 + sx) * sc, oy + (h / 2 - sy) * sc];
  }

  // 片幅外暗底
  el("rect", { x: 0, y: 0, width: VW, height: VH, fill: "#0b0e12" }, svg);
  // 片幅
  el("rect", { x: ox, y: oy, width: w * sc, height: h * sc,
    fill: "#151a21", stroke: "#8a93a6", "stroke-width": 1.4 }, svg);
  // 留边框
  const m = Math.min(gg.keep_margin, w / 2 - 1, h / 2 - 1);
  el("rect", { x: ox + m * sc, y: oy + m * sc,
    width: (w - 2 * m) * sc, height: (h - 2 * m) * sc,
    fill: "none", stroke: "#e8b04b", "stroke-width": 1,
    "stroke-dasharray": "5 3" }, svg);

  // 像场圈椭圆
  if (gg.ic_ellipse) {
    const [cx, cy] = M(gg.ic_ellipse.cx, gg.ic_ellipse.cy);
    el("ellipse", { cx, cy, rx: gg.ic_ellipse.rx * sc, ry: gg.ic_ellipse.ry * sc,
      fill: "rgba(74,168,255,0.05)", stroke: "rgba(74,168,255,0.65)",
      "stroke-width": 1, "stroke-dasharray": "4 3",
      transform: `rotate(${(ggInvert ? -1 : 1) * gg.ic_ellipse.rot * 180 / Math.PI} ${cx} ${cy})` },
      svg);
  }

  // 主体投影
  gg.subjects.forEach((s) => {
    const color = s.must_keep ? SUBJ_COLORS.keep : SUBJ_COLORS[s.type];
    const sel = s.id === selectedSubjectId;
    const bad = s.issues.some(i => i.level === "critical");
    const stroke = bad ? "#ef6a5e" : color;
    (s.segs || []).forEach((seg) => {
      const [a, b] = [M(seg[0][0], seg[0][1]), M(seg[1][0], seg[1][1])];
      el("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1],
        stroke, "stroke-width": sel ? 2.6 : 1.7,
        "stroke-dasharray": s.clipped ? "5 2" : "none",
        style: sel ? "filter:drop-shadow(0 0 4px " + color + ");cursor:pointer"
                   : "cursor:pointer",
        class: "gg-subj", "data-sid": s.id }, svg);
    });
    // 顶点
    (s.verts || []).forEach((v) => {
      if (!v) return;
      const [x, y] = M(v[0], v[1]);
      if (x < -20 || x > VW + 20 || y < -20 || y > VH + 20) return;
      el("circle", { cx: x, cy: y, r: sel ? 3.4 : 2.4, fill: stroke,
        style: "cursor:pointer", class: "gg-subj", "data-sid": s.id }, svg);
    });
  });

  // 构图点/对焦点(片上位置)
  (RESULT.points || []).forEach((p) => {
    if (p.s == null || p.t == null) return;
    const [x, y] = M(p.s, p.t);
    if (x < 0 || x > VW || y < 0 || y > VH) return;
    el("circle", { cx: x, cy: y, r: 2.2,
      fill: p.kind === "focus" ? "rgba(76,195,138,.85)" : "rgba(74,168,255,.85)" }, svg);
  });

  // 片幅标签
  const tag = el("text", { x: ox, y: VH - 8, fill: "#6b7484", "font-size": 9 }, svg);
  tag.textContent = `${w}×${h} mm` + (ggInvert ? " · 倒像" : " · 正像(已翻转显示)");

  svg.querySelectorAll(".gg-subj").forEach(node => {
    node.addEventListener("click", () => {
      selectedSubjectId = parseInt(node.dataset.sid, 10);
      renderSubjectList();
      drawView("sideSvg", "side"); drawView("topSvg", "top");
      drawGroundGlass();
    });
  });
  renderGroundGlassPanel(gg);
}

function renderGroundGlassPanel(gg) {
  // 汇总指标
  const sum = $("ggSummary");
  const perspCls = gg.max_persp > gg.persp_tol ? "badval" : "goodval";
  const crop = gg.min_margin == null ? "–" : gg.min_margin.toFixed(1);
  const cropCls = gg.min_margin != null && gg.min_margin < gg.keep_margin
    ? "badval" : "goodval";
  sum.innerHTML = `
    <span>异常对象<b class="${gg.violations ? "badval" : "goodval"}">${gg.violations}</b></span>
    <span>最大透视<b class="${perspCls}">${gg.max_persp.toFixed(1)}</b></span>
    <span>裁切余量 mm<b class="${cropCls}">${crop}</b></span>
    <span>留边 mm<b>${gg.keep_margin.toFixed(0)}</b></span>
    <span>容差<b>${gg.persp_tol.toFixed(1)}</b></span>`;

  // 逐对象始终显示名称与各项指标; 无指标的类型显示 –
  const box = $("ggIssues");
  box.innerHTML = "";
  if (!gg.subjects.length) {
    box.innerHTML = '<div style="color:var(--dim);font-size:11px;padding:4px">尚未勾画主体</div>';
    return;
  }
  gg.subjects.forEach((s) => {
    const row = document.createElement("div");
    row.className = "gg-subjrow" + (s.id === selectedSubjectId ? " sel" : "");
    const bad = s.issues.some(i => i.level === "critical");
    const warn = s.issues.length > 0 && !bad;
    const title = s.issues.length ? s.issues.map(i => i.msg).join("\n")
                                  : "各项指标正常";
    const chip = (label, val, unit, cls) =>
      `<span class="chip ${cls || ""}"><em>${label}</em><b>${val}</b>${unit || ""}</span>`;
    const m = s.metrics || {};
    const conv = m.convergence != null ? m.convergence : m.v_converge;
    const typeNm = { vline: "竖线", hline: "横线", rect: "矩形" }[s.type] || "";
    row.title = title;
    row.innerHTML = `
      <div class="gs-head ${bad ? "badval" : warn ? "warnval" : "goodval"}">
        ${s.must_keep ? "🔒 " : ""}<span class="gs-name">${escapeHtml(s.name)}</span>
        <span class="gs-type">${typeNm}${s.clipped ? " · 裁切" : ""}</span>
      </div>
      <div class="gs-chips">
        ${chip("裁切余量", m.edge_margin != null ? m.edge_margin.toFixed(1) : "–", "mm",
               m.edge_margin != null && m.edge_margin < gg.keep_margin ? "c-bad" : "")}
        ${chip("竖线汇聚", conv != null ? conv.toFixed(2) : "–", "°",
               conv != null && conv > gg.persp_tol ? "c-warn" : "")}
        ${chip("横线倾斜", m.h_tilt != null ? m.h_tilt.toFixed(2) : "–", "°",
               m.h_tilt != null && m.h_tilt > gg.persp_tol ? "c-warn" : "")}
        ${chip("梯形畸变", m.keystone != null ? m.keystone.toFixed(1) : "–", "%",
               m.keystone != null && m.keystone > gg.persp_tol ? "c-warn" : "")}
        ${chip("边缘放大率差", m.mag_spread != null ? m.mag_spread.toFixed(1) : "–", "%",
               m.mag_spread != null && m.mag_spread > gg.persp_tol ? "c-warn" : "")}
      </div>`;
    row.onclick = () => locateSubject(s.id);
    box.appendChild(row);
  });
}

function locateSubject(sid) {
  selectedSubjectId = sid;
  renderSubjectList();
  drawView("sideSvg", "side"); drawView("topSvg", "top");
  drawGroundGlass();
  // 在侧/俯视图闪烁高亮
  ["sideSvg", "topSvg"].forEach(id => {
    const node = document.querySelector(`#${id} [data-sid="${sid}"]`);
    if (node) {
      node.style.filter = "drop-shadow(0 0 6px #fff)";
      setTimeout(() => { node.style.filter = ""; }, 1800);
    }
  });
}

/* ---------------- 指标 / 警告 ---------------- */
function renderMetrics() {
  const r = RESULT, cam = STATE.camera;
  $("m_ext").textContent = r.extension.toFixed(1);
  $("m_eff").textContent = "f/" + r.f_number_eff.toFixed(1);
  const mb = $("m_blur");
  mb.textContent = r.max_blur.toFixed(3);
  mb.className = r.max_blur > cam.coc ? "badval" : "goodval";
  const ic = $("m_ic");
  ic.textContent = r.ic_min_margin.toFixed(1);
  ic.className = r.ic_min_margin < 0 ? "badval" : (r.ic_min_margin < 10 ? "warnval" : "goodval");
  $("m_clear").textContent = r.min_clearance.toFixed(1);
  $("m_bell").textContent = r.bellows.toFixed(1);
  $("m_mag").textContent = (r.magnification).toFixed(3);
  // 铰链距离(光轴)
  let hingeTxt = "–";
  if (r.hinge) {
    const front = RESULT.views.side.front.center;
    const d = Math.hypot(r.hinge.x - front.x, r.hinge.y - front.y, r.hinge.z - front.z);
    hingeTxt = d.toFixed(0);
  }
  $("m_hinge").textContent = hingeTxt;
}

function renderWarnings() {
  const box = $("warnList");
  box.innerHTML = "";
  if (!RESULT.warnings.length) {
    box.innerHTML = '<div style="color:var(--good);font-size:12px">✓ 全部检查通过</div>';
    return;
  }
  RESULT.warnings.forEach((w) => {
    const d = document.createElement("div");
    d.className = "warnitem " + (w.level === "critical" ? "critical" : "warn");
    d.innerHTML = `${w.msg}<span class="part">${partLabel(w.part)}</span>`;
    d.onclick = () => {
      if (String(w.part).startsWith("subject:")) {
        locateSubject(w.detail && w.detail.subject_id);
      } else locatePart(w.part);
    };
    box.appendChild(d);
  });
}

function partLabel(part) {
  return ({
    rear_tilt: "后组俯仰", front_tilt: "前组俯仰",
    rear_swing: "后组摇摆", front_swing: "前组摇摆",
    rear_rise: "后组升降", front_rise: "前组升降",
    rear_shift: "后组平移", front_shift: "前组平移",
    front_x: "前组轨道", rear_x: "后组轨道",
    bellows: "皮腔", standards: "前后组", image_circle: "像场",
    focus: "对焦", composition: "构图",
  })[part] || (String(part).startsWith("subject:") ? "主体" : part);
}

function locatePart(part) {
  // 高亮相关机件并切换微调页
  const which = part.startsWith("front") ? "front" : "rear";
  if (part.includes("tilt") || part.includes("rise") || part.includes("shift") ||
      part.includes("swing") || part.includes("x")) {
    activeTab = which; setTab();
  }
  const map = { rear_tilt: ["sideSvg","rear"], front_tilt: ["sideSvg","front"],
    rear_rise: ["sideSvg","rear"], front_rise: ["sideSvg","front"],
    rear_swing: ["topSvg","rear"], front_swing: ["topSvg","front"],
    rear_shift: ["topSvg","rear"], front_shift: ["topSvg","front"],
    front_x: ["sideSvg","front"], rear_x: ["sideSvg","rear"],
    bellows: ["sideSvg","front"], standards: ["sideSvg","rear"],
    image_circle: ["sideSvg","rear"], focus: ["sideSvg","front"] };
  const m = map[part];
  if (!m) return;
  const seg = document.querySelector(`#${m[0]} [data-which="${m[1]}"]`);
  if (seg) {
    seg.setAttribute("stroke", "#fff");
    seg.style.filter = "drop-shadow(0 0 6px var(--accent))";
    document.getElementById(m[0]).scrollIntoView({ block: "nearest" });
    setTimeout(() => { seg.removeAttribute("stroke"); seg.style.filter = ""; }, 2200);
  }
}

/* ---------------- 勾线主体 ---------------- */
function bindSubjectUI() {
  document.querySelectorAll("#drawTools button").forEach((b) => {
    b.onclick = () => {
      drawTool = drawTool === b.dataset.tool ? "" : b.dataset.tool;
      updateToolButtons();
      if (drawTool === "hline") flash("在俯视图按下拖动勾画横线");
      else if (drawTool) flash("在侧视图按下拖动勾画" + b.textContent.trim());
    };
  });
}

function updateToolButtons() {
  document.querySelectorAll("#drawTools button").forEach((b) => {
    b.classList.toggle("on", (b.dataset.tool || "") === drawTool);
  });
  document.body.style.cursor = drawTool ? "crosshair" : "";
}

function subjSignature() {
  return (STATE.subjects || []).map(s =>
    s.id + ":" + s.type + ":" + s.must_keep + ":" + s.name).join("|");
}

function renderSubjectList() {
  const box = $("subjList");
  if (!box) return;
  const sig = subjSignature();
  // 名称编辑中不重建, 避免打断输入
  if (sig === lastSubjSig && box.dataset.editing) return;
  lastSubjSig = sig;
  box.innerHTML = "";
  if (!STATE.subjects || !STATE.subjects.length) {
    box.innerHTML = '<div style="color:var(--dim);font-size:11px;padding:3px">暂无勾线主体</div>';
    return;
  }
  STATE.subjects.forEach((s) => {
    const gg = (RESULT && RESULT.ground_glass)
      ? RESULT.ground_glass.subjects.find(g => g.id === s.id) : null;
    const nIssue = gg ? gg.issues.length : 0;
    const row = document.createElement("div");
    row.className = "subjrow" + (s.id === selectedSubjectId ? " sel" : "");
    const typeNm = { vline: "竖线", hline: "横线", rect: "矩形" }[s.type];
    row.innerHTML = `
      <span class="mk ${s.must_keep ? "keep" : ""}">${s.must_keep ? "🔒" : "▸"}</span>
      <input class="nm" value="${escapeHtml(s.name)}" style="background:transparent;border:none;
        color:inherit;font-size:11px;flex:1;min-width:0">
      <span class="mk" style="color:var(--dim)">${typeNm}</span>
      <span class="mk ${nIssue ? "badval" : "goodval"}" title="异常项数">${nIssue || "✓"}</span>
      <label class="mk" title="必留边界">必留<input type="checkbox" ${s.must_keep ? "checked" : ""}></label>
      <button class="ghost danger" data-del>×</button>`;
    row.onclick = (ev) => {
      if (ev.target.tagName === "INPUT" || ev.target.tagName === "BUTTON" ||
          ev.target.tagName === "LABEL") return;
      selectedSubjectId = s.id;
      renderSubjectList();
      drawView("sideSvg", "side"); drawView("topSvg", "top");
      drawGroundGlass();
    };
    const nameInp = row.querySelector("input.nm");
    nameInp.onfocus = () => { box.dataset.editing = "1"; };
    nameInp.onchange = () => {
      s.name = nameInp.value || s.name;
      delete box.dataset.editing;
      lastSubjSig = ""; renderSubjectList();
      drawView("sideSvg", "side"); drawView("topSvg", "top");
      drawGroundGlass();
    };
    row.querySelector('input[type="checkbox"]').onchange = (ev) => {
      s.must_keep = ev.target.checked;
      ev.stopPropagation();
      recompute(true);
    };
    row.querySelector("[data-del]").onclick = (ev) => {
      ev.stopPropagation();
      STATE.subjects = STATE.subjects.filter(x => x.id !== s.id);
      if (selectedSubjectId === s.id) selectedSubjectId = null;
      recompute(true);
    };
    box.appendChild(row);
  });
}

/* ---------------- 搜索 / 候选比较 ---------------- */
function bindHeader() {
  $("btnRefocus").onclick = async () => {
    STATE.pose.focus_mode = "auto";
    await recompute(true);
    flash("已重新自动对焦");
  };
  $("btnSearch").onclick = doSearch;
  $("btnReset").onclick = async () => {
    if (!confirm("恢复默认参数？")) return;
    STATE = await api("/api/default");
    compareCandidates = []; searchCandidates = [];
    syncControls(); await recompute(true);
  };
  $("btnSave").onclick = savePlan;
  $("btnPlans").onclick = togglePlans;
  $("btnCard").onclick = openCard;
}

async function doSearch() {
  $("btnSearch").textContent = "搜索中…";
  const out = await api("/api/search", { state: STATE,
    opts: { angle_step: 3.0, angle_range: STATE.camera.max_tilt } });
  $("btnSearch").textContent = "🔍 搜索组合";
  if (out.error) { flash(out.error); return; }
  searchCandidates = out.candidates || [];
  renderCandidates();
  flash(`找到 ${searchCandidates.length} 个组合，用时 ${out.elapsed_ms}ms`);
}

const CAND_COLORS = ["#e879f9","#4aa8ff","#fbbf24","#34d399","#f472b6","#a3e635"];
function renderCandidates() {
  const box = $("candList");
  box.innerHTML = "";
  if (!searchCandidates.length) {
    box.innerHTML = '<div style="color:var(--dim);font-size:11px">无可行组合（放宽锁定/限位后再试）</div>';
    return;
  }
  searchCandidates.forEach((c, i) => {
    const on = compareCandidates.includes(c);
    const color = CAND_COLORS[compareCandidates.indexOf(c) % CAND_COLORS.length];
    const d = document.createElement("div");
    d.className = "cand" + (on ? " on" : "");
    d.style.borderLeft = `4px solid ${on ? color : "var(--line)"}`;
    d.innerHTML = `
      <div class="candhead">
        <b>#${i + 1} 越界 ${c.oob || 0} · 透视 ${(c.max_persp || 0).toFixed(1)}°</b>
        <span class="${c.hard_warn || c.oob ? "badval" : "goodval"}">
          ${c.hard_warn ? "有硬警告" : "可行"}</span>
      </div>
      <div class="candvals">
        裁切余量 ${c.crop_margin != null && c.crop_margin > -9000 ? c.crop_margin.toFixed(0) : "–"} mm
        · 调整量 ${c.cost.toFixed(0)} · 模糊 ${c.max_blur.toFixed(3)}<br>
        像场余量 ${c.ic_margin.toFixed(0)} mm · 伸长 ${c.extension.toFixed(0)}<br>
        后组 俯${c.pose.rear.tilt.toFixed(1)}° 摇${c.pose.rear.swing.toFixed(1)}°
        升${c.pose.rear.rise.toFixed(0)} 移${c.pose.rear.shift.toFixed(0)}<br>
        前组 俯${c.pose.front.tilt.toFixed(1)}° 摇${c.pose.front.swing.toFixed(1)}°
      </div>
      <div class="rowline" style="margin-top:4px">
        <button data-act="add">${on ? "取消叠加" : "叠加比较"}</button>
        <button data-act="use" class="primary">采用</button>
      </div>`;
    d.querySelector('[data-act="add"]').onclick = (ev) => {
      ev.stopPropagation();
      const k = compareCandidates.indexOf(c);
      if (k >= 0) compareCandidates.splice(k, 1);
      else { c.color = CAND_COLORS[compareCandidates.length % CAND_COLORS.length];
             compareCandidates.push(c); }
      renderAll(); renderCandidates();
    };
    d.querySelector('[data-act="use"]').onclick = async (ev) => {
      ev.stopPropagation();
      STATE.pose = JSON.parse(JSON.stringify(c.pose));
      compareCandidates = [];
      await recompute(true);
      flash("已采用候选调机参数");
    };
    box.appendChild(d);
  });
}

/* ---------------- 方案库 ---------------- */
async function savePlan() {
  const name = prompt("方案名称：", "现场方案 " + new Date().toLocaleString());
  if (name == null) return;
  const r = await api("/api/plans", { name, state: STATE });
  if (r.id) flash("已保存 #" + r.id);
}

async function togglePlans() {
  const pop = $("plansPop");
  if (pop.style.display === "block") { pop.style.display = "none"; return; }
  const rows = await api("/api/plans");
  pop.innerHTML = "<h3 style='margin:0 0 8px;font-size:12px'>方案库</h3>";
  if (!rows.length) pop.innerHTML += "<small style='color:var(--dim)'>还没有保存方案</small>";
  for (const p of rows) {
    const div = document.createElement("div");
    div.className = "planitem";
    const warnN = p.brief ? (p.brief.warnings || []).length : 0;
    const crop = p.brief && p.brief.crop_margin != null
      ? " · 余量 " + p.brief.crop_margin.toFixed(0) + "mm" : "";
    const persp = p.brief && p.brief.max_persp != null
      ? " · 透视 " + p.brief.max_persp.toFixed(1) + "°" : "";
    div.innerHTML = `<div class="nm">${escapeHtml(p.name)}
      <br><small>${new Date(p.updated_at * 1000).toLocaleString()} ·
      伸长 ${p.brief ? p.brief.extension.toFixed(0) : "?"} mm${crop}${persp} ·
      ${warnN ? warnN + " 条警告" : "无警告"}</small></div>
      <button data-load>载入</button> <button class="danger" data-del>删</button>`;
    div.querySelector("[data-load]").onclick = async () => {
      const full = await api("/api/plans/" + p.id);
      STATE = full.state;
      syncControls(); await recompute(true);
      pop.style.display = "none"; flash("已载入 " + p.name);
    };
    div.querySelector("[data-del]").onclick = async () => {
      if (!confirm("删除该方案？")) return;
      await api("/api/plans/" + p.id, { method: "DELETE" }).catch(() => {});
      fetch("/api/plans/" + p.id, { method: "DELETE" }).then(togglePlans);
    };
    pop.appendChild(div);
  }
  pop.style.display = "block";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ---------------- 现场调整卡(带刻度, 打印) ---------------- */
function openCard() {
  const p = STATE.pose, cam = STATE.camera;
  const w = window.open("", "card", "width=900,height=650");
  const rows = [];
  const add = (name, val, unit) => rows.push({ name, val, unit });
  add("后组俯仰", p.rear.tilt, "°");
  add("后组摇摆", p.rear.swing, "°");
  add("后组升降", p.rear.rise, "mm");
  add("后组平移", p.rear.shift, "mm");
  add("前组俯仰", p.front.tilt, "°");
  add("前组摇摆", p.front.swing, "°");
  add("前组升降", p.front.rise, "mm");
  add("前组平移", p.front.shift, "mm");
  add("前组轨道(自后组)", p.front.x - p.rear.x, "mm");

  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>现场调整卡</title>
  <style>
   body{font:13px/1.5 -apple-system,"PingFang SC",sans-serif;margin:24px;color:#111}
   h2{margin:0 0 4px} .sub{color:#555;margin-bottom:16px;font-size:12px}
   table{width:100%;border-collapse:collapse} td,th{border:1px solid #999;padding:6px 8px;font-size:12px}
   th{background:#eee;text-align:left}
   .ruler{position:relative;height:34px;border-bottom:1.5px solid #333;margin:4px 0 14px}
   .ruler span{position:absolute;bottom:0;transform:translateX(-50%);font-size:9px;color:#666;border-left:1px solid #333;padding-left:2px;height:8px}
   .ruler i{position:absolute;top:-2px;bottom:0;width:0;border-left:2px solid #d33;transform:translateX(-50%)}
   .big{font-size:18px;font-weight:600}
   @media print{.noprint{display:none}}
  </style></head><body>
  <h2>大画幅现场调整卡</h2>
  <div class="sub">焦距 ${cam.focal}mm · 光圈 f/${cam.aperture} · 片幅 ${cam.film_w}×${cam.film_h}
   · 像场 ${cam.image_circle}mm · 生成 ${new Date().toLocaleString()}</div>
  <table><thead><tr><th style="width:130px">调整项</th><th style="width:90px">目标值</th><th>刻度(0 居中)</th></tr></thead><tbody>
  ${rows.map(r => `<tr><td>${r.name}</td><td class="big">${r.val.toFixed(1)} ${r.unit}</td>
     <td>${r.unit === "°" ? degreeRuler(r, cam) : linearRuler(r, cam)}</td></tr>`).join("")}
  </tbody></table>
  <div class="sub" style="margin-top:14px">
    光轴伸长 <b>${RESULT.extension.toFixed(1)} mm</b> ·
    有效光圈 <b>f/${RESULT.f_number_eff.toFixed(1)}</b> ·
    最大模糊圆 <b>${RESULT.max_blur.toFixed(3)} mm</b> ·
    像场余量 <b>${RESULT.ic_min_margin.toFixed(1)} mm</b> ·
    最大透视误差 <b>${(RESULT.ground_glass ? RESULT.ground_glass.max_persp : 0).toFixed(1)}°</b> ·
    裁切余量 <b>${RESULT.ground_glass && RESULT.ground_glass.min_margin != null
      ? RESULT.ground_glass.min_margin.toFixed(1) : "–"} mm</b>
  </div>
  <h3 style="font-size:12px;margin:12px 0 4px">片内边界（毛玻璃倒像，红=必留边界，虚线=留边 ${(STATE.comp||{}).keep_margin ?? 8} mm）</h3>
  ${cardFilmSvg()}
  <div class="sub">${cardSubjectTable()}</div>
  <div class="sub">警告: ${RESULT.warnings.length ? RESULT.warnings.map(x => x.msg).join("；") : "无"}</div>
  <button class="noprint" onclick="print()">打印调整卡</button>
  </body></html>`);
  w.document.close();
}

function cardFilmSvg() {
  const gg = RESULT.ground_glass;
  if (!gg) return "";
  const VW = 300, VH = Math.round(VW * gg.film_h / gg.film_w), PAD = 10;
  const sc = Math.min((VW - 2 * PAD) / gg.film_w, 160 / gg.film_h);
  const W = gg.film_w * sc + 2 * PAD, H = gg.film_h * sc + 2 * PAD;
  const ox = PAD, oy = PAD;
  // 片上坐标 -> 卡片 SVG, 按毛玻璃倒像(上下左右翻转), 与现场看到的一致
  function M(s, t) {
    return [ox + (gg.film_w / 2 - s) * sc, oy + (gg.film_h / 2 - t) * sc];
  }
  let svg = `<svg width="${W}" height="${H}" style="border:1px solid #555;background:#111">`;
  svg += `<rect x="${ox}" y="${oy}" width="${gg.film_w * sc}" height="${gg.film_h * sc}"
    fill="none" stroke="#0a0" stroke-width="1.2"/>`;
  const km = Math.min(gg.keep_margin, gg.film_w / 2 - 1, gg.film_h / 2 - 1);
  svg += `<rect x="${ox + km * sc}" y="${oy + km * sc}"
    width="${(gg.film_w - 2 * km) * sc}" height="${(gg.film_h - 2 * km) * sc}"
    fill="none" stroke="#e8b04b" stroke-dasharray="4 3" stroke-width="1"/>`;
  if (gg.ic_ellipse) {
    const [cx, cy] = M(gg.ic_ellipse.cx, gg.ic_ellipse.cy);
    svg += `<ellipse cx="${cx}" cy="${cy}" rx="${gg.ic_ellipse.rx * sc}"
      ry="${gg.ic_ellipse.ry * sc}" fill="none" stroke="#4aa8ff" stroke-dasharray="3 3"
      transform="rotate(${gg.ic_ellipse.rot * 180 / Math.PI} ${cx} ${cy})"/>`;
  }
  for (const s of gg.subjects) {
    const col = s.must_keep ? "#e44" : "#f472b6";
    for (const seg of s.segs) {
      const a = M(seg[0][0], seg[0][1]), b = M(seg[1][0], seg[1][1]);
      svg += `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}"
        x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="${col}" stroke-width="1.5"/>`;
    }
  }
  return svg + "</svg>";
}

function cardSubjectTable() {
  const gg = RESULT.ground_glass;
  if (!gg || !gg.subjects.length) return "";
  const rows = gg.subjects.map(s => {
    const m = s.metrics || {};
    const parts = [];
    if (m.convergence != null) parts.push("汇聚 " + m.convergence.toFixed(1) + "°");
    if (m.h_tilt != null) parts.push("横斜 " + m.h_tilt.toFixed(1) + "°");
    if (m.keystone != null) parts.push("梯形 " + m.keystone.toFixed(1) + "%");
    if (m.mag_spread != null) parts.push("放大率差 " + m.mag_spread.toFixed(1) + "%");
    if (m.edge_margin != null) parts.push("余量 " + m.edge_margin.toFixed(1) + "mm");
    return `<b>${s.must_keep ? "🔒 " : ""}${s.name}</b>: ${parts.join(" · ") || "成像正常"}
      ${s.issues.length ? "<br><span style='color:#c33'>" +
        s.issues.map(i => i.msg).join("；") + "</span>" : ""}`;
  });
  return rows.join("<br><br>");
}

function degreeRuler(r, cam) {
  const lo = -cam.max_tilt, hi = cam.max_tilt;
  return rulerHtml(lo, hi, r.val, "°");
}
function linearRuler(r, cam) {
  const lim = r.name.includes("轨道") ? cam.rail_max : cam.max_rise;
  return rulerHtml(-lim, lim, r.val, "mm");
}
function rulerHtml(lo, hi, val, unit) {
  const pct = ((val - lo) / (hi - lo)) * 100;
  let marks = "";
  const N = 10;
  for (let i = 0; i <= N; i++) {
    const x = i * 10;
    const lab = Math.round(lo + (hi - lo) * i / N);
    marks += `<span style="left:${x}%">${lab}</span>`;
  }
  return `<div class="ruler">${marks}<i style="left:${pct}%"></i></div>`;
}

init();
