// n8n-style visual flow builder. Self-contained; talks to /api/flows + /api/upload.
(function () {
  const $ = (id) => document.getElementById(id);
  const NODE_META = {
    trigger:   { icon: "⚡", label: "Trigger",   color: "#25d366" },
    message:   { icon: "💬", label: "Message",   color: "#58a6ff" },
    menu:      { icon: "📋", label: "Menu",      color: "#e3b341" },
    question:  { icon: "❓", label: "Question",  color: "#1d9e75" },
    condition: { icon: "🔀", label: "Condition", color: "#a371f7" },
    delay:     { icon: "⏱️", label: "Delay",     color: "#d29922" },
    end:       { icon: "🏁", label: "End",       color: "#8b949e" },
  };
  const guessType = (p) => {
    const e = (String(p).split(".").pop() || "").toLowerCase();
    if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(e)) return "image";
    if (["mp4", "3gp", "mov", "mkv", "webm", "avi"].includes(e)) return "video";
    if (["mp3", "ogg", "opus", "m4a", "wav", "aac"].includes(e)) return "audio";
    return "document";
  };

  let flows = [], cur = 0, selected = null, dirty = false;
  let drag = null, conn = null, pan = null;
  let view = { x: 20, y: 20, z: 1 };

  const flow = () => flows[cur];
  const uid = (p) => p + "_" + Math.random().toString(36).slice(2, 7);
  const markDirty = () => { dirty = true; $("fbMsg").textContent = "unsaved changes"; };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function load() {
    try {
      const data = await fetch("/api/flows").then((r) => r.json());
      flows = (data.flows || []).map(normalize);
      if (!flows.length) flows = [blankFlow()];
      cur = 0; selected = null; renderAll();
    } catch (e) {}
  }
  function normalize(f) {
    f.nodes = f.nodes || []; f.edges = f.edges || [];
    f.trigger = f.trigger || { keywords: [], match: "contains" };
    if (!f.nodes.some((n) => n.type === "trigger")) f.nodes.unshift({ id: "trigger", type: "trigger", x: 40, y: 160, data: {} });
    return f;
  }
  function blankFlow() {
    return normalize({ id: uid("flow"), name: "New flow", enabled: true, trigger: { keywords: ["hi"], match: "contains" },
      nodes: [{ id: "trigger", type: "trigger", x: 40, y: 160, data: {} }], edges: [] });
  }

  function renderAll() {
    $("fbSelect").innerHTML = flows.map((f, i) => `<option value="${i}" ${i === cur ? "selected" : ""}>${esc(f.name || "flow")}</option>`).join("");
    $("fbName").value = flow().name || "";
    $("fbEnabled").checked = flow().enabled !== false;
    $("fbKeywords").value = (flow().trigger.keywords || []).join(", ");
    renderCanvas(); renderEditor();
  }

  function applyView() {
    $("fbWorld").style.transform = `translate(${view.x}px,${view.y}px) scale(${view.z})`;
    $("fbZoomLbl").textContent = Math.round(view.z * 100) + "%";
    renderEdges();
  }

  function renderCanvas() {
    const world = $("fbWorld");
    world.innerHTML = "";
    for (const n of flow().nodes) world.appendChild(nodeEl(n));
    applyView();
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
         ${n.type !== "trigger" ? `<span class="fb-del" data-del="${n.id}" title="Delete">✕</span>` : ""}
       </div>
       <div class="fb-body">${esc(summary(n))}</div>
       ${n.type !== "trigger" ? `<span class="fb-port in" id="in-${n.id}"></span>` : ""}
       ${ports.map((p, i) => `<span class="fb-port out" id="port-${n.id}-${p.port}" data-port="${p.port}" style="top:${38 + i * 22}px" title="connect"></span>${p.label ? `<span class="fb-portlbl" style="top:${33 + i * 22}px">${esc(p.label)}</span>` : ""}`).join("")}`;
    return el;
  }
  function outPorts(n) {
    if (n.type === "end") return [];
    if (n.type === "menu") return (n.data.options || []).map((o, i) => ({ port: "opt" + i, label: o.label || ("opt " + (i + 1)) }));
    if (n.type === "condition") return [{ port: "yes", label: "yes" }, { port: "no", label: "no" }];
    return [{ port: "out", label: "" }];
  }
  function summary(n) {
    const d = n.data || {};
    const med = (d.media || []).length ? ` 📎${d.media.length}` : "";
    if (n.type === "trigger") return "on: " + ((flow().trigger.keywords || []).join(", ") || "—");
    if (n.type === "menu") return (d.text || "menu").split("\n")[0].slice(0, 38);
    if (n.type === "question") return "ask → {{" + (d.var || "answer") + "}}";
    if (n.type === "condition") return `if {{${d.var || "answer"}}} ${d.op || "contains"} "${(d.value || "").slice(0, 14)}"`;
    if (n.type === "delay") return "wait " + (d.seconds || 3) + "s";
    return ((d.text || "(empty)").split("\n")[0].slice(0, 34)) + med;
  }

  function renderEdges() {
    const canvas = $("fbCanvas"), svg = $("fbEdges");
    const cr = canvas.getBoundingClientRect();
    svg.setAttribute("width", cr.width); svg.setAttribute("height", cr.height);
    const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - cr.left + r.width / 2, y: r.top - cr.top + r.height / 2 }; };
    let paths = "";
    (flow().edges || []).forEach((e, idx) => {
      const a = $("port-" + e.from + "-" + (e.fromPort || "out")), b = $("in-" + e.to);
      if (!a || !b) return;
      const p1 = center(a), p2 = center(b), dx = Math.max(40, Math.abs(p2.x - p1.x) / 2);
      const d = `M${p1.x},${p1.y} C${p1.x + dx},${p1.y} ${p2.x - dx},${p2.y} ${p2.x},${p2.y}`;
      paths += `<path d="${d}" class="fb-edge-hit" data-edge="${idx}"/><path d="${d}" class="fb-edge"/>`;
    });
    if (conn && conn.tmp) {
      const p1 = conn.start;
      paths += `<path d="M${p1.x},${p1.y} C${p1.x + 50},${p1.y} ${conn.tmp.x - 50},${conn.tmp.y} ${conn.tmp.x},${conn.tmp.y}" class="fb-edge tmp"/>`;
    }
    svg.innerHTML = paths;
  }

  // ---------- editor ----------
  function renderEditor() {
    const el = $("fbEditor");
    const n = flow().nodes.find((x) => x.id === selected);
    if (!n) { el.innerHTML = '<p class="muted">Click a node to edit. Drag a node\'s right dot onto another node to connect. Click a line to delete it.</p>'; return; }
    const d = n.data || (n.data = {});
    let h = `<div class="fb-ed-h"><span>${NODE_META[n.type].icon} ${NODE_META[n.type].label}</span>${n.type !== "trigger" ? `<span><button class="btn ghost xs" id="fbDup">⧉ Duplicate</button> <button class="btn ghost xs" id="fbDelNode">🗑</button></span>` : ""}</div>`;
    if (n.type === "trigger") {
      h += `<p class="muted">The flow starts here. Set its keywords in the bar above, then connect its dot to the first step.</p>`;
    } else if (n.type === "message") {
      h += field("Message text", `<textarea data-k="text" rows="4">${esc(d.text || "")}</textarea>`) + mediaBlock(d);
    } else if (n.type === "question") {
      h += field("Question to ask", `<textarea data-k="text" rows="3">${esc(d.text || "")}</textarea>`);
      h += field("Save answer as variable", `<input data-k="var" value="${esc(d.var || "answer")}" placeholder="answer">`);
    } else if (n.type === "delay") {
      h += field("Wait seconds", `<input type="number" data-k="seconds" min="1" max="120" value="${esc(d.seconds || 3)}">`);
    } else if (n.type === "condition") {
      h += field("Check variable", `<input data-k="var" value="${esc(d.var || "answer")}" placeholder="answer">`);
      h += field("Operator", `<select data-k="op">${["contains", "equals", "exists"].map((o) => `<option ${d.op === o ? "selected" : ""}>${o}</option>`).join("")}</select>`);
      h += field("Value", `<input data-k="value" value="${esc(d.value || "")}" placeholder="yes">`);
      h += `<p class="muted" style="font-size:12px">Routes to <b>yes</b> if it matches, else <b>no</b>.</p>`;
    } else if (n.type === "end") {
      h += field("Final message (optional)", `<textarea data-k="text" rows="3">${esc(d.text || "")}</textarea>`) + mediaBlock(d);
    } else if (n.type === "menu") {
      h += field("Menu text", `<textarea data-k="text" rows="4">${esc(d.text || "")}</textarea>`);
      h += `<div class="fb-ed-lbl">Options (each is an output)</div>`;
      (d.options || []).forEach((o, i) => {
        h += `<div class="fb-opt"><input data-opt="${i}" data-of="label" value="${esc(o.label || "")}" placeholder="label">
          <input data-opt="${i}" data-of="match" value="${esc(o.match || "")}" placeholder="match: 1, yes">
          <button class="fb-optdel" data-optdel="${i}">✕</button></div>`;
      });
      h += `<button class="btn ghost xs" id="fbAddOpt">+ option</button>`;
      h += field("Fallback (if no option matches)", `<input data-k="fallback" value="${esc(d.fallback || "")}" placeholder="Please reply 1, 2 or 3">`);
    }
    el.innerHTML = h;
    bindEditor(n, d);
  }
  const field = (label, inner) => `<div class="fb-ed-lbl">${label}</div>${inner}`;
  function mediaBlock(d) {
    let h = `<div class="fb-ed-lbl">Media (image / video / file / voice)</div><div id="fbMedia">`;
    (d.media || []).forEach((md, i) => {
      h += `<div class="media-item">📎 ${esc(md.name || md.path.split("/").pop())}
        ${guessType(md.path) === "audio" ? `<label><input type="checkbox" data-mvoice="${i}" ${md.voice ? "checked" : ""}> voice</label>` : ""}
        <span class="x" data-mdel="${i}">✕</span></div>`;
    });
    h += `</div><label class="btn ghost xs">+ attach<input type="file" id="fbMediaFile" hidden></label>`;
    return h;
  }
  function bindEditor(n, d) {
    const el = $("fbEditor");
    el.querySelectorAll("[data-k]").forEach((inp) => inp.addEventListener("input", () => { d[inp.dataset.k] = inp.value; markDirty(); refreshNode(n.id); }));
    el.querySelectorAll("[data-opt]").forEach((inp) => inp.addEventListener("input", () => { d.options[+inp.dataset.opt][inp.dataset.of] = inp.value; markDirty(); if (inp.dataset.of === "label") renderCanvas(); }));
    el.querySelectorAll("[data-optdel]").forEach((b) => b.addEventListener("click", () => { d.options.splice(+b.dataset.optdel, 1); markDirty(); renderCanvas(); renderEditor(); }));
    el.querySelectorAll("[data-mdel]").forEach((b) => b.addEventListener("click", () => { d.media.splice(+b.dataset.mdel, 1); markDirty(); renderCanvas(); renderEditor(); }));
    el.querySelectorAll("[data-mvoice]").forEach((b) => b.addEventListener("change", () => { d.media[+b.dataset.mvoice].voice = b.checked; markDirty(); }));
    if ($("fbAddOpt")) $("fbAddOpt").onclick = () => { d.options = d.options || []; d.options.push({ label: "Option " + (d.options.length + 1), match: "" }); markDirty(); renderCanvas(); renderEditor(); };
    if ($("fbDup")) $("fbDup").onclick = () => duplicateNode(n.id);
    if ($("fbDelNode")) $("fbDelNode").onclick = () => deleteNode(n.id);
    if ($("fbMediaFile")) $("fbMediaFile").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const fd = new FormData(); fd.append("file", f);
      try {
        const r = await fetch("/api/upload", { method: "POST", body: fd }).then((x) => x.json());
        d.media = d.media || []; d.media.push({ path: r.path, name: r.name, voice: guessType(r.path) === "audio" });
        markDirty(); renderCanvas(); renderEditor();
      } catch (err) {}
    };
  }
  function refreshNode(id) { const el = document.querySelector(`.fb-node[data-node="${id}"] .fb-body`); if (el) el.textContent = summary(flow().nodes.find((n) => n.id === id)); }

  // ---------- interactions ----------
  function onCanvasDown(e) {
    if (e.target.closest(".fb-zoom")) return;
    const edgeHit = e.target.closest(".fb-edge-hit");
    if (edgeHit) { flow().edges.splice(+edgeHit.dataset.edge, 1); markDirty(); renderEdges(); return; }
    const del = e.target.closest(".fb-del");
    if (del) { e.stopPropagation(); deleteNode(del.dataset.del); return; }
    const portEl = e.target.closest(".fb-port.out"), nodeEl = e.target.closest(".fb-node"), headEl = e.target.closest(".fb-head");
    if (portEl && nodeEl) return startConn(e, nodeEl.dataset.node, portEl.dataset.port);
    if (headEl && nodeEl) return startDrag(e, nodeEl.dataset.node);
    if (nodeEl) { selected = nodeEl.dataset.node; renderCanvas(); renderEditor(); return; }
    pan = { ox: e.clientX, oy: e.clientY, vx: view.x, vy: view.y }; // empty canvas → pan
  }
  function startDrag(e, id) {
    const n = flow().nodes.find((x) => x.id === id);
    selected = id; drag = { id, ox: e.clientX, oy: e.clientY, nx: n.x, ny: n.y };
    renderCanvas(); renderEditor();
  }
  function startConn(e, from, port) {
    const cr = $("fbCanvas").getBoundingClientRect(), sp = e.target.getBoundingClientRect();
    conn = { from, port, start: { x: sp.left - cr.left + sp.width / 2, y: sp.top - cr.top + sp.height / 2 }, tmp: null };
  }
  function onMove(e) {
    const cr = $("fbCanvas").getBoundingClientRect();
    if (drag) {
      const n = flow().nodes.find((x) => x.id === drag.id);
      n.x = Math.max(0, drag.nx + (e.clientX - drag.ox) / view.z);
      n.y = Math.max(0, drag.ny + (e.clientY - drag.oy) / view.z);
      const el = document.querySelector(`.fb-node[data-node="${drag.id}"]`);
      if (el) { el.style.left = n.x + "px"; el.style.top = n.y + "px"; }
      renderEdges();
    } else if (conn) {
      conn.tmp = { x: e.clientX - cr.left, y: e.clientY - cr.top }; renderEdges();
    } else if (pan) {
      view.x = pan.vx + (e.clientX - pan.ox); view.y = pan.vy + (e.clientY - pan.oy); applyView();
    }
  }
  function onUp(e) {
    if (drag) { markDirty(); drag = null; }
    if (conn) {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(".fb-node");
      if (target && target.dataset.node !== conn.from && flow().nodes.find((n) => n.id === target.dataset.node).type !== "trigger") {
        flow().edges = flow().edges.filter((ed) => !(ed.from === conn.from && (ed.fromPort || "out") === conn.port));
        flow().edges.push({ from: conn.from, fromPort: conn.port, to: target.dataset.node });
        markDirty();
      }
      conn = null; renderCanvas();
    }
    pan = null;
  }
  function onWheel(e) {
    e.preventDefault();
    const cr = $("fbCanvas").getBoundingClientRect();
    const mx = e.clientX - cr.left, my = e.clientY - cr.top;
    const nz = Math.min(1.6, Math.max(0.4, view.z * (e.deltaY < 0 ? 1.1 : 0.9)));
    view.x = mx - (mx - view.x) * (nz / view.z); view.y = my - (my - view.y) * (nz / view.z);
    view.z = nz; applyView();
  }
  function zoom(f) { view.z = Math.min(1.6, Math.max(0.4, view.z * f)); applyView(); }
  function fit() { view = { x: 20, y: 20, z: 1 }; applyView(); }

  function addNode(type) {
    const n = { id: uid(type), type, x: (120 - view.x) / view.z, y: (120 - view.y) / view.z,
      data: type === "menu" ? { text: "Pick one:", options: [{ label: "Option 1", match: "1" }], fallback: "" }
        : type === "question" ? { text: "What's your question?", var: "answer" }
        : type === "condition" ? { var: "answer", op: "contains", value: "yes" }
        : type === "delay" ? { seconds: 3 } : { text: "" } };
    flow().nodes.push(n); selected = n.id; markDirty(); renderCanvas(); renderEditor();
  }
  function duplicateNode(id) {
    const n = flow().nodes.find((x) => x.id === id); if (!n || n.type === "trigger") return;
    const copy = { id: uid(n.type), type: n.type, x: n.x + 40, y: n.y + 40, data: JSON.parse(JSON.stringify(n.data || {})) };
    flow().nodes.push(copy); selected = copy.id; markDirty(); renderCanvas(); renderEditor();
  }
  function deleteNode(id) {
    if (flow().nodes.find((n) => n.id === id)?.type === "trigger") return;
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
      dirty = false; $("fbMsg").innerHTML = '<span style="color:var(--green)">✓ saved</span>'; renderAll();
    } catch (e) { $("fbMsg").innerHTML = '<span style="color:var(--red)">save failed</span>'; }
  }

  function onKey(e) {
    if (!$("tab-flows").classList.contains("active")) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
    if (typing) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selected) { e.preventDefault(); deleteNode(selected); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && selected) { e.preventDefault(); duplicateNode(selected); }
  }

  function init() {
    const canvas = $("fbCanvas");
    if (!canvas || canvas.dataset.init) return;
    canvas.dataset.init = "1";
    canvas.addEventListener("mousedown", onCanvasDown);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    $("fbSelect").onchange = (e) => { cur = +e.target.value; selected = null; renderAll(); };
    $("fbNew").onclick = () => { flows.push(blankFlow()); cur = flows.length - 1; selected = null; markDirty(); renderAll(); };
    $("fbName").oninput = () => { flow().name = $("fbName").value; markDirty(); };
    $("fbKeywords").oninput = () => { markDirty(); refreshNode("trigger"); };
    $("fbEnabled").onchange = markDirty;
    $("fbSave").onclick = save;
    $("fbZoomIn").onclick = () => zoom(1.15);
    $("fbZoomOut").onclick = () => zoom(0.87);
    $("fbFit").onclick = fit;
    document.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => addNode(b.dataset.add));
    load();
  }

  window.FlowBuilder = { init, reload: load, refresh: () => { if (flows.length) { renderCanvas(); renderEditor(); } else load(); } };
  if (document.readyState !== "loading") init(); else document.addEventListener("DOMContentLoaded", init);
})();
