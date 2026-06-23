import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./paths.js";
import { loadJson, template } from "./utils.js";

/*
 * Pure response planner for incoming messages.
 *
 * planReply() decides WHAT to send (text/media/voice items) and updates flow
 * session state — but never touches WhatsApp. The engine executes the returned
 * actions, and the dashboard simulator runs the same function with an in-memory
 * store. That keeps the conversation logic fully testable.
 */

const STATE_FILE = "bot-state.json";

const norm = (s) => String(s ?? "").trim().toLowerCase();

/** Does `text` match any of `keywords` under the given mode? */
export function matches(text, keywords, mode = "contains") {
  const t = norm(text);
  const list = keywords == null ? [] : Array.isArray(keywords) ? keywords : [keywords];
  return list.some((k) => {
    if (mode === "regex") {
      try { return new RegExp(k, "i").test(text); } catch { return false; }
    }
    const kw = norm(k);
    if (!kw) return false;
    if (mode === "exact") return t === kw;
    if (mode === "starts") return t.startsWith(kw);
    return t.includes(kw); // contains (default)
  });
}

/** Guess a send-item type from a file extension. */
export function guessType(p) {
  const e = path.extname(String(p)).toLowerCase().replace(".", "");
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(e)) return "image";
  if (["mp4", "3gp", "mov", "mkv", "webm", "avi"].includes(e)) return "video";
  if (["mp3", "ogg", "opus", "m4a", "wav", "aac"].includes(e)) return "audio";
  return "document";
}

function renderItem(item, vars, opts = {}) {
  const out = { ...item };
  if (!out.type && out.path) out.type = guessType(out.path);
  if (!out.type && out.text != null) out.type = "text";
  if (out.text != null) out.text = template(out.text, vars, opts);
  if (out.caption != null) out.caption = template(out.caption, vars, opts);
  return out;
}

// ---------- session stores ----------
export function fileStore() {
  let s = null;
  const load = () => {
    if (!s) { try { s = loadJson(STATE_FILE); } catch { s = {}; } }
    return s;
  };
  const persist = () => fs.writeFileSync(dataPath(STATE_FILE), JSON.stringify(s, null, 2));
  return {
    get: (k) => load()[k],
    set: (k, v) => { load()[k] = v; persist(); },
    del: (k) => { delete load()[k]; persist(); },
  };
}
export function memStore(initial = {}) {
  const s = { ...initial };
  return {
    get: (k) => s[k],
    set: (k, v) => { s[k] = v; },
    del: (k) => { delete s[k]; },
    dump: () => s,
  };
}

// ---------- visual graph → step format ----------
/**
 * Compile a node/edge flow (from the visual builder) into the step format the
 * engine runs. Flows already in step format pass through unchanged.
 * Node types: trigger, message, menu, question, end.
 */
export function compileFlow(flow) {
  if (!flow || (flow.steps && !flow.nodes)) return flow; // already step-format
  const nodes = flow.nodes || [];
  const edges = flow.edges || [];
  const target = (nodeId, port = "out") => {
    const e = edges.find((e) => e.from === nodeId && (e.fromPort || "out") === port);
    return e ? e.to : undefined;
  };
  const kw = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

  const msgItems = (d) => {
    const items = [];
    if (d.text) items.push({ type: "text", text: d.text });
    for (const md of d.media || []) items.push({ type: md.voice ? "voice" : guessType(md.path), path: md.path, caption: md.caption });
    return items;
  };

  const steps = {};
  for (const n of nodes) {
    const d = n.data || {};
    if (n.type === "message") {
      const next = target(n.id);
      const items = msgItems(d);
      steps[n.id] = { send: items.length ? items : [{ type: "text", text: "" }], ...(next ? { next } : { end: true }) };
    } else if (n.type === "delay") {
      const next = target(n.id);
      steps[n.id] = { send: [{ type: "delay", seconds: +d.seconds || 3 }], ...(next ? { next } : { end: true }) };
    } else if (n.type === "condition") {
      steps[n.id] = { condition: { var: d.var || "answer", op: d.op || "contains", value: d.value || "" }, yes: target(n.id, "yes"), no: target(n.id, "no") };
    } else if (n.type === "menu") {
      const options = (d.options || [])
        .map((o, i) => ({ match: kw(o.match || o.label), next: target(n.id, "opt" + i) }))
        .filter((o) => o.next && o.match.length);
      steps[n.id] = { send: [{ type: "text", text: d.text || "" }], options, fallback: d.fallback ? { type: "text", text: d.fallback } : undefined };
    } else if (n.type === "question") {
      steps[n.id] = { send: [{ type: "text", text: d.text || "" }], collect: d.var || "answer", next: target(n.id) };
    } else if (n.type === "end") {
      steps[n.id] = { send: msgItems(d), end: true };
    }
  }
  const trig = nodes.find((n) => n.type === "trigger");
  return {
    id: flow.id,
    name: flow.name,
    enabled: flow.enabled,
    trigger: flow.trigger || { keywords: [], match: "contains" },
    start: trig ? target(trig.id) : flow.start,
    steps,
  };
}

