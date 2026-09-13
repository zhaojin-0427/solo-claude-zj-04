/* 曝光测算单 — 前端面板(原生 JS + SVG)
   依赖 app.js 全局: STATE, api, flash, el, escapeHtml, C, SUBJ_COLORS */
"use strict";

let EXP = {
  sheets: [],            // 测算单列表
  current: null,         // 当前单 {id,name,status,state,setup,result}
  presets: null,         // 快门档位表 + 倒易律预设
  recalcTimer: null,
  saveTimer: null,
  hiPoint: null,         // 警告定位: 高亮对焦点名
  hiTimer: null,
  scaleDrag: null,       // 刻度尺拖动 {kind:"aperture"|"shutter"}
  bound: false,
};

const EXP_STATUS = { draft: "草稿", confirmed: "已确认", shot: "已拍摄" };
const FULL_STOPS = [2, 2.8, 4, 5.6, 8, 11, 16, 22, 32, 45, 64, 90];

async function apiX(path, method, body) {
  const opt = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(path, opt);
  return r.json();
}

/* ---------------- 打开/关闭 ---------------- */
async function openExposure() {
  $("expOverlay").style.display = "flex";
  if (!EXP.presets) EXP.presets = await api("/api/exposure/presets");
  bindExpOnce();
  await loadExpSheets();
}

function closeExposure() {
  saveExpSheet();           // 关闭前落库草稿
  $("expOverlay").style.display = "none";
}

function bindExpOnce() {
  if (EXP.bound) return;
  EXP.bound = true;
  $("expClose").onclick = closeExposure;
  $("expNew").onclick = toggleNewPop;
  $("expConfirm").onclick = confirmSheet;
  $("expShoot").onclick = shootSheet;
  $("expDup").onclick = duplicateSheet;
  $("expDel").onclick = deleteSheet;
  $("expSheetSel").onchange = (e) => {
    const id = parseInt(e.target.value, 10);
    if (id) selectSheet(id);
  };
  // 锁定复选框
  $("lkAperture").onchange = (e) => {
    if (!editable()) { e.target.checked = EXP.current.setup.lock.aperture; return; }
    EXP.current.setup.lock.aperture = e.target.checked;
    if (e.target.checked && !EXP.current.setup.selection.shutter)
      EXP.current.setup.selection.shutter = EXP.current.result.selected.shutter;
    scheduleRecalc();
  };
  $("lkShutter").onchange = (e) => {
    if (!editable()) { e.target.checked = EXP.current.setup.lock.shutter; return; }
    EXP.current.setup.lock.shutter = e.target.checked;
    if (e.target.checked && !EXP.current.setup.selection.shutter)
      EXP.current.setup.selection.shutter = EXP.current.result.selected.shutter;
    scheduleRecalc();
  };
  // 刻度尺拖动
  for (const [id, kind] of [["apScale", "aperture"], ["shScale", "shutter"]]) {
    const svg = $(id);
    svg.addEventListener("pointerdown", (e) => {
      if (!editable() || !EXP.current || !EXP.current.result) return;
      if (kind === "aperture" && EXP.current.setup.lock.aperture) {
        flash("光圈已锁定"); return;
      }
      e.preventDefault();
      svg.setPointerCapture(e.pointerId);
      EXP.scaleDrag = { kind, svg };
      applyScaleDrag(e);
    });
    svg.addEventListener("pointermove", (e) => {
      if (EXP.scaleDrag && EXP.scaleDrag.svg === svg) applyScaleDrag(e);
    });
    svg.addEventListener("pointerup", () => { EXP.scaleDrag = null; });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("expOverlay").style.display !== "none") closeExposure();
  });
}

function editable() {
  return EXP.current && EXP.current.status === "draft";
}

/* ---------------- 测算单列表 ---------------- */
async function loadExpSheets(selectId) {
  EXP.sheets = await api("/api/exposure/sheets");
  const sel = $("expSheetSel");
  sel.innerHTML = "";
  if (!EXP.sheets.length) {
    sel.innerHTML = "<option value=''>（无测算单）</option>";
    EXP.current = null;
    renderExpHead(); renderExpForm(); renderExpResult();
    return;
  }
  for (const s of EXP.sheets) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = `#${s.id} ${s.name}（${s.status_label}）`;
    sel.appendChild(o);
  }
  const id = selectId || (EXP.current && EXP.current.id) || EXP.sheets[0].id;
  if (EXP.sheets.some(s => s.id === id)) await selectSheet(id);
  else await selectSheet(EXP.sheets[0].id);
}

async function selectSheet(id) {
  await saveExpSheet();
  const full = await apiX(`/api/exposure/sheets/${id}`, "GET");
  if (full.error) { flash(full.error); return; }
  EXP.current = full;
  EXP.hiPoint = null;
  $("expSheetSel").value = String(id);
  renderExpHead();
  renderExpForm();
  renderExpResult();
}

