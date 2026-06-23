// n8n-style visual flow builder. Self-contained; talks to /api/flows.
(function () {
  const $ = (id) => document.getElementById(id);
  const NODE_META = {
    trigger:  { icon: "⚡", label: "Trigger", color: "#25d366" },
    message:  { icon: "💬", label: "Message", color: "#58a6ff" },
    menu:     { icon: "📋", label: "Menu",    color: "#e3b341" },
    question: { icon: "❓", label: "Question", color: "#1d9e75" },
    end:      { icon: "🏁", label: "End",     color: "#8b949e" },
  };

  let flows = [];
  let cur = 0;          // current flow index
  let selected = null;  // selected node id
  let dirty = false;
  let drag = null;      // active node drag
  let conn = null;      // active connection drag

  const flow = () => flows[cur];
  const uid = (p) => p + "_" + Math.random().toString(36).slice(2, 7);
  const markDirty = () => { dirty = true; $("fbMsg").textContent = "unsaved changes"; };

  async function load() {
    try {
      const data = await fetch("/api/flows").then((r) => r.json());
      flows = (data.flows || []).map(normalize);
      if (!flows.length) flows = [blankFlow()];
      cur = 0;
      renderAll();
    } catch (e) { /* dashboard may not be on this tab yet */ }
  }

  function normalize(f) {
    f.nodes = f.nodes || [];
    f.edges = f.edges || [];
    f.trigger = f.trigger || { keywords: [], match: "contains" };
    if (!f.nodes.some((n) => n.type === "trigger"))
      f.nodes.unshift({ id: "trigger", type: "trigger", x: 40, y: 160, data: {} });
    return f;
  }
  function blankFlow() {
    return normalize({ id: uid("flow"), name: "New flow", enabled: true, trigger: { keywords: ["hi"], match: "contains" },
      nodes: [{ id: "trigger", type: "trigger", x: 40, y: 160, data: {} }], edges: [] });
  }

  function renderAll() {
    const sel = $("fbSelect");
    sel.innerHTML = flows.map((f, i) => `<option value="${i}" ${i === cur ? "selected" : ""}>${esc(f.name || "flow")}</option>`).join("");
    $("fbName").value = flow().name || "";
    $("fbEnabled").checked = flow().enabled !== false;
    $("fbKeywords").value = (flow().trigger.keywords || []).join(", ");
    renderCanvas();
    renderEditor();
  }

  function renderCanvas() {
    const canvas = $("fbCanvas");
    canvas.querySelectorAll(".fb-node").forEach((n) => n.remove());
    for (const n of flow().nodes) canvas.appendChild(nodeEl(n));
    renderEdges();
  }

  function nodeEl(n) {
    const m = NODE_META[n.type];
    const el = document.createElement("div");
    el.className = "fb-node" + (selected === n.id ? " sel" : "");
    el.style.left = n.x + "px"; el.style.top = n.y + "px";
    el.dataset.node = n.id;
    const ports = outPorts(n);
    el.innerHTML =
      `<div class="fb-head" style="background:${m.color}22;border-color:${m.color}55">
         <span>${m.icon} ${m.label}</span>
         ${n.type !== "trigger" ? `<span class="fb-del" data-del="${n.id}">✕</span>` : ""}
       </div>
       <div class="fb-body">${esc(summary(n))}</div>
       ${n.type !== "trigger" ? `<span class="fb-port in" id="in-${n.id}"></span>` : ""}
       ${ports.map((p, i) => `<span class="fb-port out" id="port-${n.id}-${p.port}" data-port="${p.port}" style="top:${38 + i * 22}px" title="${esc(p.label)}"></span>${p.label ? `<span class="fb-portlbl" style="top:${33 + i * 22}px">${esc(p.label)}</span>` : ""}`).join("")}`;
    return el;
  }

  function outPorts(n) {
    if (n.type === "end") return [];
    if (n.type === "menu") return (n.data.options || []).map((o, i) => ({ port: "opt" + i, label: o.label || ("opt " + (i + 1)) }));
    return [{ port: "out", label: "" }]; // trigger, message, question
  }
  function summary(n) {
    const d = n.data || {};
    if (n.type === "trigger") return "on: " + ((flow().trigger.keywords || []).join(", ") || "—");
    if (n.type === "menu") return (d.text || "menu").split("\n")[0].slice(0, 40);
    if (n.type === "question") return "ask → {{" + (d.var || "answer") + "}}";
    return (d.text || "(empty)").split("\n")[0].slice(0, 40);
  }

  function renderEdges() {
    const canvas = $("fbCanvas"), svg = $("fbEdges");
    svg.setAttribute("width", canvas.scrollWidth); svg.setAttribute("height", canvas.scrollHeight);
    const cr = canvas.getBoundingClientRect();
    const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - cr.left + canvas.scrollLeft + r.width / 2, y: r.top - cr.top + canvas.scrollTop + r.height / 2 }; };
    let paths = "";
    for (const e of flow().edges) {
      const a = $("port-" + e.from + "-" + (e.fromPort || "out")), b = $("in-" + e.to);
      if (!a || !b) continue;
      const p1 = center(a), p2 = center(b), dx = Math.max(40, Math.abs(p2.x - p1.x) / 2);
      paths += `<path d="M${p1.x},${p1.y} C${p1.x + dx},${p1.y} ${p2.x - dx},${p2.y} ${p2.x},${p2.y}" fill="none" stroke="#3d8b5f" stroke-width="2"/>`;
    }
    if (conn && conn.tmp) {
      const p1 = conn.start;
      paths += `<path d="M${p1.x},${p1.y} C${p1.x + 50},${p1.y} ${conn.tmp.x - 50},${conn.tmp.y} ${conn.tmp.x},${conn.tmp.y}" fill="none" stroke="#25d366" stroke-width="2" stroke-dasharray="5 4"/>`;
    }
    svg.innerHTML = paths;
  }

  // ---------- editor panel ----------
  function renderEditor() {
    const el = $("fbEditor");
    const n = flow().nodes.find((x) => x.id === selected);
    if (!n) { el.innerHTML = '<p class="muted">Click a node to edit it. Drag a node\'s right dot onto another node to connect them.</p>'; return; }
    const d = n.data || (n.data = {});
    let h = `<div class="fb-ed-h">${NODE_META[n.type].icon} ${NODE_META[n.type].label}</div>`;
    if (n.type === "trigger") {
      h += `<p class="muted">This is where the flow starts. Set its keywords in the bar above. Connect its dot to the first step.</p>`;
    } else if (n.type === "message") {
      h += field("Message text", `<textarea data-k="text" rows="4">${esc(d.text || "")}</textarea>`);
    } else if (n.type === "question") {
      h += field("Question to ask", `<textarea data-k="text" rows="3">${esc(d.text || "")}</textarea>`);
      h += field("Save answer as variable", `<input data-k="var" value="${esc(d.var || "answer")}" placeholder="answer">`);
    } else if (n.type === "end") {
      h += field("Final message (optional)", `<textarea data-k="text" rows="3">${esc(d.text || "")}</textarea>`);
    } else if (n.type === "menu") {
      h += field("Menu text", `<textarea data-k="text" rows="4">${esc(d.text || "")}</textarea>`);
      h += `<div class="fb-ed-lbl">Options (each is an output)</div>`;
      (d.options || []).forEach((o, i) => {
        h += `<div class="fb-opt"><input data-opt="${i}" data-of="label" value="${esc(o.label || "")}" placeholder="label">
          <input data-opt="${i}" data-of="match" value="${esc(o.match || "")}" placeholder="match: 1, yes">
          <button class="fb-optdel" data-optdel="${i}">✕</button></div>`;
      });
      h += `<button class="btn ghost" id="fbAddOpt">+ option</button>`;
      h += field("Fallback (if no option matches)", `<input data-k="fallback" value="${esc(d.fallback || "")}" placeholder="Please reply 1, 2 or 3">`);
    }
    el.innerHTML = h;

    el.querySelectorAll("[data-k]").forEach((inp) => inp.addEventListener("input", () => { d[inp.dataset.k] = inp.value; markDirty(); if (inp.dataset.k === "text") refreshNode(n.id); }));
    el.querySelectorAll("[data-opt]").forEach((inp) => inp.addEventListener("input", () => {
      const i = +inp.dataset.opt; d.options[i][inp.dataset.of] = inp.value; markDirty(); if (inp.dataset.of === "label") renderCanvas();
    }));
    el.querySelectorAll("[data-optdel]").forEach((b) => b.addEventListener("click", () => { d.options.splice(+b.dataset.optdel, 1); markDirty(); renderCanvas(); renderEditor(); }));
    if ($("fbAddOpt")) $("fbAddOpt").onclick = () => { d.options = d.options || []; d.options.push({ label: "Option " + (d.options.length + 1), match: "" }); markDirty(); renderCanvas(); renderEditor(); };
  }
  const field = (label, inner) => `<div class="fb-ed-lbl">${label}</div>${inner}`;
  function refreshNode(id) { const el = document.querySelector(`.fb-node[data-node="${id}"] .fb-body`); if (el) el.textContent = summary(flow().nodes.find((n) => n.id === id)); }

  // ---------- interactions ----------
  function onCanvasDown(e) {
    const portEl = e.target.closest(".fb-port.out");
    const delEl = e.target.closest(".fb-del");
    const headEl = e.target.closest(".fb-head");
    const nodeEl = e.target.closest(".fb-node");
    if (delEl) { e.stopPropagation(); deleteNode(delEl.dataset.del); return; }
    if (portEl && nodeEl) { startConn(e, nodeEl.dataset.node, portEl.dataset.port); return; }
    if (headEl && nodeEl) { startDrag(e, nodeEl.dataset.node); return; }
    if (nodeEl) { selected = nodeEl.dataset.node; renderCanvas(); renderEditor(); }
  }
  function startDrag(e, id) {
    const n = flow().nodes.find((x) => x.id === id);
    selected = id;
    drag = { id, ox: e.clientX, oy: e.clientY, nx: n.x, ny: n.y };
    renderCanvas(); renderEditor();
  }
  function startConn(e, from, port) {
    const canvas = $("fbCanvas"), cr = canvas.getBoundingClientRect();
    const sp = e.target.getBoundingClientRect();
    conn = { from, port, start: { x: sp.left - cr.left + canvas.scrollLeft + 6, y: sp.top - cr.top + canvas.scrollTop + 6 }, tmp: null };
  }
  function onMove(e) {
    const canvas = $("fbCanvas"), cr = canvas.getBoundingClientRect();
    if (drag) {
      const n = flow().nodes.find((x) => x.id === drag.id);
      n.x = Math.max(0, drag.nx + (e.clientX - drag.ox));
      n.y = Math.max(0, drag.ny + (e.clientY - drag.oy));
      const el = document.querySelector(`.fb-node[data-node="${drag.id}"]`);
      if (el) { el.style.left = n.x + "px"; el.style.top = n.y + "px"; }
      renderEdges();
    } else if (conn) {
      conn.tmp = { x: e.clientX - cr.left + canvas.scrollLeft, y: e.clientY - cr.top + canvas.scrollTop };
      renderEdges();
    }
  }
  function onUp(e) {
    if (drag) { markDirty(); drag = null; }
    if (conn) {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(".fb-node");
      if (target && target.dataset.node !== conn.from) {
        flow().edges = flow().edges.filter((ed) => !(ed.from === conn.from && (ed.fromPort || "out") === conn.port));
        flow().edges.push({ from: conn.from, fromPort: conn.port, to: target.dataset.node });
        markDirty();
      }
      conn = null; renderCanvas();
    }
  }

  function addNode(type) {
    const c = $("fbCanvas");
    const n = { id: uid(type), type, x: c.scrollLeft + 320, y: c.scrollTop + 120,
      data: type === "menu" ? { text: "Pick one:", options: [{ label: "Option 1", match: "1" }], fallback: "" } : type === "question" ? { text: "What's your question?", var: "answer" } : { text: "" } };
    flow().nodes.push(n); selected = n.id; markDirty(); renderCanvas(); renderEditor();
  }
  function deleteNode(id) {
    flow().nodes = flow().nodes.filter((n) => n.id !== id);
    flow().edges = flow().edges.filter((e) => e.from !== id && e.to !== id);
    if (selected === id) selected = null;
    markDirty(); renderCanvas(); renderEditor();
  }

  async function save() {
    flow().name = $("fbName").value || "flow";
    flow().enabled = $("fbEnabled").checked;
    flow().trigger.keywords = $("fbKeywords").value.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      await fetch("/api/flows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flows }) });
      dirty = false; $("fbMsg").innerHTML = '<span style="color:var(--green)">✓ saved</span>';
      renderAll();
    } catch (e) { $("fbMsg").innerHTML = '<span style="color:var(--red)">save failed</span>'; }
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function init() {
    const canvas = $("fbCanvas");
    if (!canvas || canvas.dataset.init) return;
    canvas.dataset.init = "1";
    canvas.addEventListener("mousedown", onCanvasDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    $("fbSelect").onchange = (e) => { cur = +e.target.value; selected = null; renderAll(); };
    $("fbNew").onclick = () => { flows.push(blankFlow()); cur = flows.length - 1; selected = null; markDirty(); renderAll(); };
    $("fbName").oninput = () => { flow().name = $("fbName").value; markDirty(); };
    $("fbKeywords").oninput = () => { markDirty(); refreshNode("trigger"); };
    $("fbEnabled").onchange = markDirty;
    $("fbSave").onclick = save;
    document.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => addNode(b.dataset.add));
    load();
  }

  window.FlowBuilder = { init, reload: load, refresh: () => { if (flows.length) { renderCanvas(); renderEditor(); } else load(); } };
  if (document.readyState !== "loading") init(); else document.addEventListener("DOMContentLoaded", init);
})();
