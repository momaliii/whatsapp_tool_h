import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { dataPath } from "./paths.js";
import { toJid } from "./utils.js";

const BOT_LOG = "bot-log.jsonl";
const INBOUND_LOG = "inbound.jsonl";

/** Append one bot-activity event (best-effort). */
export function appendBotEvent(rec) {
  try {
    const line = JSON.stringify({ time: new Date().toISOString(), ...rec }) + "\n";
    fs.appendFileSync(dataPath(BOT_LOG), line);
  } catch {}
}

/** Record that a phone number sent us an inbound message (for re-engage). */
export function appendInbound(number) {
  if (!number) return;
  try {
    fs.appendFileSync(dataPath(INBOUND_LOG), JSON.stringify({ time: new Date().toISOString(), number: String(number).replace(/\D/g, "") }) + "\n");
  } catch {}
}

function readInbound() {
  const set = new Set();
  try {
    for (const l of fs.readFileSync(dataPath(INBOUND_LOG), "utf8").split("\n")) {
      if (!l) continue;
      try { const n = JSON.parse(l).number; if (n) set.add(String(n)); } catch {}
    }
  } catch {}
  return set;
}

/** Map of phone number → latest inbound time (ms). Used for drip stop-on-reply. */
export function lastInboundByNumber() {
  const m = new Map();
  try {
    for (const l of fs.readFileSync(dataPath(INBOUND_LOG), "utf8").split("\n")) {
      if (!l) continue;
      try { const e = JSON.parse(l); const t = Date.parse(e.time); if (e.number && !isNaN(t)) m.set(String(e.number), Math.max(m.get(String(e.number)) || 0, t)); } catch {}
    }
  } catch {}
  return m;
}

// ---------- deliverability & targeting ----------
const BLOCK_FILE = "blocklist.json";

export function loadBlocklist() {
  try { return new Set((JSON.parse(fs.readFileSync(dataPath(BLOCK_FILE), "utf8")).numbers || []).map(String)); } catch { return new Set(); }
}
export function saveBlocklist(numbers) {
  const clean = [...new Set((numbers || []).map((n) => String(n).replace(/\D/g, "")).filter(Boolean))];
  fs.writeFileSync(dataPath(BLOCK_FILE), JSON.stringify({ numbers: clean }, null, 2));
  return clean;
}
export function addToBlocklist(number) {
  const n = String(number).replace(/\D/g, ""); if (!n) return;
  const set = loadBlocklist(); if (set.has(n)) return;
  set.add(n); saveBlocklist([...set]);
}
export function removeFromBlocklist(number) {
  const n = String(number).replace(/\D/g, ""); if (!n) return;
  const set = loadBlocklist(); if (!set.has(n)) return;
  set.delete(n); saveBlocklist([...set]);
}

/** Numbers we sent to within the last `days` (for frequency cap). */
export function recentlyMessaged(days) {
  const cutoff = Date.now() - days * 86400000;
  const set = new Set();
  for (const r of readResults()) {
    if (r.status !== "sent" || !r.number) continue;
    const t = Date.parse(r.timestamp);
    if (!isNaN(t) && t >= cutoff) set.add(r.number);
  }
  return set;
}

/** How many real messages are still allowed today under warmup ramp. */
export function warmupRemaining(cfg) {
  const w = cfg.safety?.warmup || {};
  if (!w.enabled) return Infinity;
  const results = readResults().filter((r) => r.status === "sent");
  let first = Infinity, today = 0;
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  for (const r of results) {
    const t = Date.parse(r.timestamp); if (isNaN(t)) continue;
    first = Math.min(first, t);
    if (t >= dayStart.getTime()) today++;
  }
  const dayN = first === Infinity ? 0 : Math.floor((Date.now() - first) / 86400000);
  const cap = Math.min(+w.maxPerDay || 1000, (+w.startPerDay || 20) + (+w.step || 20) * dayN);
  return Math.max(0, cap - today);
}