/* ---------------- 新建 / 复制 / 删除 / 状态流转 ---------------- */
async function toggleNewPop() {
  let pop = $("expNewPop");
  if (pop) { pop.remove(); return; }
  const plans = await api("/api/plans");
  pop = document.createElement("div");
  pop.id = "expNewPop";
  pop.className = "exp-newpop";
  pop.innerHTML = "<h3>选择建单来源（冻结片幅/焦距/光圈/位姿）</h3>";
  const addSrc = (label, sub, fn) => {
    const d = document.createElement("div");
    d.className = "planitem";
    d.innerHTML = `<div class="nm">${label}<br><small>${sub}</small></div><button>建单</button>`;
    d.querySelector("button").onclick = fn;
    pop.appendChild(d);
  };
  addSrc("✚ 当前工作台状态", "以主界面当前机位建单", async () => {
    const name = prompt("测算单名称：", "曝光单 " + new Date().toLocaleString());
    if (name == null) return;
    const r = await apiX("/api/exposure/sheets", "POST", { name, state: STATE });
    if (r.id) { pop.remove(); await loadExpSheets(r.id); flash("已建单 #" + r.id); }
  });
  for (const p of plans) {
    addSrc("方案 #" + p.id + " " + escapeHtml(p.name),
      new Date(p.updated_at * 1000).toLocaleString(), async () => {
        const name = prompt("测算单名称：", p.name + " 曝光");
        if (name == null) return;
        const r = await apiX("/api/exposure/sheets", "POST", { name, plan_id: p.id });
        if (r.error) { flash(r.error); return; }
        pop.remove(); await loadExpSheets(r.id); flash("已建单 #" + r.id);
      });
  }
  $("expOverlay").appendChild(pop);
}

async function confirmSheet() {
  const c = EXP.current;
  if (!c || c.status !== "draft") return;
  if (!confirm("确认测算单？确认后冻结来源方案、修正项与选定组合。")) return;
  const r = await apiX(`/api/exposure/sheets/${c.id}/confirm`, "POST", { setup: c.setup });
  if (r.error) { flash(r.error); return; }
  flash("已确认，组合与修正项已冻结");
  await loadExpSheets(c.id);
}

async function shootSheet() {
  const c = EXP.current;
  if (!c || c.status !== "confirmed") return;
  const r = await apiX(`/api/exposure/sheets/${c.id}/shoot`, "POST");
  if (r.error) { flash(r.error); return; }
  flash("已标记拍摄，测算单转为只读");
  await loadExpSheets(c.id);
}

async function duplicateSheet() {
  const c = EXP.current;
  if (!c) return;
  const r = await apiX(`/api/exposure/sheets/${c.id}/duplicate`, "POST");
  if (r.id) { await loadExpSheets(r.id); flash("已复制为新草稿 #" + r.id); }
}

async function deleteSheet() {
  const c = EXP.current;
  if (!c) return;
  if (!confirm(`删除测算单 #${c.id}「${c.name}」？`)) return;
  await apiX(`/api/exposure/sheets/${c.id}`, "DELETE");
  EXP.current = null;
  await loadExpSheets();
}

/* ---------------- 头部 ---------------- */
function renderExpHead() {
  const c = EXP.current;
  const st = $("expStatus");
  if (!c) {
    st.textContent = "";
    for (const id of ["expConfirm", "expShoot", "expDup", "expDel"]) $(id).style.display = "none";
    return;
  }
  st.textContent = EXP_STATUS[c.status] || c.status;
  st.className = "exp-status st-" + c.status;
  $("expConfirm").style.display = c.status === "draft" ? "" : "none";
  $("expShoot").style.display = c.status === "confirmed" ? "" : "none";
  $("expDup").style.display = "";
  $("expDel").style.display = "";
  $("lkAperture").checked = !!c.setup.lock.aperture;
  $("lkShutter").checked = !!c.setup.lock.shutter;
}