// ---------- flow stepping ----------
function enterStep(from, flow, stepId, store, vars, opts, actions = []) {
  const step = flow.steps?.[stepId];
  if (!step) { store.del(from); return { handled: true, actions, ended: true }; }

  // condition node: evaluate a variable and branch immediately (no message, no wait)
  if (step.condition) {
    const c = step.condition;
    const v = String(vars[c.var] ?? "").toLowerCase().trim();
    const val = String(c.value ?? "").toLowerCase().trim();
    const pass = c.op === "exists" ? v.length > 0 : c.op === "equals" ? v === val : v.includes(val);
    return enterStep(from, flow, pass ? step.yes : step.no, store, vars, opts, actions);
  }

  for (const item of step.send || []) actions.push(renderItem(item, vars, opts));

  if (step.options) {
    store.set(from, { flowId: flow.id, stepId, vars });
    return { handled: true, actions, waiting: true, flow: flow.id, step: stepId };
  }
  if (step.collect) {
    store.set(from, { flowId: flow.id, stepId, vars });
    return { handled: true, actions, waiting: true, flow: flow.id, step: stepId };
  }
  if (step.end) { store.del(from); return { handled: true, actions, ended: true }; }
  if (step.next) return enterStep(from, flow, step.next, store, vars, opts, actions); // chain

  store.del(from);
  return { handled: true, actions, ended: true };
}

function advanceFlow(from, body, flow, session, store, opts) {
  const vars = session.vars || {};
  const step = flow.steps?.[session.stepId];
  if (!step) { store.del(from); return { handled: false, actions: [] }; }

  if (step.collect) {
    vars[step.collect] = body;
    return enterStep(from, flow, step.next, store, vars, opts, []);
  }

  if (step.options) {
    // numeric shortcut: "2" picks the 2nd option
    const n = parseInt(norm(body), 10);
    if (!Number.isNaN(n) && step.options[n - 1] && norm(body) === String(n)) {
      return enterStep(from, flow, step.options[n - 1].next, store, vars, opts, []);
    }
    for (const opt of step.options) {
      if (matches(body, opt.match, opt.matchMode || "contains")) {
        return enterStep(from, flow, opt.next, store, vars, opts, []);
      }
    }
    // no match → fallback, stay on the step
    const fb = step.fallback;
    const actions = fb
      ? [renderItem(typeof fb === "string" ? { type: "text", text: fb } : fb, vars, opts)]
      : [{ type: "text", text: "Sorry, I didn't get that — please try again." }];
    return { handled: true, actions, waiting: true, flow: flow.id, step: session.stepId };
  }

  store.del(from);
  return { handled: false, actions: [] };
}

/**
 * Plan the bot's response to one incoming message.
 * @returns {{handled:boolean, actions:Array, ...}}
 *   actions: [{type:'text'|'image'|'video'|'document'|'audio'|'voice', text?, path?, caption?, voice?}]
 */
export function planReply(input, data) {
  const { from, body, name } = input;
  const { config = {}, autoreply = {}, flows = [], store } = data;
  const bot = config.bot || {};
  const opts = { locale: config.vars?.locale, timezone: config.vars?.timezone };
  const rawFlows = Array.isArray(flows) ? flows : flows.flows || [];
  const flowList = rawFlows.map(compileFlow);
  const rules = autoreply.rules || [];

  const session = store.get(from);

  // global exit keywords end an active flow
  if (session && matches(body, bot.exitKeywords || ["cancel", "stop", "exit"], "exact")) {
    store.del(from);
    return { handled: true, kind: "exit", actions: [{ type: "text", text: bot.exitMessage || "Okay, cancelled. 👋" }] };
  }

  // 1) continue an active flow
  if (session) {
    const flow = flowList.find((f) => f.id === session.flowId);
    if (flow) {
      const r = advanceFlow(from, body, flow, session, store, opts);
      r.kind = "flow"; r.flow = flow.id; r.label = flow.name || flow.id;
      return r;
    }
    store.del(from); // stale flow, drop it
  }

  const vars = { name: name || "" };

  // 2) a flow trigger?
  for (const f of flowList) {
    if (f.enabled !== false && matches(body, f.trigger?.keywords, f.trigger?.match || "contains")) {
      const r = enterStep(from, f, f.start, store, vars, opts, []);
      r.kind = "flow"; r.flow = f.id; r.label = f.name || f.id;
      return r;
    }
  }

  // 3) an auto-reply rule?
  for (const r of rules) {
    if (r.enabled !== false && matches(body, r.keywords, r.match || "contains")) {
      const items = (Array.isArray(r.reply) ? r.reply : [r.reply]).filter(Boolean);
      return { handled: true, kind: "autoreply", label: (r.keywords || [])[0] || "rule", actions: items.map((it) => renderItem(it, vars, opts)) };
    }
  }

  return { handled: false, actions: [] };
}
