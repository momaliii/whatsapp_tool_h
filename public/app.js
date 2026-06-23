const $ = (id) => document.getElementById(id);
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((body && body.error) || r.statusText);
  return body;
};
function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  setTimeout(() => (t.className = "toast"), 2600);
}
function flashSaved(id) {
  const el = $(id);
  el.textContent = "✓ saved";
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1500);
}

// ---------- tabs ----------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $("tab-" + tab.dataset.tab).classList.add("active");
  };
});

// ---------- connection ----------
$("btnConnect").onclick = async () => {
  $("btnConnect").disabled = true;
  try { await api("/api/connect", { method: "POST" }); toast("Connecting…"); }
  catch (e) { toast(e.message, true); }
  finally { setTimeout(() => ($("btnConnect").disabled = false), 2000); }
};
$("btnLogout").onclick = async () => {
  if (!confirm("Log out and forget this WhatsApp session?")) return;
  try { await api("/api/logout", { method: "POST" }); toast("Logged out"); }
  catch (e) { toast(e.message, true); }
};

let lastQr = null;
async function refreshQr() {
  const { dataUrl } = await api("/api/qr");
  if (dataUrl && dataUrl !== lastQr) {
    lastQr = dataUrl;
    $("qrImg").src = dataUrl;
    $("qrImg").hidden = false;
    $("qrPlaceholder").hidden = true;
  } else if (!dataUrl) {
    lastQr = null;
    $("qrImg").hidden = true;
    $("qrPlaceholder").hidden = false;
  }
}

// ---------- live state via SSE ----------
const stateColors = { ready: "ready", qr: "qr", connecting: "connecting", running: "running", disconnected: "disconnected" };
let running = false;

function applyState(s) {
  // connection badge
  $("connDot").className = "dot " + (stateColors[s.state] || "");
  $("connText").textContent = s.state;
  $("stateLabel").textContent = s.state;

  if (s.state === "qr") refreshQr();
  else if (s.state === "ready") { $("qrImg").hidden = true; $("qrPlaceholder").hidden = false; $("qrPlaceholder").textContent = "Connected ✓"; lastQr = null; }
  else if (s.state === "disconnected") { $("qrPlaceholder").textContent = "Click “Connect” to generate a QR code"; }

  if (s.me && s.me.number) {
    $("meLine").hidden = false;
    $("meName").textContent = s.me.name || "WhatsApp";
    $("meNumber").textContent = "+" + s.me.number;
  } else $("meLine").hidden = true;

  // progress
  const p = s.progress || {}, st = s.stats || {};
  const total = p.total || st.total || 0;
  const done = p.index || 0;
  $("bar").style.width = total ? (done / total) * 100 + "%" : "0%";
  $("progCount").textContent = `${done} / ${total}`;
  $("sSent").textContent = st.sent || 0;
  $("sFailed").textContent = st.failed || 0;
  $("sSkipped").textContent = st.skipped || 0;
  let phase = p.phase || "idle";
  if (p.wait) phase += ` ${p.wait}s`;
  if (p.name && p.phase !== "waiting") phase += ` · ${p.name}`;
  $("phase").textContent = phase;

  // running controls
  running = s.state === "running";
  $("btnStart").disabled = running;
  $("btnDryRun").disabled = running;
  $("btnStop").disabled = !running;

  // logs
  const log = $("log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = (s.logs || []).map((l) =>
    `<div class="${l.level}">${l.time.slice(11, 19)} ${escapeHtml(l.message)}</div>`
  ).join("");
  if (atBottom) log.scrollTop = log.scrollHeight;

  renderSchedule(s.scheduledAt);

  if (s.state === "ready" && wasRunning) { loadResults(); loadInsights(); }
  wasRunning = running;
}
let wasRunning = false;

function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

const ev = new EventSource("/api/events");
ev.onmessage = (e) => { try { applyState(JSON.parse(e.data)); } catch {} };
ev.onerror = () => { $("connText").textContent = "reconnecting…"; };