/* ---------------- 参数表单 ---------------- */
function renderExpForm() {
  const box = $("expForm");
  box.innerHTML = "";
  const c = EXP.current;
  if (!c) {
    box.innerHTML = '<div style="color:var(--dim);font-size:12px;padding:8px">点击「＋ 新建」从当前状态或方案库建单</div>';
    return;
  }
  const ro = !editable();
  const s = c.setup;
  const frozen = c.result ? c.result.frozen : null;
  const srcTxt = c.plan_id ? `方案 #${c.plan_id}` : "当前工作台状态";
  const fld = (label, inner, fldKey) =>
    `<div class="fld" ${fldKey ? `data-fld="${fldKey}"` : ""}><label>${label}</label>${inner}</div>`;
  const num = (key, val, step) =>
    `<input type="number" data-k="${key}" step="${step}" value="${val}" ${ro ? "disabled" : ""}>`;

  let h = `<div class="exp-fsec"><h3>测算单</h3>
    ${fld("名称", `<input type="text" data-k="__name" value="${escapeHtml(c.name)}" ${ro ? "disabled" : ""}>`)}
    <div class="exp-src">来源：${srcTxt} · 冻结 f/${frozen ? frozen.focal : "?"}mm
      ${frozen ? frozen.film_w + "×" + frozen.film_h : ""} · 基准光圈 f/${s.selection.aperture}</div></div>`;

  h += `<div class="exp-fsec"><h3>测光与胶片</h3>
    ${fld("测光模式", `<select data-k="meter.mode" ${ro ? "disabled" : ""}>
        <option value="ev" ${s.meter.mode === "ev" ? "selected" : ""}>EV 值（ISO100）</option>
        <option value="lux" ${s.meter.mode === "lux" ? "selected" : ""}>入射照度 lux</option></select>`)}
    ${fld(s.meter.mode === "lux" ? "照度 lux" : "测光 EV", num("meter.value", s.meter.value, 0.1))}
    ${fld("胶片 ISO", num("iso", s.iso, 50))}
    ${fld("滤镜倍率 ×", num("filter_factor", s.filter_factor, 0.5))}</div>`;

  h += `<div class="exp-fsec"><h3>光圈与快门</h3>
    ${fld("光圈步进", `<select data-k="f_step" ${ro ? "disabled" : ""}>
        <option value="0.3333333333333333" ${Math.abs(s.f_step - 1 / 3) < 1e-6 ? "selected" : ""}>1/3 档</option>
        <option value="0.5" ${Math.abs(s.f_step - 0.5) < 1e-6 ? "selected" : ""}>1/2 档</option>
        <option value="1" ${Math.abs(s.f_step - 1) < 1e-6 ? "selected" : ""}>1 整档</option></select>`)}
    <div class="grid2">
      ${fld("光圈最小", num("aperture_min", s.aperture_min, 0.1))}
      ${fld("光圈最大", num("aperture_max", s.aperture_max, 1))}
    </div>
    ${fld("最长曝光 s", num("max_exposure", s.max_exposure, 10), "max_exposure")}
    <div class="fld"><label>快门档位（点击启用/停用）</label>
      <div class="exp-shchips" data-fld="shutter">${EXP.presets.shutter_stops.map(([lab, t]) =>
        `<span class="exp-chip ${s.shutters.includes(t) ? "on" : ""}" data-t="${t}">${lab}</span>`).join("")}
      </div></div></div>`;

  h += `<div class="exp-fsec"><h3>倒易律曲线</h3>
    ${fld("胶片预设", `<select data-k="__preset" ${ro ? "disabled" : ""}>
        <option value="">自定义</option>${Object.entries(EXP.presets.recip_presets).map(([k, p]) =>
        `<option value="${k}" ${s.reciprocity.preset === k ? "selected" : ""}>${p.name}</option>`).join("")}</select>`)}
    ${fld("曲线点（每行：时间s 系数）", `<textarea data-k="__recip" rows="4" ${ro ? "disabled" : ""}>${
        s.reciprocity.points.map(p => `${p[0]} ${p[1]}`).join("\n")}</textarea>`, "recip")}</div>`;

  h += `<div class="exp-fsec"><h3>包围曝光</h3>
    <div class="grid2">
      ${fld("级数（每侧）", num("bracket.levels", s.bracket.levels, 1))}
      ${fld("级差 EV", num("bracket.step", s.bracket.step, 0.5))}
    </div></div>`;
  box.innerHTML = h;

  // ---- 事件 ----
  box.querySelectorAll("input[data-k],select[data-k],textarea[data-k]").forEach(inp => {
    inp.addEventListener("change", () => {
      const k = inp.dataset.k;
      if (k === "__name") { c.name = inp.value.trim() || c.name; scheduleSave(); loadExpSheetNames(); return; }
      if (k === "__preset") {
        const p = EXP.presets.recip_presets[inp.value];
        if (p) {
          s.reciprocity.preset = inp.value;
          s.reciprocity.points = p.points.map(q => q.slice());
          renderExpForm(); scheduleRecalc();
        }
        return;
      }
      if (k === "__recip") {
        const pts = [];
        for (const line of inp.value.split("\n")) {
          const m = line.trim().split(/[\s,]+/).map(parseFloat);
          if (m.length >= 2 && m[0] > 0 && m[1] >= 1) pts.push([m[0], m[1]]);
        }
        if (pts.length >= 2) {
          pts.sort((a, b) => a[0] - b[0]);
          s.reciprocity.points = pts;
          s.reciprocity.preset = "";
          scheduleRecalc();
        } else flash("曲线至少需要 2 个有效点（时间s 系数）");
        return;
      }
      const v = parseFloat(inp.value);
      if (isNaN(v)) return;
      if (k === "meter.mode") { s.meter.mode = inp.value; renderExpForm(); scheduleRecalc(); return; }
      if (k.startsWith("meter.")) s.meter.value = Math.max(0.001, v);
      else if (k.startsWith("bracket.")) {
        const kk = k.split(".")[1];
        s.bracket[kk] = kk === "levels" ? Math.max(0, Math.min(4, Math.round(v)))
                                        : Math.max(0.1, Math.min(4, v));
      }
      else if (k === "iso") s.iso = Math.max(1, v);
      else if (k === "filter_factor") s.filter_factor = Math.max(0.1, v);
      else if (k === "f_step") s.f_step = v;
      else if (k === "aperture_min") s.aperture_min = Math.max(1, v);
      else if (k === "aperture_max") s.aperture_max = Math.max(s.aperture_min, v);
      else if (k === "max_exposure") s.max_exposure = Math.max(0.01, v);
      scheduleRecalc();
    });
  });
  box.querySelectorAll(".exp-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      if (!editable()) return;
      const t = parseFloat(chip.dataset.t);
      const i = s.shutters.indexOf(t);
      if (i >= 0) {
        if (s.shutters.length <= 1) { flash("至少保留一个快门档位"); return; }
        s.shutters.splice(i, 1);
      } else {
        s.shutters.push(t);
        s.shutters.sort((a, b) => a - b);
      }
      chip.classList.toggle("on");
      scheduleRecalc();
    });
  });
}

async function loadExpSheetNames() {
  // 名称改动后同步下拉框显示
  const c = EXP.current;
  if (!c) return;
  const opt = $("expSheetSel").querySelector(`option[value="${c.id}"]`);
  if (opt) opt.textContent = `#${c.id} ${c.name}（${EXP_STATUS[c.status]}）`;
}

/* ---------------- 试算 ---------------- */
function scheduleRecalc() {
  clearTimeout(EXP.recalcTimer);
  EXP.recalcTimer = setTimeout(recalcExp, 120);
  scheduleSave();
}

