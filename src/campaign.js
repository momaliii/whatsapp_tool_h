import fs from "node:fs";
import pkg from "whatsapp-web.js";
import { dataPath } from "./paths.js";
import { loadBlocklist, recentlyMessaged, warmupRemaining } from "./analytics.js";
import {
  sleep,
  randInt,
  pick,
  toJid,
  template,
  loadContacts,
  loadJson,
  readSentNumbers,
  appendResult,
} from "./utils.js";

const { MessageMedia } = pkg;

const noop = () => {};

/**
 * Shared bulk-campaign core used by BOTH the CLI and the web dashboard.
 *
 * @param {Client} client  ready whatsapp-web.js client (ignored when dryRun)
 * @param {object} opts
 *   - dryRun   {boolean}
 *   - control  {{stopped:boolean}}  set .stopped=true to abort gracefully
 *   - on       {{start,progress,log,item,done}} event hooks (all optional)
 * @returns {Promise<{sent,failed,skipped,total}>}
 */
export async function runCampaign(client, opts = {}) {
  const dryRun = !!opts.dryRun;
  const control = opts.control || { stopped: false };
  const on = {
    start: opts.on?.start || noop,
    progress: opts.on?.progress || noop,
    log: opts.on?.log || noop,
    item: opts.on?.item || noop,
    done: opts.on?.done || noop,
    sent: opts.on?.sent || noop,
  };

  const cfg = loadJson("config.json");
  const campaign = loadJson("campaign.json");
  const contacts = loadContacts("contacts.csv");

  // ---- resume: drop already-sent numbers ----
  const alreadySent = cfg.safety?.skipAlreadySent ? readSentNumbers() : new Set();
  // ---- deliverability filters ----
  const blocked = dryRun ? new Set() : loadBlocklist();
  const freqDays = cfg.safety?.frequencyCap?.enabled ? +cfg.safety.frequencyCap.days || 7 : 0;
  const recent = freqDays && !dryRun ? recentlyMessaged(freqDays) : new Set();
  let skBlock = 0, skFreq = 0;

  // ---- normalize, de-dupe, resume, filter ----
  const seen = new Set();
  const queue = [];
  for (const row of contacts) {
    const { number, jid } = toJid(row.number, cfg.countryCode);
    if (!number || number.length < 7) {
      appendResult(number || row.number, row.name || "", "invalid", "bad number");
      on.log("warn", `Invalid number skipped: ${row.number}`);
      continue;
    }
    if (seen.has(number)) continue;
    seen.add(number);
    if (alreadySent.has(number)) continue;
    if (blocked.has(number)) { skBlock++; continue; }
    if (recent.has(number)) { skFreq++; continue; }
    queue.push({ ...row, _number: number, _jid: jid });
  }
  if (skBlock) on.log("info", `⛔ Skipped ${skBlock} blocklisted/opted-out contact(s).`);
  if (skFreq) on.log("info", `⏳ Skipped ${skFreq} contact(s) messaged within ${freqDays} day(s) (frequency cap).`);

  // ---- caps: per-run + warmup ramp ----
  let cap = Number(cfg.safety?.maxPerRun || 0);
  if (cfg.safety?.warmup?.enabled && !dryRun) {
    const rem = warmupRemaining(cfg);
    if (rem !== Infinity) {
      on.log("info", `🌱 Warmup: ${rem} message(s) allowed today.`);
      cap = cap > 0 ? Math.min(cap, rem) : rem;
    }
  }
  const work = cap > 0 ? queue.slice(0, cap) : queue;

  const stats = { sent: 0, failed: 0, skipped: 0, total: work.length };
  on.start(stats);

  if (!work.length) {
    on.log("info", "Nothing to send — queue empty (all sent/invalid?).");
    on.done(stats);
    return stats;
  }

  // ---- prepare media once ----
  let media = null;
  if (campaign.media?.enabled) {
    const mediaFile = dataPath(campaign.media.path);
    if (!fs.existsSync(mediaFile))
      throw new Error(`Media file not found: ${campaign.media.path}`);
    media = MessageMedia.fromFilePath(mediaFile);
  }

  // ---- trickle mode: spread the queue evenly across N hours ----
  let trickleAvg = 0;
  if (cfg.safety?.trickle?.enabled && !dryRun && work.length > 1) {
    const hrs = +cfg.safety.trickle.hours || 8;
    trickleAvg = Math.max(2, Math.round((hrs * 3600) / work.length));
    on.log("info", `🐢 Trickle: spreading ${work.length} message(s) over ~${hrs}h (~${trickleAvg}s apart).`);
  }

  on.log(
    "info",
    `Starting: ${work.length} recipient(s) ${media ? "+ media" : "(text only)"}${
      dryRun ? " [DRY RUN]" : ""
    }`
  );

  if (cfg.onlinePresence && !dryRun) {
    try { await client.sendPresenceAvailable(); } catch {}
  }

  for (let i = 0; i < work.length; i++) {
    if (control.stopped) {
      on.log("warn", "Stopped by user.");
      break;
    }
    // pause support — hold here until resumed
    while (control.paused && !control.stopped) {
      on.progress({ index: i, total: work.length, stats, name: "paused", phase: "paused", wait: 0 });
      await sleep(1000);
    }
    if (control.stopped) { on.log("warn", "Stopped by user."); break; }

    // pause outside the allowed sending window
    if (cfg.schedule?.window?.enabled && !dryRun) {
      let logged = false;
      while (!control.stopped && !withinWindow(cfg.schedule.window, cfg.vars?.timezone)) {
        if (!logged) { on.log("info", `Outside sending window (${cfg.schedule.window.start}–${cfg.schedule.window.end}) — pausing.`); logged = true; }
        on.progress({ index: i, total: work.length, stats, name: `window ${cfg.schedule.window.start}–${cfg.schedule.window.end}`, phase: "paused", wait: 0 });
        await sleep(30000);
      }
      if (control.stopped) { on.log("warn", "Stopped by user."); break; }
      if (logged) on.log("info", "Window open — resuming.");
    }

    const row = work[i];
    const name = row.name || row._number;
    const text = template(pick([].concat(campaign.message)), row, {
      locale: cfg.vars?.locale,
      timezone: cfg.vars?.timezone,
      publicUrl: cfg.publicUrl,
      number: row._number,
    });

    on.progress({ index: i, total: work.length, stats, name, phase: "checking", wait: 0 });

    try {
      if (cfg.safety?.checkRegistered && !dryRun) {
        const ok = await client.isRegisteredUser(row._jid);
        if (!ok) {
          stats.skipped++;
          appendResult(row._number, name, "skipped", "not on WhatsApp");
          on.item({ number: row._number, name, status: "skipped", detail: "not on WhatsApp" });
          on.progress({ index: i + 1, total: work.length, stats, name, phase: "idle", wait: 0 });
          continue;
        }
      }

      if (dryRun) {
        stats.sent++;
        appendResult(row._number, name, "dry-run", text.slice(0, 40));
        on.item({ number: row._number, name, status: "dry-run", detail: text.slice(0, 40) });
      } else {
        const sentMsg = await sendHumanLike(client, row._jid, text, media, campaign, cfg, (phase) =>
          on.progress({ index: i, total: work.length, stats, name, phase, wait: 0 })
        );
        stats.sent++;
        appendResult(row._number, name, "sent", media ? "media+text" : "text");
        on.item({ number: row._number, name, status: "sent", detail: media ? "media+text" : "text" });
        on.sent(sentMsg?.id?._serialized);
      }
    } catch (err) {
      stats.failed++;
      const msg = (err.message || String(err)).slice(0, 120);
      appendResult(row._number, name, "failed", msg);
      on.item({ number: row._number, name, status: "failed", detail: msg });
      on.log("error", `Failed ${name}: ${msg}`);
    }

    on.progress({ index: i + 1, total: work.length, stats, name, phase: "idle", wait: 0 });

    // ---- delay / batch rest ----
    if (i < work.length - 1 && !control.stopped) {
      const batchSize = Number(cfg.batch?.size || 0);
      if (batchSize && (i + 1) % batchSize === 0) {
        const restS = Number(cfg.batch.restMinutes || 0) * 60;
        if (restS > 0) {
          on.log("info", `Batch break: ${cfg.batch.restMinutes} min`);
          await countdown(restS, control, (s) =>
            on.progress({ index: i + 1, total: work.length, stats, name: "batch rest", phase: "rest", wait: s })
          );
        }
      } else if (!dryRun) {
        const wait = trickleAvg
          ? randInt(Math.round(trickleAvg * 0.7), Math.round(trickleAvg * 1.3))
          : randInt(cfg.delay.minSeconds, cfg.delay.maxSeconds);
        await countdown(wait, control, (s) =>
          on.progress({ index: i + 1, total: work.length, stats, name: "", phase: "waiting", wait: s })
        );
      }
    }
  }

  on.done(stats);
  return stats;
}