// ---------- contacts ----------
async function loadContacts() {
  const csv = await api("/api/contacts");
  $("contactsArea").value = csv;
  countContacts();
}
function countContacts() {
  const lines = $("contactsArea").value.trim().split("\n").filter(Boolean);
  $("contactCount").textContent = lines.length > 1 ? `${lines.length - 1} contacts` : "";
}
$("contactsArea").addEventListener("input", countContacts);
$("csvFile").onchange = (e) => {
  const f = e.target.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => { $("contactsArea").value = reader.result; countContacts(); toast("Imported — click Save"); };
  reader.readAsText(f);
};
$("btnSaveContacts").onclick = async () => {
  try {
    await api("/api/contacts", { method: "POST", headers: { "Content-Type": "text/csv" }, body: $("contactsArea").value });
    flashSaved("contactsSaved"); countContacts();
  } catch (e) { toast(e.message, true); }
};
$("btnValidate").onclick = async () => {
  // save first so server validates current text
  try { await api("/api/contacts", { method: "POST", headers: { "Content-Type": "text/csv" }, body: $("contactsArea").value }); } catch (e) { return toast(e.message, true); }
  const cc = (await api("/api/config")).countryCode;
  const lines = $("contactsArea").value.trim().split("\n").slice(1).filter(Boolean);
  const out = lines.map((l) => {
    const raw = l.split(",")[0].trim();
    const n = normalize(raw, cc);
    const ok = n.length >= 7;
    return `<div class="${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"} ${escapeHtml(raw)} → ${ok ? n : "INVALID"}</div>`;
  }).join("");
  $("validateOut").innerHTML = out;
};
function normalize(raw, cc) {
  let n = String(raw).replace(/[\s\-()]/g, "").replace(/^\+/, "").replace(/^00/, "").replace(/\D/g, "");
  cc = String(cc || "").replace(/\D/g, "");
  if (cc && n.length <= 10) n = cc + n.replace(/^0+/, "");
  return n;
}

// ---------- message ----------
let campaign = {};
async function loadCampaign() {
  campaign = await api("/api/campaign");
  $("messageArea").value = [].concat(campaign.message || []).join("\n---\n");
  $("captionSeparate").checked = !!campaign.sendCaptionAsSeparateText;
  updateMedia();
  updatePreview();
}
function updateMedia() {
  const m = campaign.media || {};
  if (m.enabled && m.path) {
    $("mediaName").textContent = "📎 " + m.path.split("/").pop();
    $("btnClearMedia").hidden = false;
  } else {
    $("mediaName").textContent = "No media — text only";
    $("btnClearMedia").hidden = true;
  }
}
// Remember the last cursor position so the preview/shuffle still target the
// right variant even after focus moves to the shuffle button.
let lastCursorPos = 0;
function rememberCursor(e) {
  // Read straight from the textarea that fired the event — selectionStart is
  // valid during these interactions, so no activeElement guard needed.
  const ta = (e && e.target) || $("messageArea");
  if (typeof ta.selectionStart === "number") lastCursorPos = ta.selectionStart;
}
["input", "click", "keyup", "select", "focus"].forEach((ev) =>
  $("messageArea").addEventListener(ev, rememberCursor)
);

// Which variant is the cursor currently inside? Preview follows that one.
function variantAtCursor() {
  const ta = $("messageArea");
  const val = ta.value;
  const pos = Math.min(lastCursorPos, val.length);
  const sep = /^[ \t]*---[ \t]*$/gm;
  const bounds = [0];
  let m;
  while ((m = sep.exec(val))) { bounds.push(m.index); bounds.push(sep.lastIndex); }
  bounds.push(val.length);
  const ranges = [];
  for (let i = 0; i < bounds.length; i += 2) ranges.push([bounds[i], bounds[i + 1]]);
  let idx = ranges.findIndex(([a, b]) => pos >= a && pos <= b);
  if (idx < 0) idx = 0;
  return { text: val.slice(ranges[idx][0], ranges[idx][1]).trim(), index: idx, count: ranges.length };
}

