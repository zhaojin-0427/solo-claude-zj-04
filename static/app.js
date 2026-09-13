/* 大画幅移轴对焦工作台 — 前端逻辑(原生 JS + SVG) */
"use strict";

let STATE = null;
let RESULT = null;
let activeTab = "rear";
let compareCandidates = [];   // 叠加比较的候选
let searchCandidates = [];
let flashTimer = null;

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
  bindInputs();
  bindLocks();
  bindPoints();
  bindViews();
  bindHeader();
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
  renderMetrics();
  renderWarnings();
  renderPoints();
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
  const meet = Math.min(rect.width / W, rect.height / H);
  const sc = Math.min((W - 2 * PAD) / (xmax - xmin), (H - 2 * PAD) / (vmax - vmin));
  const ox = PAD + ((W - 2 * PAD) - (xmax - xmin) * sc) / 2;
  const oy = PAD + ((H - 2 * PAD) - (vmax - vmin) * sc) / 2;
  return { xmin, vmin, ox, oy, sc, meet, pxPerUnit: meet * sc };
}

function screenToWorld(svgEl, kind, cx, cy) {
  const rect = svgEl.getBoundingClientRect();
  const T = viewTransform(kind, rect);
  const vx = (cx - rect.left) / T.meet;
  const vy = (cy - rect.top) / T.meet;
  const x = T.xmin + (vx - T.ox) / T.sc;
  const v = T.vmin + (600 - vy - T.oy) / T.sc;
  return { x, v };
}

function startDrag(e) {
  const t = e.target.closest("[data-drag]");
  if (!t) return;
  e.preventDefault();
  const svg = e.currentTarget;
  const kind = svg.id === "sideSvg" ? "side" : "top";
  drag = {
    type: t.dataset.drag, which: t.dataset.which, kind, svg,
    lastX: e.clientX, lastY: e.clientY,
    orig: JSON.parse(JSON.stringify(STATE.pose)),
    pointIndex: t.dataset.i != null ? parseInt(t.dataset.i, 10) : null,
  };
  svg.setPointerCapture(e.pointerId);
}

let dragScheduled = false;
async function moveDrag(e) {
  if (!drag) return;
  if (dragScheduled) return;
  dragScheduled = true;
  requestAnimationFrame(async () => {
    dragScheduled = false;
    const dxPx = e.clientX - drag.lastX;
    const dyPx = e.clientY - drag.lastY;
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    if (drag.type === "point") {
      const w = screenToWorld(drag.svg, drag.kind, e.clientX, e.clientY);
      const p = STATE.points[drag.pointIndex];
      if (p) {
        p.x = Math.max(1, w.x);
        if (drag.kind === "side") p.z = w.v; else p.y = w.v;
      }
    } else if (drag.type === "standard") {
      applyStandardDrag(e, dxPx, dyPx);
    }
    await recompute(true);
  });
}

// 增量拖拽: 水平像素 -> 轨道; 垂直像素 -> 倾角(0.15°/px); Shift+垂直 -> 升降/平移
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
  if (drag && drag.type === "standard" && STATE.pose.focus_mode === "manual"
      && $("autoFocus").checked) {
    STATE.pose.focus_mode = "auto";
    recompute(true);
  }
  drag = null;
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
    d.onclick = () => locatePart(w.part);
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
  })[part] || part;
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
        <b>#${i + 1} 模糊 ${c.max_blur.toFixed(3)} mm</b>
        <span class="${c.hard_warn ? "badval" : "goodval"}">${c.hard_warn ? "有硬警告" : "可行"}</span>
      </div>
      <div class="candvals">
        像场余量 ${c.ic_margin.toFixed(0)} mm · 调整量 ${c.cost.toFixed(0)}
        · 伸长 ${c.extension.toFixed(0)}<br>
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
    div.innerHTML = `<div class="nm">${escapeHtml(p.name)}
      <br><small>${new Date(p.updated_at * 1000).toLocaleString()} ·
      伸长 ${p.brief ? p.brief.extension.toFixed(0) : "?"} mm ·
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
    像场余量 <b>${RESULT.ic_min_margin.toFixed(1)} mm</b>
  </div>
  <div class="sub">警告: ${RESULT.warnings.length ? RESULT.warnings.map(x => x.msg).join("；") : "无"}</div>
  <button class="noprint" onclick="print()">打印调整卡</button>
  </body></html>`);
  w.document.close();
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