/** Send one message like a human: typing indicator, then the message. */
async function sendHumanLike(client, jid, text, media, campaign, cfg, onPhase = noop) {
  // Resolve the real WhatsApp id. Do NOT use getChatById to reach the contact:
  // it throws a cryptic error (e.g. "r") for anyone you've never messaged from
  // this number. getNumberId works for brand-new contacts and returns the
  // correct wid; sendMessage then creates the chat on its own.
  let sendId = jid;
  try {
    const numberId = await client.getNumberId(jid);
    if (numberId?._serialized) sendId = numberId._serialized;
    else throw new Error("not on WhatsApp");
  } catch (e) {
    if (e.message === "not on WhatsApp") throw e;
    // getNumberId itself hiccupped — fall back to the raw jid and let sendMessage try.
  }

  // Typing indicator is best-effort: a missing chat must never abort the send.
  if (cfg.typing?.enabled && text) {
    onPhase("typing");
    try {
      const chat = await client.getChatById(sendId);
      await chat.sendStateTyping();
      const secs = Math.min(
        cfg.typing.maxSeconds,
        Math.max(cfg.typing.minSeconds, text.length / (cfg.typing.charsPerSecond || 8))
      );
      await sleep(secs * 1000);
      await chat.clearState();
    } catch {}
  }

  onPhase("sending");
  let sent;
  if (media) {
    if (campaign.sendCaptionAsSeparateText) {
      sent = await client.sendMessage(sendId, media);
      await sleep(randInt(800, 2000));
      if (text) sent = await client.sendMessage(sendId, text);
    } else {
      sent = await client.sendMessage(sendId, media, { caption: text || undefined });
    }
  } else {
    sent = await client.sendMessage(sendId, text);
  }
  return sent;
}

/** Hours/minutes of `now` in a given IANA timezone (server local if unset). */
export function nowInZone(timezone, now = new Date()) {
  if (!timezone) return { h: now.getHours(), m: now.getMinutes() };
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);
    const get = (t) => +parts.find((p) => p.type === t).value;
    return { h: get("hour") % 24, m: get("minute") };
  } catch {
    return { h: now.getHours(), m: now.getMinutes() };
  }
}

/** Is the current time inside the [start,end] window (in `timezone`)? Handles overnight. */
export function withinWindow(win, timezone, now = new Date()) {
  const toMin = (s) => { const [h, m] = String(s).split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const { h, m } = nowInZone(timezone, now);
  const cur = h * 60 + m;
  const a = toMin(win.start), b = toMin(win.end);
  if (a === b) return true; // 24h
  return a < b ? cur >= a && cur < b : cur >= a || cur < b; // normal vs overnight
}

/** Sleep `total` seconds, ticking each second, abortable via control.stopped. */
async function countdown(total, control, onTick = noop) {
  for (let s = total; s > 0; s--) {
    if (control.stopped) return;
    onTick(s);
    await sleep(1000);
  }
}