async function recalcExp() {
  const c = EXP.current;
  if (!c || c.status !== "draft") { renderExpResult(); return; }
  const out = await apiX("/api/exposure/calc", "POST", { state: c.state, setup: c.setup });
  if (EXP.current !== c) return;
  if (out.error) { flash(out.error); return; }
  c.result = out;
  renderExpResult();
}

function scheduleSave() {
  if (!editable()) return;
  clearTimeout(EXP.saveTimer);
  EXP.saveTimer = setTimeout(saveExpSheet, 700);
}

async function saveExpSheet() {
  const c = EXP.current;
  if (!c || c.status !== "draft") return;
  clearTimeout(EXP.saveTimer);
  await apiX(`/api/exposure/sheets/${c.id}`, "PUT", { name: c.name, setup: c.setup });
}

/* ---------------- 结果渲染 ---------------- */
function renderExpResult() {
  const c = EXP.current;
  const has = c && c.result;
  for (const id of ["expChain", "expCombos", "expBrackets", "expWarns"])
    $(id).innerHTML = has ? "" : '<div style="color:var(--dim);font-size:11px">—</div>';
  for (const id of ["apScale", "shScale", "expTimeline", "expWedge", "expGG"])
    $(id).innerHTML = "";
  if (!has) return;
  renderExpChain();
  drawApertureScale();
  drawShutterScale();
  drawTimeline();
  drawWedge();
  drawMiniGG();
  renderCombos();
  renderBrackets();
  renderExpWarnings();
}

function fmtT(t) {
  if (t == null) return "–";
  if (t >= 60) return (t / 60).toFixed(1) + "min";
  if (t >= 1) return t.toFixed(t >= 10 ? 0 : 1) + "s";
  return "1/" + Math.round(1 / t) + "s";
}

function renderExpChain() {
  const r = EXP.current.result;
  const f = r.factors, sel = r.selected;
  const evCls = Math.abs(sel.ev_err) > 0.3 ? "badval" : Math.abs(sel.ev_err) > 0.1 ? "warnval" : "goodval";
  $("expChain").innerHTML = `
    <div class="exp-cell"><span>皮腔伸长</span><b>${f.extension.toFixed(0)}mm</b>
      <em>放大率 ${f.magnification.toFixed(2)}×</em></div>
    <div class="exp-cell"><span>皮腔补偿</span><b>×${f.bellows.toFixed(2)}</b>
      <em>${f.bellows_ev >= 0 ? "+" : ""}${f.bellows_ev.toFixed(2)} EV</em></div>
    <div class="exp-cell"><span>滤镜</span><b>×${f.filter.toFixed(1)}</b>
      <em>${f.filter_ev >= 0 ? "+" : ""}${f.filter_ev.toFixed(2)} EV</em></div>
    <div class="exp-cell"><span>倒易律</span><b>×${f.recip_factor.toFixed(2)}</b>
      <em>+${f.recip_ev.toFixed(2)} EV</em></div>
    <div class="exp-cell exp-sel"><span>选定组合</span>
      <b>f/${sel.aperture.toFixed(1)} · ${sel.shutter_label}</b>
      <em class="${evCls}">偏差 ${sel.ev_err >= 0 ? "+" : ""}${sel.ev_err.toFixed(2)} EV
        ${sel.mode === "lock_shutter" ? "· 锁快门" : sel.mode === "manual" ? "· 手动" : ""}</em></div>
    <div class="exp-cell"><span>总曝光</span><b>${fmtT(sel.t_actual)}</b>
      <em>测光 ${fmtT(sel.t_meter)}</em></div>`;
}

/* ---------------- 刻度尺 ---------------- */
function scaleX(i, n, W, padL, padR) {
  return padL + i * (W - padL - padR) / Math.max(1, n - 1);
}

function drawApertureScale() {
  const svg = $("apScale");
  const c = EXP.current, r = c.result;
  const padL = 36, padR = 16, VW = 640;
  const grid = r.combos.map(x => x.aperture);
  const N0 = r.frozen.aperture;
  const step = r.setup.f_step;
  const aMin = r.setup.aperture_min;
  // 档位按步进 log 等距, 任意值用 log 插值定位
  const xOfVal = (N) => padL + (Math.log2(N / aMin) / (step / 2)) *
    (VW - padL - padR) / Math.max(1, grid.length - 1);

  const base = 44;
  el("line", { x1: padL - 8, y1: base, x2: VW - padR + 4, y2: base, stroke: "#3a414e", "stroke-width": 1.5 }, svg);
  grid.forEach((N, i) => {
    const x = scaleX(i, grid.length, VW, padL, padR);
    const full = FULL_STOPS.some(g => Math.abs(g - N) / g < 0.02);
    el("line", { x1: x, y1: base, x2: x, y2: base - (full ? 14 : 8),
      stroke: full ? "#8a93a6" : "#4a5262", "stroke-width": full ? 1.6 : 1 }, svg);
    if (full) {
      const t = el("text", { x, y: base - 20, fill: "#97a0b0", "font-size": 10, "text-anchor": "middle" }, svg);
      t.textContent = "f/" + (Math.round(N * 10) / 10);
    }
  });
  // 冻结光圈(方案)标记
  const xf = xOfVal(N0);
  el("polygon", { points: `${xf},6 ${xf - 5},14 ${xf + 5},14`, fill: "#e8b04b" }, svg);
  const tf = el("text", { x: xf, y: 4, fill: "#e8b04b", "font-size": 9, "text-anchor": "middle" }, svg);
  tf.textContent = "方案";
  // 锁定快门时: 精确光圈虚线
  const sel = r.selected;
  if (sel.mode === "lock_shutter" && Math.abs(sel.aperture_exact - sel.aperture) > 0.02) {
    const xe = xOfVal(sel.aperture_exact);
    el("line", { x1: xe, y1: 16, x2: xe, y2: base + 12, stroke: "#e879f9",
      "stroke-width": 1, "stroke-dasharray": "3 3" }, svg);
    const te = el("text", { x: xe, y: base + 24, fill: "#e879f9", "font-size": 9, "text-anchor": "middle" }, svg);
    te.textContent = "需 f/" + sel.aperture_exact.toFixed(1);
  }
  // 当前指针
  const xs = xOfVal(sel.aperture);
  const locked = c.setup.lock.aperture;
  el("line", { x1: xs, y1: 16, x2: xs, y2: base + 4, stroke: locked ? "#e8b04b" : "#fff", "stroke-width": 2 }, svg);
  el("polygon", { points: `${xs},${base + 6} ${xs - 6},${base + 16} ${xs + 6},${base + 16}`,
    fill: locked ? "#e8b04b" : "#fff" }, svg);
  const ts = el("text", { x: xs, y: base + 28, fill: locked ? "#e8b04b" : "#fff",
    "font-size": 11, "text-anchor": "middle", "font-weight": "600" }, svg);
  ts.textContent = "f/" + sel.aperture.toFixed(1) + (locked ? " 🔒" : "");
}

