import fs from "node:fs";
import { dataPath } from "./paths.js";
import { loadJson, toJid } from "./utils.js";

/*
 * Drip-sequence state & scheduling (pure logic — no WhatsApp).
 * A sequence has steps timed from each contact's enrollment (day 0 / 3 / 7…).
 * Enrollments track which step is next and when it's due. The engine ticks
 * this and sends due steps.
 */

const SEQ_FILE = "sequences.json";
const ENR_FILE = "drip-state.json";

export function loadSequences() {
  try { return loadJson(SEQ_FILE); } catch { return { sequences: [] }; }
}
export function saveSequences(obj) {
  fs.writeFileSync(dataPath(SEQ_FILE), JSON.stringify(obj, null, 2));
}
export function loadEnrollments() {
  try { return JSON.parse(fs.readFileSync(dataPath(ENR_FILE), "utf8")); } catch { return {}; }
}
export function saveEnrollments(map) {
  try { fs.writeFileSync(dataPath(ENR_FILE), JSON.stringify(map, null, 2)); } catch {}
}

const key = (seqId, number) => `${seqId}|${number}`;
const stepDueOffsetMs = (step) => ((+step.afterDays || 0) * 86400 + (+step.afterHours || 0) * 3600) * 1000;

/** Enroll contacts into a sequence (skips ones already enrolled). Returns count added. */
export function enroll(sequenceId, contacts, countryCode, nowMs) {
  const map = loadEnrollments();
  let added = 0;
  for (const c of contacts) {
    const { number } = toJid(c.number, countryCode);
    if (!number || number.length < 7) continue;
    const k = key(sequenceId, number);
    if (map[k] && !map[k].done && !map[k].cancelled) continue; // already active
    map[k] = { sequenceId, number, name: c.name || "", enrolledAt: nowMs, step: 0, done: false, cancelled: false, vars: c };
    added++;
  }
  saveEnrollments(map);
  return added;
}

/** Enrollments whose next step is due at `nowMs`. */
export function dueList(nowMs) {
  const seqs = loadSequences().sequences || [];
  const map = loadEnrollments();
  const out = [];
  for (const k of Object.keys(map)) {
    const enr = map[k];
    if (enr.done || enr.cancelled) continue;
    const seq = seqs.find((s) => s.id === enr.sequenceId);
    if (!seq || seq.enabled === false) continue;
    const steps = seq.steps || [];
    if (enr.step >= steps.length) { enr.done = true; continue; }
    const step = steps[enr.step];
    const dueAt = enr.enrolledAt + stepDueOffsetMs(step);
    if (nowMs >= dueAt) out.push({ k, enr, seq, step, stepIndex: enr.step, total: steps.length });
  }
  saveEnrollments(map);
  return out;
}

/** Advance an enrollment after sending its current step. */
export function markSent(k, nowMs) {
  const map = loadEnrollments();
  const enr = map[k];
  if (!enr) return;
  enr.step++;
  enr.lastSentAt = nowMs;
  const seq = (loadSequences().sequences || []).find((s) => s.id === enr.sequenceId);
  if (!seq || enr.step >= (seq.steps || []).length) enr.done = true;
  saveEnrollments(map);
}

export function cancel(k) {
  const map = loadEnrollments();
  if (map[k]) { map[k].cancelled = true; saveEnrollments(map); }
}

/** Counts for the dashboard. */
export function stats() {
  const map = loadEnrollments();
  let active = 0, done = 0, cancelled = 0;
  for (const k of Object.keys(map)) {
    const e = map[k];
    if (e.cancelled) cancelled++; else if (e.done) done++; else active++;
  }
  return { active, done, cancelled, total: Object.keys(map).length };
}