function readClicks() {
  try {
    return fs.readFileSync(dataPath("clicks.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Contacts who engaged: replied to us OR clicked a tracked link. */
export function engagedContacts() {
  const engaged = new Set([...readInbound()]);
  for (const c of readClicks()) if (c.c) engaged.add(String(c.c));
  const names = new Map();
  for (const r of readResults()) if (r.number && r.name) names.set(r.number, r.name);
  return { count: engaged.size, contacts: [...engaged].map((number) => ({ number, name: names.get(number) || "" })) };
}

/** Contacts whose last result was 'failed' (for retry-failed). */
export function failedContacts() {
  const last = new Map();
  for (const r of readResults()) if (r.number) last.set(r.number, r);
  const out = [];
  for (const [number, r] of last) if (r.status === "failed") out.push({ number, name: r.name || "" });
  return { count: out.length, contacts: out };
}

/** Contacts we messaged ('sent') who never replied to us. */
export function nonRepliers() {
  const sent = new Map();
  for (const r of readResults()) if (r.status === "sent" && r.number) sent.set(r.number, r.name || "");
  const replied = readInbound();
  const contacts = [];
  for (const [number, name] of sent) if (!replied.has(number)) contacts.push({ number, name });
  return { count: contacts.length, messaged: sent.size, replied: replied.size, contacts };
}

function readResults() {
  try {
    const raw = fs.readFileSync(dataPath("results.csv"), "utf8");
    return parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true });
  } catch { return []; }
}

function readBotEvents() {
  try {
    return fs.readFileSync(dataPath(BOT_LOG), "utf8")
      .split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

const dayKey = (iso) => String(iso || "").slice(0, 10);

/** Human-friendly duration from seconds. */
export function humanDuration(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h >= 1) return `${h}h ${m}m`;
  if (m >= 1) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/**
 * Estimate how long a campaign of `count` messages will take, mirroring the
 * real send loop (random delays, batch breaks, typing, registered check).
 */
export function estimateDuration(count, cfg = {}, avgLen = 60) {
  count = Math.max(0, Math.floor(count));
  if (count < 1) return { count, seconds: 0, human: "—", batches: 0 };

  const d = cfg.delay || {};
  const avgDelay = ((+d.minSeconds || 0) + (+d.maxSeconds || 0)) / 2;
  const bs = +cfg.batch?.size || 0;
  const restS = (+cfg.batch?.restMinutes || 0) * 60;

  const gaps = count - 1;
  const batches = bs > 0 && restS > 0 ? Math.floor(gaps / bs) : 0;
  const normalGaps = gaps - batches;
  const delayTotal = normalGaps * avgDelay + batches * restS;

  let typing = 0;
  if (cfg.typing?.enabled) {
    const cps = +cfg.typing.charsPerSecond || 9;
    typing = Math.min(+cfg.typing.maxSeconds || 12, Math.max(+cfg.typing.minSeconds || 2, avgLen / cps));
  }
  const check = cfg.safety?.checkRegistered ? 1.5 : 0;
  const sendT = 1.5;
  const perMsg = typing + check + sendT;
  const seconds = Math.round(delayTotal + perMsg * count);

  return {
    count, seconds, human: humanDuration(seconds), batches,
    avgDelaySeconds: Math.round(avgDelay),
    restMinutes: +cfg.batch?.restMinutes || 0,
    perMessageSeconds: Math.round(perMsg),
    finishAt: new Date(Date.now() + seconds * 1000).toISOString(),
  };
}

/**
 * Suggest delay settings to finish `count` messages in ~`targetSeconds`,
 * keeping batch/typing/check fixed. Flags how risky the result is.
 */
export function suggestSettings(count, targetSeconds, cfg = {}, avgLen = 60) {
  count = Math.max(1, Math.floor(count));
  const bs = +cfg.batch?.size || 0;
  const gaps = Math.max(1, count - 1);
  const batches = bs > 0 ? Math.floor(gaps / bs) : 0;
  const normalGaps = Math.max(1, gaps - batches);

  let typing = 0;
  if (cfg.typing?.enabled) {
    const cps = +cfg.typing.charsPerSecond || 9;
    typing = Math.min(+cfg.typing.maxSeconds || 12, Math.max(+cfg.typing.minSeconds || 2, avgLen / cps));
  }
  const perMsgTotal = (typing + (cfg.safety?.checkRegistered ? 1.5 : 0) + 1.5) * count;

  const SAFE_MIN_AVG = 20; // recommended floor for the average gap (seconds)
  const HARD_MIN_AVG = 6;  // below this is very high ban risk

  let restMinutes = +cfg.batch?.restMinutes || 0;
  let restS = restMinutes * 60;
  let tunedBatch = false;
  let feasible = true, risk = "safe";

  // step 1: keep batch breaks, solve for the average gap
  let avgDelay = (targetSeconds - batches * restS - perMsgTotal) / normalGaps;

  if (avgDelay >= SAFE_MIN_AVG) {
    risk = "safe";
  } else if (avgDelay >= HARD_MIN_AVG) {
    risk = "risky";
  } else {
    // step 2: floor the gap, then shrink the batch breaks to claw back time
    avgDelay = HARD_MIN_AVG;
    risk = "very-risky";
    if (batches > 0) {
      const budget = targetSeconds - normalGaps * avgDelay - perMsgTotal;
      if (budget < batches * restS) {
        tunedBatch = true;
        restMinutes = Math.max(0, Math.round(budget / batches / 60));
        restS = restMinutes * 60;
      }
    }
    const minTime = normalGaps * avgDelay + batches * restS + perMsgTotal;
    feasible = minTime <= targetSeconds * 1.05;
  }

  const spread = Math.max(2, Math.round(avgDelay * 0.4));
  const minSeconds = Math.max(1, Math.round(avgDelay - spread));
  const maxSeconds = Math.round(avgDelay + spread);

  const suggestedCfg = { ...cfg, delay: { minSeconds, maxSeconds }, batch: { ...cfg.batch, size: bs, restMinutes } };
  const achieved = estimateDuration(count, suggestedCfg, avgLen);

  return {
    feasible, risk,
    suggested: { minSeconds, maxSeconds, batchSize: bs, restMinutes, tunedBatch },
    achievedSeconds: achieved.seconds, achievedHuman: achieved.human,
    note:
      !feasible ? `Even at the riskiest safe-ish settings the fastest is ~${achieved.human}. To go faster you'd send recklessly — likely a ban.` :
      risk === "very-risky" ? "This hits your target but the gaps are very short — high ban risk. Warm up the number and watch closely." :
      risk === "risky" ? "Achievable, but gaps are short — keep an eye out for blocks." :
      "Looks safe for a healthy number.",
  };
}

/** Full message history for one phone number (campaign sends + bot replies). */
export function contactHistory(query, countryCode) {
  const { number } = toJid(query || "", countryCode);
  const results = readResults().filter((r) => r.number === number);
  const events = readBotEvents().filter((e) => String(e.from || "") === number);
  const items = [
    ...results.map((r) => ({ time: r.timestamp, dir: "out", status: r.status, detail: r.detail || "" })),
    ...events.map((e) => ({ time: e.time, dir: "bot", status: e.kind || "reply", detail: e.label || "" })),
  ].filter((x) => x.time).sort((a, b) => (a.time < b.time ? 1 : -1));
  const name = results[0]?.name || events[0]?.name || "";
  return { number, name, count: items.length, items };
}

/** A 0–100 sender-health score from recent send outcomes. */
export function senderHealth() {
  const results = readResults().slice(-300);
  let sent = 0, failed = 0;
  for (const r of results) { if (r.status === "sent") sent++; else if (r.status === "failed") failed++; }
  const attempted = sent + failed;
  const successPct = attempted ? Math.round((sent / attempted) * 100) : 100;
  // recent failure streak (last 20)
  const last20 = results.slice(-20);
  const recentFails = last20.filter((r) => r.status === "failed").length;
  let score = successPct - recentFails * 3;
  score = Math.max(0, Math.min(100, score));
  const status = attempted < 5 ? "new" : score >= 90 ? "good" : score >= 70 ? "watch" : "risk";
  const note = status === "new" ? "Not enough data yet — warm up gradually."
    : status === "good" ? "Healthy. Keep delays human and avoid sudden volume spikes."
    : status === "watch" ? "Some failures lately — slow down and check your message/number."
    : "High failure rate — pause, reduce volume, and review. Your number may be throttled.";
  return { score, status, successPct, sent, failed, sampled: results.length, note };
}

/** When contacts reply — a day-of-week × hour heatmap (from inbound activity). */
export function bestTimeHeatmap(timezone) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let max = 0, total = 0;
  let lines = [];
  try { lines = fs.readFileSync(dataPath("inbound.jsonl"), "utf8").split("\n").filter(Boolean); } catch {}
  for (const l of lines) {
    let iso; try { iso = JSON.parse(l).time; } catch { continue; }
    const d = new Date(iso); if (isNaN(d)) continue;
    let day, hour;
    if (timezone) {
      try {
        const p = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", hour12: false }).formatToParts(d);
        const wd = p.find((x) => x.type === "weekday").value;
        day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
        hour = +p.find((x) => x.type === "hour").value % 24;
      } catch { day = d.getDay(); hour = d.getHours(); }
    } else { day = d.getDay(); hour = d.getHours(); }
    if (day < 0) continue;
    grid[day][hour]++; total++;
    if (grid[day][hour] > max) max = grid[day][hour];
  }
  return { grid, max, total };
}

/** Aggregate everything the Insights tab needs, filtered to the last `days`. */
export function computeInsights({ days = 30 } = {}) {
  let contacts = 0;
  try {
    contacts = parse(fs.readFileSync(dataPath("contacts.csv"), "utf8"), {
      columns: true, skip_empty_lines: true, trim: true,
    }).length;
  } catch {}

  const cutoff = Date.now() - days * 86400000;
  const inRange = (iso) => { const t = Date.parse(iso); return !isNaN(t) && t >= cutoff; };

  const results = readResults().filter((r) => inRange(r.timestamp));
  const events = readBotEvents().filter((e) => inRange(e.time));

  // status breakdown
  const status = {};
  for (const r of results) status[r.status] = (status[r.status] || 0) + 1;
  const sent = status.sent || 0, failed = status.failed || 0, skipped = status.skipped || 0;
  const attempted = sent + failed;
  const deliveryRate = attempted ? Math.round((sent / attempted) * 100) : 0;

  // timeline
  const today = new Date();
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const k = d.toISOString().slice(0, 10);
    buckets.set(k, { date: k, sent: 0, failed: 0, skipped: 0, bot: 0 });
  }
  for (const r of results) { const b = buckets.get(dayKey(r.timestamp)); if (b && b[r.status] != null) b[r.status]++; }
  for (const e of events) { const b = buckets.get(dayKey(e.time)); if (b) b.bot++; }
  const timeline = [...buckets.values()];

  // bot
  const byKind = {}, byFlow = {};
  for (const e of events) {
    byKind[e.kind || "other"] = (byKind[e.kind || "other"] || 0) + 1;
    const label = e.label || e.flow || e.kind || "other";
    byFlow[label] = (byFlow[label] || 0) + 1;
  }
  const topTriggers = Object.entries(byFlow).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([label, count]) => ({ label, count }));

  const recent = [
    ...results.map((r) => ({ time: r.timestamp, kind: "send", status: r.status, who: r.name || r.number, detail: r.detail || "" })),
    ...events.map((e) => ({ time: e.time, kind: "bot", status: e.kind, who: e.name || e.from || "", detail: e.label || "" })),
  ].filter((x) => x.time).sort((a, b) => (a.time < b.time ? 1 : -1)).slice(0, 25);

  let tz;
  try { tz = JSON.parse(fs.readFileSync(dataPath("config.json"), "utf8")).vars?.timezone || undefined; } catch {}

  return {
    days,
    totals: { contacts, sent, failed, skipped, deliveryRate, botReplies: events.length, campaignMessages: results.length },
    statusBreakdown: status,
    timeline,
    bot: { total: events.length, byKind, topTriggers },
    recent,
    heatmap: bestTimeHeatmap(tz),
    health: senderHealth(),
    generatedAt: new Date().toISOString(),
  };
}