function drawShutterScale() {
  const svg = $("shScale");
  const c = EXP.current, r = c.result;
  const VW = 640, padL = 36, padR = 16, base = 44;
  const sh = r.setup.shutters;
  const lmin = Math.log2(sh[0]), lmax = Math.log2(sh[sh.length - 1]);
  const xOf = (t) => padL + (Math.log2(t) - lmin) / Math.max(1e-9, lmax - lmin) * (VW - padL - padR);
  el("line", { x1: padL - 8, y1: base, x2: VW - padR + 4, y2: base, stroke: "#3a414e", "stroke-width": 1.5 }, svg);
  sh.forEach((t) => {
    const x = xOf(t);
    el("line", { x1: x, y1: base, x2: x, y2: base - 10, stroke: "#8a93a6", "stroke-width": 1.2 }, svg);
    const lab = el("text", { x, y: base - 16, fill: "#97a0b0", "font-size": 9, "text-anchor": "middle" }, svg);
    lab.textContent = t >= 1 ? (t + "s") : ("1/" + Math.round(1 / t));
  });
  // 最长曝光红线
  const mx = r.setup.max_exposure;
  if (mx >= sh[0] && mx <= sh[sh.length - 1] * 2) {
    const xm = Math.min(xOf(mx), VW - padR);
    el("line", { x1: xm, y1: 10, x2: xm, y2: base + 12, stroke: "#ef6a5e", "stroke-width": 1.5, "stroke-dasharray": "4 2" }, svg);
    const tm = el("text", { x: xm, y: 8, fill: "#ef6a5e", "font-size": 9, "text-anchor": "middle" }, svg);
    tm.textContent = "最长 " + fmtT(mx);
  }
  const sel = r.selected;
  // 需要的时间(锁定快门/手动组合时显示)
  if (sel.mode !== "lock_aperture") {
    const xn = padL + (Math.log2(Math.max(sh[0], Math.min(sh[sh.length - 1], sel.t_actual))) - lmin) /
      Math.max(1e-9, lmax - lmin) * (VW - padL - padR);
    el("line", { x1: xn, y1: 16, x2: xn, y2: base + 10, stroke: "#4cc38a", "stroke-width": 1, "stroke-dasharray": "3 3" }, svg);
    const tn = el("text", { x: xn, y: base + 22, fill: "#4cc38a", "font-size": 9, "text-anchor": "middle" }, svg);
    tn.textContent = "需 " + fmtT(sel.t_actual);
  }
  // 当前指针
  const xs = xOf(Math.max(sh[0], Math.min(sh[sh.length - 1], sel.shutter)));
  const locked = c.setup.lock.shutter;
  el("line", { x1: xs, y1: 16, x2: xs, y2: base + 4, stroke: locked ? "#e8b04b" : "#fff", "stroke-width": 2 }, svg);
  el("polygon", { points: `${xs},${base + 6} ${xs - 6},${base + 16} ${xs + 6},${base + 16}`,
    fill: locked ? "#e8b04b" : "#fff" }, svg);
  const ts = el("text", { x: xs, y: base + 28, fill: locked ? "#e8b04b" : "#fff",
    "font-size": 11, "text-anchor": "middle", "font-weight": "600" }, svg);
  ts.textContent = sel.shutter_label + (locked ? " 🔒" : "");
}

function applyScaleDrag(e) {
  const c = EXP.current, r = c.result, d = EXP.scaleDrag;
  const rect = d.svg.getBoundingClientRect();
  const vx = (e.clientX - rect.left) / rect.width * 640;
  const padL = 36, padR = 16, VW = 640;
  if (d.kind === "aperture") {
    const grid = r.combos.map(x => x.aperture);
    const k = (vx - padL) / (VW - padL - padR) * (grid.length - 1);
    const i = Math.max(0, Math.min(grid.length - 1, Math.round(k)));
    c.setup.selection.aperture = grid[i];
    c.setup.lock.shutter = false;          // 拖光圈 = 解除快门锁定
    $("lkShutter").checked = false;
  } else {
    const sh = r.setup.shutters;
    const lmin = Math.log2(sh[0]), lmax = Math.log2(sh[sh.length - 1]);
    const lt = lmin + (vx - padL) / (VW - padL - padR) * (lmax - lmin);
    const t = Math.pow(2, lt);
    const best = sh.reduce((a, b) => Math.abs(Math.log2(b / t)) < Math.abs(Math.log2(a / t)) ? b : a);
    c.setup.selection.shutter = best;
    if (!c.setup.lock.aperture) {
      c.setup.lock.shutter = true;         // 拖快门 = 锁定快门反算光圈
      $("lkShutter").checked = true;
    }
  }
  scheduleRecalc();
}