async function renderPreview() {
  const { text, index, count } = variantAtCursor();
  $("previewWhich").textContent = count > 1 ? `(variant ${index + 1} of ${count})` : "";
  if (!text) { $("preview").textContent = "—"; return; }
  try {
    const r = await api("/api/preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    $("preview").textContent = r.rendered || "—";
  } catch { $("preview").textContent = text; }
}
let previewTimer = null;
function updatePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 200);
}
$("messageArea").addEventListener("input", updatePreview);
$("messageArea").addEventListener("click", updatePreview);
$("messageArea").addEventListener("keyup", updatePreview);
// shuffle re-rolls immediately (no debounce)
$("btnReroll").onclick = () => { clearTimeout(previewTimer); renderPreview(); };

// click a chip to insert the variable at the cursor
document.querySelectorAll(".chip").forEach((chip) => {
  chip.onclick = () => {
    const ta = $("messageArea");
    const s = ta.selectionStart, e = ta.selectionEnd;
    const ins = chip.dataset.ins;
    ta.value = ta.value.slice(0, s) + ins + ta.value.slice(e);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = s + ins.length;
    updatePreview();
  };
});
$("mediaFile").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const fd = new FormData(); fd.append("file", f);
  try {
    const r = await api("/api/media", { method: "POST", body: fd });
    campaign.media = { enabled: true, path: r.path };
    updateMedia(); toast("Media attached");
  } catch (err) { toast(err.message, true); }
};
$("btnClearMedia").onclick = () => { campaign.media = { enabled: false, path: "" }; updateMedia(); };
$("btnSaveMessage").onclick = async () => {
  campaign.message = $("messageArea").value.split(/^\s*---\s*$/m).map((s) => s.trim()).filter(Boolean);
  campaign.sendCaptionAsSeparateText = $("captionSeparate").checked;
  try { await api("/api/campaign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(campaign) }); flashSaved("messageSaved"); }
  catch (e) { toast(e.message, true); }
};

// ---------- settings ----------
let cfg = {};
async function loadConfig() {
  cfg = await api("/api/config");
  $("cfg_cc").value = cfg.countryCode || "";
  $("cfg_dmin").value = cfg.delay?.minSeconds ?? 25;
  $("cfg_dmax").value = cfg.delay?.maxSeconds ?? 70;
  $("cfg_bsize").value = cfg.batch?.size ?? 40;
  $("cfg_brest").value = cfg.batch?.restMinutes ?? 12;
  $("cfg_cap").value = cfg.safety?.maxPerRun ?? 0;
  $("cfg_cps").value = cfg.typing?.charsPerSecond ?? 9;
  $("cfg_typing").checked = cfg.typing?.enabled ?? true;
  $("cfg_check").checked = cfg.safety?.checkRegistered ?? true;
  $("cfg_skip").checked = cfg.safety?.skipAlreadySent ?? true;
  $("cfg_online").checked = cfg.onlinePresence ?? true;
  const w = cfg.schedule?.window || {};
  $("cfg_winEnabled").checked = !!w.enabled;
  $("cfg_winStart").value = w.start || "09:00";
  $("cfg_winEnd").value = w.end || "21:00";
  $("cfg_tz").value = cfg.vars?.timezone || "";
  $("cfg_locale").value = cfg.vars?.locale || "";
  updateTzClock();
}

function populateTimezones() {
  const sel = $("cfg_tz");
  let zones = [];
  try { zones = Intl.supportedValuesOf("timeZone"); } catch {}
  if (!zones.length) zones = ["UTC", "Africa/Cairo", "Asia/Riyadh", "Asia/Dubai", "Europe/London", "America/New_York", "America/Los_Angeles"];
  sel.innerHTML = '<option value="">(server default)</option>' + zones.map((z) => `<option>${z}</option>`).join("");
}
function updateTzClock() {
  const tz = $("cfg_tz").value;
  try {
    $("tzClock").textContent = "Now there: " + new Intl.DateTimeFormat(undefined, {
      timeZone: tz || undefined, weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).format(new Date());
  } catch { $("tzClock").textContent = "invalid timezone"; }
}
$("cfg_tz").addEventListener("change", updateTzClock);
$("btnTzBrowser").onclick = () => {
  try { $("cfg_tz").value = Intl.DateTimeFormat().resolvedOptions().timeZone; updateTzClock(); } catch {}
};
setInterval(updateTzClock, 1000);
$("btnSaveSettings").onclick = async () => {
  cfg.countryCode = $("cfg_cc").value;
  cfg.delay = { ...cfg.delay, minSeconds: +$("cfg_dmin").value, maxSeconds: +$("cfg_dmax").value };
  cfg.batch = { ...cfg.batch, size: +$("cfg_bsize").value, restMinutes: +$("cfg_brest").value };
  cfg.typing = { ...cfg.typing, enabled: $("cfg_typing").checked, charsPerSecond: +$("cfg_cps").value };
  cfg.safety = { ...cfg.safety, maxPerRun: +$("cfg_cap").value, checkRegistered: $("cfg_check").checked, skipAlreadySent: $("cfg_skip").checked };
  cfg.onlinePresence = $("cfg_online").checked;
  cfg.schedule = { ...cfg.schedule, window: { enabled: $("cfg_winEnabled").checked, start: $("cfg_winStart").value || "09:00", end: $("cfg_winEnd").value || "21:00" } };
  cfg.vars = { ...cfg.vars, timezone: $("cfg_tz").value, locale: $("cfg_locale").value.trim() };
  try { await api("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg) }); flashSaved("settingsSaved"); }
  catch (e) { toast(e.message, true); }
};

// ---------- send ----------
$("btnStart").onclick = async () => {
  if (!confirm("Start sending to your contact list now?")) return;
  try { await api("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dryRun: false }) }); }
  catch (e) { toast(e.message, true); }
};
$("btnDryRun").onclick = async () => {
  try { await api("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dryRun: true }) }); toast("Dry run started"); }
  catch (e) { toast(e.message, true); }
};
$("btnStop").onclick = async () => { try { await api("/api/stop", { method: "POST" }); } catch (e) { toast(e.message, true); } };
$("btnClearResults").onclick = async () => {
  if (!confirm("Reset send history? Already-messaged numbers will be eligible again.")) return;
  try { await api("/api/results/clear", { method: "POST" }); loadResults(); toast("History cleared"); }
  catch (e) { toast(e.message, true); }
};
async function loadResults() {
  const rows = await api("/api/results");
  $("results").innerHTML = rows.length
    ? rows.map((r) => `<div class="r"><span>${escapeHtml(r.name || r.number)} <span class="muted">${r.number}</span></span><span class="st ${r.status}">${r.status}</span></div>`).join("")
    : '<div class="muted">No results yet.</div>';
}

// ---------- insights ----------
let insDays = 30;
async function loadInsights() {
  try {
    const d = await api("/api/insights?days=" + insDays);
    renderCards(d.totals);
    renderTimeline(d.timeline);
    renderDonut(d.statusBreakdown);
    renderTriggers(d.bot.topTriggers);
    renderRecent(d.recent);
    $("insStamp").textContent = "Updated " + new Date(d.generatedAt).toLocaleTimeString();
  } catch (e) { toast(e.message, true); }
}
function renderCards(t) {
  const cards = [
    { l: "Contacts", v: t.contacts, cls: "" },
    { l: "Messages sent", v: t.sent, cls: "ok" },
    { l: "Failed", v: t.failed, cls: "bad" },
    { l: "Delivery rate", v: t.deliveryRate + "%", cls: t.deliveryRate >= 90 ? "ok" : t.deliveryRate >= 70 ? "warn" : "bad" },
    { l: "Bot replies", v: t.botReplies, cls: "blue" },
  ];
  $("insCards").innerHTML = cards.map((c) => `<div class="card ${c.cls}"><div class="v">${c.v}</div><div class="l">${c.l}</div></div>`).join("");
}
function renderTimeline(timeline) {
  const W = 640, H = 200, padL = 26, padB = 22, padT = 10;
  const cw = (W - padL) / timeline.length;
  const max = Math.max(1, ...timeline.map((d) => d.sent + d.failed + d.skipped + d.bot));
  const chartH = H - padB - padT;
  const segs = [["sent", "#25d366"], ["failed", "#f85149"], ["skipped", "#e3b341"], ["bot", "#58a6ff"]];
  const total = timeline.reduce((s, d) => s + d.sent + d.failed + d.skipped + d.bot, 0);
  if (!total) { $("chartTimeline").innerHTML = '<div class="empty-chart">No activity yet — run a campaign or enable the bot.</div>'; return; }
  let bars = "";
  timeline.forEach((d, i) => {
    const x = padL + i * cw + cw * 0.15, bw = cw * 0.7;
    let y = H - padB;
    for (const [key, col] of segs) {
      const v = d[key] || 0; if (!v) continue;
      const h = (v / max) * chartH; y -= h;
      bars += `<rect class="bar-track" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${col}" rx="1"><title>${d.date} — ${key}: ${v}</title></rect>`;
    }
    if (i % 2 === 0 || i === timeline.length - 1)
      bars += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 7}" fill="#8b949e" font-size="9" text-anchor="middle">${d.date.slice(5)}</text>`;
  });
  const axis = `<text x="2" y="${padT + 8}" fill="#8b949e" font-size="9">${max}</text><line x1="${padL}" y1="${H - padB}" x2="${W}" y2="${H - padB}" stroke="#2a3340"/>`;
  $("chartTimeline").innerHTML = `<svg viewBox="0 0 ${W} ${H}">${axis}${bars}</svg>`;
}
function renderDonut(status) {
  const parts = [["sent", "#25d366"], ["failed", "#f85149"], ["skipped", "#e3b341"], ["dry-run", "#8b949e"], ["invalid", "#555"]];
  const data = parts.map(([k, c]) => ({ k, c, v: status[k] || 0 })).filter((d) => d.v > 0);
  const total = data.reduce((s, d) => s + d.v, 0);
  if (!total) { $("chartDonut").innerHTML = '<div class="empty-chart">No results yet.</div>'; return; }
  const R = 60, C = 2 * Math.PI * R, cx = 90, cy = 90;
  let off = 0, arcs = "";
  for (const d of data) {
    const len = (d.v / total) * C;
    arcs += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${d.c}" stroke-width="22" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"><title>${d.k}: ${d.v}</title></circle>`;
    off += len;
  }
  const legend = data.map((d) => `<div style="display:flex;align-items:center;gap:6px;font-size:13px;margin:4px 0"><span style="width:10px;height:10px;border-radius:50%;background:${d.c};display:inline-block"></span>${d.k}: <b>${d.v}</b> <span class="muted">(${Math.round(d.v / total * 100)}%)</span></div>`).join("");
  $("chartDonut").innerHTML = `<svg viewBox="0 0 180 180" style="max-width:200px;margin:0 auto">${arcs}<text x="90" y="86" text-anchor="middle" fill="#e6edf3" font-size="22" font-weight="700">${total}</text><text x="90" y="104" text-anchor="middle" fill="#8b949e" font-size="10">messages</text></svg><div style="margin-top:10px">${legend}</div>`;
}
function renderTriggers(top) {
  if (!top || !top.length) { $("insTriggers").innerHTML = '<p class="muted">No bot activity yet.</p>'; return; }
  const max = Math.max(...top.map((t) => t.count));
  $("insTriggers").innerHTML = top.map((t) =>
    `<div class="trig"><span class="name" title="${escapeAttr(t.label)}">${escapeHtml(t.label)}</span><span class="meter"><i style="width:${Math.round(t.count / max * 100)}%"></i></span><span class="n">${t.count}</span></div>`
  ).join("");
}
function renderRecent(recent) {
  if (!recent || !recent.length) { $("insRecent").innerHTML = '<p class="muted">Nothing yet.</p>'; return; }
  $("insRecent").innerHTML = recent.map((r) => {
    const t = new Date(r.time);
    const ts = isNaN(t) ? "" : t.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const icon = r.kind === "bot" ? "🤖" : "📤";
    const who = escapeHtml(r.who || "");
    const detail = r.detail ? " · " + escapeHtml(String(r.detail).slice(0, 30)) : "";
    return `<div class="row"><span>${icon}</span><span class="tag ${r.status}">${r.status}</span><span class="who">${who}${detail}</span><span class="t">${ts}</span></div>`;
  }).join("");
}
$("btnRefreshIns").onclick = loadInsights;
document.querySelector('.tab[data-tab="insights"]').addEventListener("click", loadInsights);
document.querySelector('.tab[data-tab="flows"]').addEventListener("click", () => window.FlowBuilder && window.FlowBuilder.refresh());

// date-range buttons
$("rangeBtns").querySelectorAll("button").forEach((b) => {
  b.onclick = () => {
    $("rangeBtns").querySelectorAll("button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    insDays = +b.dataset.days;
    loadInsights();
  };
});

// contact lookup
$("histForm").onsubmit = async (e) => {
  e.preventDefault();
  const number = $("histNumber").value.trim();
  if (!number) return;
  try {
    const h = await api("/api/history?number=" + encodeURIComponent(number));
    if (!h.count) { $("histResult").innerHTML = `<p class="muted">No history for ${escapeHtml(number)} yet.</p>`; return; }
    const head = `<p><b>${escapeHtml(h.name || h.number)}</b> <span class="muted">${h.number} · ${h.count} event(s)</span></p>`;
    $("histResult").innerHTML = head + h.items.map((it) => {
      const t = new Date(it.time);
      const ts = isNaN(t) ? "" : t.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const icon = it.dir === "bot" ? "🤖" : "📤";
      return `<div class="hist-item"><span class="dir">${icon}</span><span class="tag ${it.status}">${it.status}</span><span class="who">${escapeHtml(String(it.detail || "").slice(0, 40))}</span><span class="t">${ts}</span></div>`;
    }).join("");
  } catch (err) { toast(err.message, true); }
};

// ---------- send-time estimator ----------
async function loadEta(count) {
  try {
    const q = count ? "?count=" + count : "";
    const e = await api("/api/estimate" + q);
    $("etaVal").textContent = e.human;
    $("etaSub").textContent = `for ${e.count} contact${e.count === 1 ? "" : "s"}`;
    if (!count) $("etaCount").value = e.count;
    const finish = e.finishAt ? new Date(e.finishAt) : null;
    $("etaDetail").textContent =
      `~${e.avgDelaySeconds}s between messages · ${e.batches} batch break(s) of ${e.restMinutes}min · ~${e.perMessageSeconds}s/msg work` +
      (finish && e.seconds ? ` · would finish around ${finish.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "");
  } catch (err) { $("etaVal").textContent = "—"; }
}
let etaTimer = null;
$("etaCount").addEventListener("input", () => {
  clearTimeout(etaTimer);
  etaTimer = setTimeout(() => loadEta(+$("etaCount").value || 0), 300);
});
$("etaUseList").onclick = () => { $("etaCount").value = ""; loadEta(); };
document.querySelector('.tab[data-tab="send"]').addEventListener("click", () => loadEta(+$("etaCount").value || 0));

// auto-tune
$("btnTune").onclick = async () => {
  const hours = +$("tuneHours").value;
  if (!hours || hours <= 0) return toast("Enter a target number of hours", true);
  const count = +$("etaCount").value || 0;
  try {
    const s = await api(`/api/autotune?hours=${hours}${count ? "&count=" + count : ""}`);
    const b = s.suggested.tunedBatch ? `, batch break ${s.suggested.restMinutes}min` : "";
    $("tuneOut").innerHTML =
      `<div>Suggested: <b>${s.suggested.minSeconds}–${s.suggested.maxSeconds}s</b> between messages${b} → <b>${s.achievedHuman}</b> ` +
      `<span class="risk-${s.risk}">(${s.risk})</span></div>` +
      `<div class="muted" style="margin:4px 0">${escapeHtml(s.note)}</div>` +
      `<button class="btn ${s.risk === "safe" ? "primary" : ""}" id="btnApplyTune">Apply these settings</button>`;
    $("btnApplyTune").onclick = async () => {
      if ((s.risk === "very-risky") && !confirm("These settings are very aggressive and risk a WhatsApp ban. Apply anyway?")) return;
      cfg.delay = { ...cfg.delay, minSeconds: s.suggested.minSeconds, maxSeconds: s.suggested.maxSeconds };
      cfg.batch = { ...cfg.batch, restMinutes: s.suggested.restMinutes };
      try {
        await api("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg) });
        toast("Applied — settings updated");
        loadConfig(); loadEta(+$("etaCount").value || 0);
        $("tuneOut").innerHTML = "";
      } catch (e) { toast(e.message, true); }
    };
  } catch (e) { toast(e.message, true); }
};

// schedule
$("btnSchedule").onclick = async () => {
  const v = $("schedAt").value;
  if (!v) return toast("Pick a date & time", true);
  try {
    const at = new Date(v).toISOString();
    await api("/api/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ at }) });
    toast("Scheduled");
  } catch (e) { toast(e.message, true); }
};
function renderSchedule(scheduledAt) {
  const el = $("schedStatus");
  if (!scheduledAt) { el.innerHTML = ""; return; }
  const d = new Date(scheduledAt);
  el.innerHTML = `<span class="on">⏰ Scheduled for ${d.toLocaleString()}</span> <button class="btn ghost" id="btnCancelSched">Cancel</button>`;
  $("btnCancelSched").onclick = async () => {
    try { await api("/api/schedule/cancel", { method: "POST" }); toast("Schedule cancelled"); } catch (e) { toast(e.message, true); }
  };
}

// ---------- auto-reply & bot ----------
function guessType(p) {
  const e = (p.split(".").pop() || "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(e)) return "image";
  if (["mp4", "3gp", "mov", "mkv", "webm", "avi"].includes(e)) return "video";
  if (["mp3", "ogg", "opus", "m4a", "wav", "aac"].includes(e)) return "audio";
  return "document";
}
let autoRules = [];
async function loadBot() {
  // bot master settings live in config (cfg already loaded)
  const b = cfg.bot || {};
  $("botEnabled").checked = !!b.enabled;
  $("botCooldown").value = b.cooldownSeconds ?? 3;
  $("botGroups").checked = !!b.replyInGroups;
  // rules
  const ar = await api("/api/autoreply");
  autoRules = (ar.rules || []).map((r) => {
    const items = [].concat(r.reply || []);
    const textItem = items.find((i) => i.type === "text" || (i.text && !i.path));
    return {
      keywords: (r.keywords || []).join(", "),
      match: r.match || "contains",
      text: textItem ? textItem.text : "",
      media: items.filter((i) => i.path).map((i) => ({
        path: i.path, name: i.path.split("/").pop(),
        voice: i.type === "voice" || !!i.voice,
        isAudio: i.type === "voice" || guessType(i.path) === "audio",
      })),
    };
  });
  renderRules();
  // flows are handled by the visual builder (flowbuilder.js)
}
function renderRules() {
  const el = $("rules");
  if (!autoRules.length) { el.innerHTML = '<p class="muted">No rules yet — add one below.</p>'; return; }
  el.innerHTML = autoRules.map((r, i) => `
    <div class="rule" data-i="${i}">
      <div class="rule-head">
        <input class="r-kw" placeholder="keywords, comma, separated" value="${escapeAttr(r.keywords)}" />
        <select class="r-match">
          ${["contains", "exact", "starts", "regex"].map((m) => `<option ${m === r.match ? "selected" : ""}>${m}</option>`).join("")}
        </select>
        <button class="del-rule" title="Delete rule">✕</button>
      </div>
      <textarea class="r-text" placeholder="Reply text (optional). Use {{name}}, {{time}}, …">${escapeHtml(r.text)}</textarea>
      <div class="row">
        ${r.media.map((m, j) => `
          <span class="media-item">📎 ${escapeHtml(m.name)}
            ${m.isAudio ? `<label><input type="checkbox" class="r-voice" data-j="${j}" ${m.voice ? "checked" : ""}/> voice</label>` : ""}
            <span class="x" data-j="${j}">✕</span>
          </span>`).join("")}
        <label class="btn ghost">+ media<input type="file" class="r-media" hidden /></label>
      </div>
    </div>`).join("");
  // bind
  el.querySelectorAll(".rule").forEach((card) => {
    const i = +card.dataset.i;
    card.querySelector(".r-kw").oninput = (e) => (autoRules[i].keywords = e.target.value);
    card.querySelector(".r-match").onchange = (e) => (autoRules[i].match = e.target.value);
    card.querySelector(".r-text").oninput = (e) => (autoRules[i].text = e.target.value);
    card.querySelector(".del-rule").onclick = () => { autoRules.splice(i, 1); renderRules(); };
    card.querySelectorAll(".x").forEach((x) => (x.onclick = () => { autoRules[i].media.splice(+x.dataset.j, 1); renderRules(); }));
    card.querySelectorAll(".r-voice").forEach((v) => (v.onchange = () => (autoRules[i].media[+v.dataset.j].voice = v.checked)));
    card.querySelector(".r-media").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const fd = new FormData(); fd.append("file", f);
      try {
        const r = await api("/api/upload", { method: "POST", body: fd });
        const isAudio = guessType(r.path) === "audio";
        autoRules[i].media.push({ path: r.path, name: r.name, voice: isAudio, isAudio });
        renderRules();
      } catch (err) { toast(err.message, true); }
    };
  });
}
function escapeAttr(s) { return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

$("btnAddRule").onclick = () => { autoRules.push({ keywords: "", match: "contains", text: "", media: [] }); renderRules(); };

$("btnSaveAuto").onclick = async () => {
  // bot settings → config
  cfg.bot = { ...(cfg.bot || {}), enabled: $("botEnabled").checked, cooldownSeconds: +$("botCooldown").value, replyInGroups: $("botGroups").checked };
  // rules → autoreply
  const rules = autoRules.map((r) => {
    const reply = [];
    if (r.text.trim()) reply.push({ type: "text", text: r.text });
    for (const m of r.media) reply.push({ type: m.voice ? "voice" : guessType(m.path), path: m.path });
    return { keywords: r.keywords.split(",").map((s) => s.trim()).filter(Boolean), match: r.match, reply };
  });
  try {
    await api("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg) });
    await api("/api/autoreply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rules }) });
    flashSaved("autoSaved");
  } catch (e) { toast(e.message, true); }
};

// ---------- chat simulator ----------
function simBubble(cls, text) {
  const d = document.createElement("div");
  d.className = "b " + cls;
  d.textContent = text;
  $("simChat").appendChild(d);
  $("simChat").scrollTop = $("simChat").scrollHeight;
}
function simSys(text) {
  const d = document.createElement("div");
  d.className = "sys"; d.textContent = text;
  $("simChat").appendChild(d);
}
async function simReset() {
  $("simChat").innerHTML = "";
  simSys("New conversation — type a message to start");
  try { await api("/api/bot/simulate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reset: true }) }); } catch {}
}
$("simForm").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("simInput").value.trim();
  if (!text) return;
  $("simInput").value = "";
  simBubble("user", text);
  try {
    const plan = await api("/api/bot/simulate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: text, name: "You" }) });
    if (!plan.handled) { simSys("(no rule or flow matched)"); return; }
    for (const a of plan.actions) {
      if (a.path) simBubble("bot media", `📎 ${a.type}: ${a.path}${a.caption ? "\n" + a.caption : ""}`);
      if (a.text) simBubble("bot", a.text);
    }
    if (plan.ended) simSys("— flow ended —");
  } catch (err) { toast(err.message, true); }
};
$("simReset").onclick = simReset;

// ---------- sign out ----------
$("btnSignout").onclick = async () => {
  try { await api("/api/signout", { method: "POST" }); } catch {}
  location.href = "/login";
};
async function initAuthUI() {
  try {
    const s = await api("/api/auth-status");
    $("btnSignout").hidden = !s.enabled;
  } catch {}
}

// ---------- boot ----------
(async () => {
  try {
    await initAuthUI();
    populateTimezones();
    await Promise.all([loadContacts(), loadCampaign(), loadConfig(), loadResults()]);
    await loadBot(); // needs cfg from loadConfig
    simReset();
    loadInsights();
    loadEta();
  } catch (e) { toast("Load error: " + e.message, true); }
})();