/* ---------------- 曝光时间轴 ---------------- */
function drawTimeline() {
  const svg = $("expTimeline");
  const r = EXP.current.result;
  const sel = r.selected, s = r.setup;
  const VW = 640, VH = 96, padL = 40, padR = 20, base = 58;
  const tmin = Math.max(1e-4, Math.min(s.shutters[0], sel.t_meter) / 2);
  const tmax = Math.min(1e5, Math.max(s.shutters[s.shutters.length - 1], sel.t_actual, s.max_exposure) * 2);
  const l0 = Math.log10(tmin), l1 = Math.log10(tmax);
  const xOf = (t) => padL + (Math.log10(Math.max(tmin, Math.min(tmax, t))) - l0) / (l1 - l0) * (VW - padL - padR);

  el("line", { x1: padL - 10, y1: base, x2: VW - padR + 6, y2: base, stroke: "#3a414e", "stroke-width": 1.5 }, svg);
  // 10 幂刻度
  for (let e = Math.ceil(l0); e <= Math.floor(l1); e++) {
    const x = xOf(Math.pow(10, e));
    el("line", { x1: x, y1: base, x2: x, y2: base - 8, stroke: "#4a5262", "stroke-width": 1 }, svg);
    const lab = el("text", { x, y: base + 12, fill: "#6b7484", "font-size": 9, "text-anchor": "middle" }, svg);
    lab.textContent = e >= 0 ? (Math.pow(10, e) + "s") : ("1/" + Math.pow(10, -e) + "s");
  }
  // 快门档位小刻度
  for (const t of s.shutters) {
    const x = xOf(t);
    el("line", { x1: x, y1: base, x2: x, y2: base - 4, stroke: "#3a414e", "stroke-width": 1 }, svg);
  }
  // 倒易律修正区段
  const xa = xOf(sel.t_target), xb = xOf(sel.t_actual);
  if (xb - xa > 1)
    el("rect", { x: xa, y: base - 6, width: xb - xa, height: 6, fill: "rgba(76,195,138,.25)" }, svg);
  // 包围点
  for (const b of r.brackets) {
    if (b.ev === 0) continue;
    const x = xOf(b.t_actual);
    el("circle", { cx: x, cy: base, r: 3, fill: b.in_range && !b.over_max ? "#c084fc" : "#ef6a5e" }, svg);
  }
  // 最长曝光
  const xm = xOf(s.max_exposure);
  el("line", { x1: xm, y1: 14, x2: xm, y2: base, stroke: "#ef6a5e", "stroke-width": 1.5, "stroke-dasharray": "4 2" }, svg);
  const tm = el("text", { x: xm, y: 12, fill: "#ef6a5e", "font-size": 9, "text-anchor": "middle" }, svg);
  tm.textContent = "最长";
  // 三个里程碑
  const marks = [
    [sel.t_meter, "#4aa8ff", "测光", fmtT(sel.t_meter)],
    [sel.t_target, "#e8b04b", "皮腔+滤镜", fmtT(sel.t_target)],
    [sel.t_actual, "#4cc38a", "实际(倒易律)", fmtT(sel.t_actual)],
  ];
  marks.forEach(([t, col, lab, val], i) => {
    const x = xOf(t);
    const y = 34 - i * 0;   // 同一高度, 标签错列由文本宽度自然分开
    el("line", { x1: x, y1: 18, x2: x, y2: base - 6, stroke: col, "stroke-width": 1.6 }, svg);
    el("polygon", { points: `${x},${base - 8} ${x - 4},${base - 2} ${x + 4},${base - 2}`, fill: col }, svg);
    const tx = el("text", { x, y: 14 + (i === 1 ? 0 : 0), fill: col, "font-size": 9, "text-anchor": "middle" }, svg);
    tx.textContent = `${lab} ${val}`;
  });
  // 选定快门
  const xs = xOf(sel.shutter);
  el("polygon", { points: `${xs},${base + 16} ${xs - 5},${base + 24} ${xs + 5},${base + 24}`, fill: "#fff" }, svg);
  const tsl = el("text", { x: xs, y: base + 34, fill: "#fff", "font-size": 10, "text-anchor": "middle", "font-weight": "600" }, svg);
  tsl.textContent = "▲ " + sel.shutter_label;
}

/* ---------------- 景深楔形图 ---------------- */
function drawWedge() {
  const svg = $("expWedge");
  const r = EXP.current.result;
  const v = r.geometry.views_side;
  const VW = 640, VH = 240, PAD = 24;
  const win = v.win;
  const sc = Math.min((VW - 2 * PAD) / (win.xmax - win.xmin), (VH - 2 * PAD) / (win.zmax - win.zmin));
  const ox = PAD + ((VW - 2 * PAD) - (win.xmax - win.xmin) * sc) / 2;
  const oy = PAD + ((VH - 2 * PAD) - (win.zmax - win.zmin) * sc) / 2;
  const X = (x) => ox + (x - win.xmin) * sc;
  const Z = (z) => VH - (oy + (z - win.zmin) * sc);
  const P = (p) => [X(p.x), Z(p.z)];

  el("rect", { x: 0, y: 0, width: VW, height: VH, fill: "#0d1015" }, svg);
  // 楔形填充
  if (v.subject_line && v.wedges && v.wedges.length === 2 && v.wedges.every(w => w.line)) {
    const [a, b] = v.wedges.map(w => w.line);
    const pts = [P(a[0]), P(a[1]), P(b[1]), P(b[0])].map(q => q.join(",")).join(" ");
    el("polygon", { points: pts, fill: "rgba(76,195,138,.12)", stroke: "none" }, svg);
  }
  for (const w of v.wedges || []) {
    if (!w.line) continue;
    const [p1, p2] = w.line.map(P);
    el("line", { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
      stroke: "#2f6f4f", "stroke-width": 1, "stroke-dasharray": "5 4" }, svg);
  }
  if (v.subject_line) {
    const [p1, p2] = v.subject_line.map(P);
    el("line", { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], stroke: "#4cc38a", "stroke-width": 2 }, svg);
  }
  // 皮腔 + 前后组
  if (v.bellows)
    el("polygon", { points: v.bellows.map(p => P(p).join(",")).join(" "),
      fill: "rgba(120,120,130,.10)", stroke: "#6b7484", "stroke-width": 1, "stroke-dasharray": "3 3" }, svg);
  for (const [std, col, nm] of [[v.rear, "#6ea8fe", "后组"], [v.front, "#ffb454", "前组"]]) {
    const [p1, p2] = std.seg.map(P);
    el("line", { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], stroke: col, "stroke-width": 4, "stroke-linecap": "round" }, svg);
  }
  // 对焦点
  const coc = EXP.current.result.frozen.coc;
  (r.geometry.points || []).forEach((p) => {
    if (p.kind !== "focus") return;
    const [px, py] = P({ x: p.world[0], z: p.world[2] });
    const bad = p.blur != null && p.blur > coc;
    const hi = EXP.hiPoint === p.name;
    el("circle", { cx: px, cy: py, r: hi ? 8 : 5, fill: bad ? "#ef6a5e" : "#4cc38a",
      stroke: hi ? "#fff" : "#0d0f13", "stroke-width": hi ? 2.5 : 1.5,
      style: hi ? "filter:drop-shadow(0 0 6px #fff)" : "" }, svg);
    const t = el("text", { x: px + 9, y: py - 6, fill: bad ? "#ef6a5e" : "#4cc38a", "font-size": 10 }, svg);
    t.textContent = p.name + (p.blur != null ? ` ${p.blur.toFixed(2)}` : "");
  });
  // 标注
  const info = el("text", { x: 8, y: 14, fill: "#97a0b0", "font-size": 10 }, svg);
  info.textContent = `f/${r.selected.aperture.toFixed(1)} · 有效 f/${r.geometry.f_number_eff.toFixed(1)} · 最大模糊圆 ${r.geometry.max_blur.toFixed(3)}mm（容许 ${coc}）`;
}

/* ---------------- 小毛玻璃 ---------------- */
function drawMiniGG() {
  const svg = $("expGG");
  const r = EXP.current.result;
  const gg = r.geometry.ground_glass;
  if (!gg) return;
  const VW = 300, VH = 250, PAD = 16;
  const w = gg.film_w, h = gg.film_h;
  const sc = Math.min((VW - 2 * PAD) / w, (VH - 2 * PAD) / h);
  const ox = (VW - w * sc) / 2, oy = (VH - h * sc) / 2;
  // 毛玻璃倒像(与主界面一致)
  const M = (s, t) => [ox + (w / 2 - s) * sc, oy + (h / 2 - t) * sc];
  el("rect", { x: 0, y: 0, width: VW, height: VH, fill: "#0b0e12" }, svg);
  el("rect", { x: ox, y: oy, width: w * sc, height: h * sc, fill: "#151a21", stroke: "#8a93a6", "stroke-width": 1.2 }, svg);
  const m = Math.min(gg.keep_margin, w / 2 - 1, h / 2 - 1);
  el("rect", { x: ox + m * sc, y: oy + m * sc, width: (w - 2 * m) * sc, height: (h - 2 * m) * sc,
    fill: "none", stroke: "#e8b04b", "stroke-width": 0.8, "stroke-dasharray": "4 3" }, svg);
  if (gg.ic_ellipse) {
    const [cx, cy] = M(gg.ic_ellipse.cx, gg.ic_ellipse.cy);
    el("ellipse", { cx, cy, rx: gg.ic_ellipse.rx * sc, ry: gg.ic_ellipse.ry * sc,
      fill: "rgba(74,168,255,0.05)", stroke: "rgba(74,168,255,0.6)", "stroke-width": 0.8,
      "stroke-dasharray": "3 3",
      transform: `rotate(${-gg.ic_ellipse.rot * 180 / Math.PI} ${cx} ${cy})` }, svg);
  }
  for (const s of gg.subjects || []) {
    const col = s.must_keep ? "#ef6a5e" : (SUBJ_COLORS[s.type] || "#f472b6");
    for (const seg of s.segs || []) {
      const a = M(seg[0][0], seg[0][1]), b = M(seg[1][0], seg[1][1]);
      el("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: col, "stroke-width": 1.3,
        "stroke-dasharray": s.clipped ? "4 2" : "none" }, svg);
    }
  }
  const coc = r.frozen.coc;
  for (const p of r.geometry.points || []) {
    if (p.s == null || p.t == null) continue;
    const [x, y] = M(p.s, p.t);
    if (x < 0 || x > VW || y < 0 || y > VH) continue;
    const bad = p.kind === "focus" && p.blur != null && p.blur > coc;
    const hi = EXP.hiPoint === p.name;
    el("circle", { cx: x, cy: y, r: hi ? 5 : 2.6,
      fill: p.kind === "focus" ? (bad ? "#ef6a5e" : "rgba(76,195,138,.9)") : "rgba(74,168,255,.85)",
      stroke: hi ? "#fff" : "none", "stroke-width": 1.5,
      style: hi ? "filter:drop-shadow(0 0 5px #fff)" : "" }, svg);
  }
  const tag = el("text", { x: ox, y: VH - 4, fill: "#6b7484", "font-size": 8 }, svg);
  tag.textContent = `${w}×${h}mm · 倒像 · f/${r.selected.aperture.toFixed(1)}`;
}

/* ---------------- 等效组合 / 包围 / 警告 ---------------- */
function renderCombos() {
  const box = $("expCombos");
  const r = EXP.current.result;
  const selAp = r.selected.aperture;
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "exp-crow exp-chead";
  head.innerHTML = "<span>光圈</span><span>实际时间</span><span>快门</span><span>偏差</span><span>模糊圆</span><span></span>";
  box.appendChild(head);
  for (const cb of r.combos) {
    const row = document.createElement("div");
    row.className = "exp-crow" + (Math.abs(cb.aperture - selAp) < 0.01 ? " sel" : "") +
      (cb.ok ? "" : cb.issues.some(i => i.code === "dof") ? " bad" : " warn");
    const evCls = Math.abs(cb.ev_err) > 0.3 ? "badval" : "goodval";
    row.innerHTML = `
      <span>f/${cb.aperture}${cb.is_frozen ? ' <em class="exp-frz">方案</em>' : ""}</span>
      <span>${fmtT(cb.t_actual)}</span>
      <span>${cb.shutter_label}</span>
      <span class="${evCls}">${cb.ev_err >= 0 ? "+" : ""}${cb.ev_err.toFixed(2)}</span>
      <span class="${cb.max_blur > r.frozen.coc ? "badval" : ""}">${cb.max_blur.toFixed(2)}</span>
      <span title="${cb.issues.map(i => escapeHtml(i.msg)).join("\n") || "可用"}">${cb.ok ? "✓" : "⚠"}</span>`;
    row.title = cb.issues.map(i => i.msg).join("\n") || "点击选用该组合";
    row.onclick = () => {
      if (!editable()) return;
      EXP.current.setup.selection.aperture = cb.aperture;
      EXP.current.setup.lock.shutter = false;
      $("lkShutter").checked = false;
      scheduleRecalc();
    };
    box.appendChild(row);
  }
}

function renderBrackets() {
  const box = $("expBrackets");
  const r = EXP.current.result;
  box.innerHTML = "";
  if (!r.brackets.length) { box.innerHTML = '<div style="color:var(--dim);font-size:11px">未设置包围</div>'; return; }
  for (const b of r.brackets) {
    const row = document.createElement("div");
    const bad = !b.in_range || b.over_max || !b.recip_inside;
    row.className = "exp-brow" + (b.ev === 0 ? " base" : "") + (bad ? " bad" : "");
    row.innerHTML = `<span class="exp-bev">${b.label}</span>
      <span>${fmtT(b.t_actual)}</span><span>→ ${b.shutter_label}</span>
      <span>${bad ? (!b.in_range ? "超快门范围" : b.over_max ? "超最长曝光" : "超倒易律曲线") : ""}</span>`;
    box.appendChild(row);
  }
}

function renderExpWarnings() {
  const box = $("expWarns");
  const r = EXP.current.result;
  box.innerHTML = "";
  if (!r.warnings.length) {
    box.innerHTML = '<div style="color:var(--good);font-size:12px;padding:4px">✓ 曝光检查全部通过</div>';
    return;
  }
  for (const w of r.warnings) {
    const d = document.createElement("div");
    d.className = "warnitem warn";
    d.innerHTML = `${escapeHtml(w.msg)}<span class="part">${({shutter: "快门", aperture: "光圈", reciprocity: "倒易律", max_exposure: "最长曝光"})[w.param] || w.param}${w.point ? " · " + escapeHtml(w.point) : ""}</span>`;
    d.onclick = () => locateExpIssue(w);
    box.appendChild(d);
  }
}

function locateExpIssue(w) {
  // 定位参数: 高亮对应刻度尺/表单控件
  const map = { shutter: "shScale", aperture: "apScale", max_exposure: null, reciprocity: null };
  const svgId = map[w.param];
  if (svgId) {
    const node = $(svgId);
    node.classList.add("exp-hi");
    setTimeout(() => node.classList.remove("exp-hi"), 2000);
  }
  const fld = document.querySelector(`#expForm [data-fld="${w.param}"]`) ||
    document.querySelector(`#expForm [data-fld="recip"]`);
  if ((w.param === "reciprocity" || w.param === "max_exposure") && fld) {
    fld.classList.add("exp-hi");
    fld.scrollIntoView({ block: "nearest" });
    setTimeout(() => fld.classList.remove("exp-hi"), 2000);
  }
  // 定位对焦点: 楔形图/毛玻璃闪烁
  if (w.point) {
    EXP.hiPoint = w.point;
    drawWedge(); drawMiniGG();
    clearTimeout(EXP.hiTimer);
    EXP.hiTimer = setTimeout(() => { EXP.hiPoint = null; drawWedge(); drawMiniGG(); }, 2400);
  }
}
