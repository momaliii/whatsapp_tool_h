import { EventEmitter } from "node:events";
import fs from "node:fs";
import pkg from "whatsapp-web.js";
import { runCampaign } from "./campaign.js";
import { AUTH_DIR, dataPath } from "./paths.js";
import { loadJson, sleep, randInt } from "./utils.js";
import { planReply, fileStore } from "./bot.js";
import { appendBotEvent, appendInbound } from "./analytics.js";

const { Client, LocalAuth, MessageMedia } = pkg;

/**
 * Singleton engine that backs the web dashboard.
 * Owns the WhatsApp client lifecycle and the running campaign, and emits
 * a single "update" event whenever state changes (consumed via SSE).
 */
class Engine extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.state = "disconnected"; // disconnected | connecting | qr | ready | running
    this.qr = null;
    this.me = null; // {name, number}
    this.control = { stopped: false };
    this.progress = { index: 0, total: 0, name: "", phase: "idle", wait: 0 };
    this.stats = { sent: 0, failed: 0, skipped: 0, total: 0 };
    this.logs = [];
    this.lastRunResults = [];
    this.botStore = fileStore();
    this.botLastHandled = new Map(); // jid -> timestamp (cooldown)
    this._handledMsgs = new Set(); // message ids already processed (dedupe across events)
    // reliability state
    this.lastDisconnect = null;
    this._reconnecting = false;
    this._reconnectAttempts = 0;
    this._wasDisconnected = false;
    this._campaignSends = []; // {id, t} for ban-detection
    this._ackById = new Map(); // msgId -> ack level
    this.scheduledAt = null;
    try {
      const s = JSON.parse(fs.readFileSync(dataPath("schedule.json"), "utf8"));
      if (s.at) this.scheduledAt = s.at;
    } catch {}
    this._scheduleTick = setInterval(() => this.checkSchedule(), 30000);
  }

  snapshot() {
    return {
      state: this.state,
      qr: this.qr,
      me: this.me,
      progress: this.progress,
      stats: this.stats,
      logs: this.logs.slice(-200),
      scheduledAt: this.scheduledAt,
      lastDisconnect: this.lastDisconnect,
      reconnecting: this._reconnecting,
    };
  }

  // ---------- scheduled start ----------
  schedule(atMs) {
    this.scheduledAt = atMs;
    this.persistSchedule();
    this.log("info", "Campaign scheduled for " + new Date(atMs).toLocaleString());
    this.emitUpdate();
  }
  cancelSchedule() {
    this.scheduledAt = null;
    this.persistSchedule();
    this.log("info", "Schedule cancelled.");
    this.emitUpdate();
  }
  persistSchedule() {
    try { fs.writeFileSync(dataPath("schedule.json"), JSON.stringify({ at: this.scheduledAt })); } catch {}
  }
  checkSchedule() {
    if (!this.scheduledAt || Date.now() < this.scheduledAt) return;
    if (this.state !== "ready") return; // wait until connected & idle
    this.scheduledAt = null;
    this.persistSchedule();
    this.log("info", "⏰ Scheduled time reached — starting campaign.");
    this.run({ dryRun: false }).catch((e) => this.log("error", e.message));
  }

  // ---------- reliability: auto-reconnect, alerts, crash-safe resume, ban guard ----------
  scheduleReconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    const attempt = () => {
      if (this.client || this.state === "ready") { this._reconnecting = false; return; }
      this._reconnectAttempts++;
      const delay = Math.min(60000, 5000 * this._reconnectAttempts); // backoff, cap 60s
      this.log("info", `Reconnecting… (attempt ${this._reconnectAttempts}, in ${Math.round(delay / 1000)}s)`);
      this._reconnectTimer = setTimeout(() => {
        this.connect().catch(() => {});
        if (!this.client) attempt(); // connect failed synchronously, retry
      }, delay);
    };
    attempt();
  }

  /** Send a WhatsApp alert to the owner number (if configured + connected). */
  async alertOwner(text) {
    try {
      const cfg = loadJson("config.json");
      const num = (cfg.alerts?.number || "").replace(/\D/g, "");
      if (!num || !cfg.alerts?.enabled || !this.client || this.state !== "ready") return;
      await this.client.sendMessage(num + "@c.us", text);
    } catch {}
  }

  /** After (re)connect, resume a campaign that was interrupted by a crash/restart. */
  async maybeResume() {
    if (this.state !== "ready") return;
    let saved;
    try { saved = JSON.parse(fs.readFileSync(dataPath("active-campaign.json"), "utf8")); } catch { return; }
    if (!saved?.active || saved.dryRun) return;
    let cfg = {};
    try { cfg = loadJson("config.json"); } catch {}
    if (cfg.safety?.autoResume === false) return;
    this.log("info", "↻ Resuming an interrupted campaign (already-sent are skipped)…");
    this.run({ dryRun: false }).catch((e) => this.log("error", e.message));
  }

  _setActiveCampaign(on, dryRun) {
    try {
      if (on) fs.writeFileSync(dataPath("active-campaign.json"), JSON.stringify({ active: true, dryRun, at: new Date().toISOString() }));
      else fs.rmSync(dataPath("active-campaign.json"), { force: true });
    } catch {}
  }

  /** Pause the campaign if deliveries have stalled (likely block/throttle). */
  evaluateBanRisk() {
    let cfg = {};
    try { cfg = loadJson("config.json"); } catch {}
    const g = cfg.safety?.banGuard || {};
    if (g.enabled === false) return;
    const sampleSize = +g.sampleSize || 8;
    const minPct = +g.minDeliveredPct || 25;
    const grace = (+g.graceSeconds || 90) * 1000;
    const now = Date.now();
    const mature = this._campaignSends.filter((s) => now - s.t > grace);
    if (mature.length < sampleSize) return;
    const recent = mature.slice(-sampleSize);
    const delivered = recent.filter((s) => (this._ackById.get(s.id) || 0) >= 2).length;
    const pct = Math.round((delivered / recent.length) * 100);
    if (pct < minPct) {
      this.log("error", `🛑 Ban guard: only ${pct}% of the last ${recent.length} messages were delivered — auto-pausing to protect your number.`);
      this.alertOwner(`🛑 watitool auto-paused a campaign: deliveries stalled (${pct}% delivered). Your number may be throttled or blocked.`);
      this.control.stopped = true;
      this._banPaused = true;
    }
  }

  emitUpdate() {
    this.emit("update", this.snapshot());
  }

  log(level, message) {
    this.logs.push({ level, message, time: new Date().toISOString() });
    if (this.logs.length > 500) this.logs = this.logs.slice(-500);
    this.emitUpdate();
  }

  /** Boot the WhatsApp client (idempotent). Emits qr until scanned, then ready. */
  async connect() {
    if (this.client) return;
    this.state = "connecting";
    this.qr = null;
    this.log("info", "Connecting to WhatsApp Web…");

    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
      // Escape hatch: if message events ever stop firing after a WhatsApp Web
      // update, set WWEBJS_WEB_VERSION to a known-good HTML from
      // github.com/wppconnect-team/wa-version to pin the web build.
      webVersionCache: process.env.WWEBJS_WEB_VERSION
        ? { type: "remote", remotePath: process.env.WWEBJS_WEB_VERSION }
        : undefined,
      puppeteer: {
        headless: true,
        // On a server we use the system Chromium (set via env in Docker);
        // locally this is undefined and puppeteer's bundled Chromium is used.
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      },
    });
    this.client = client;

    client.on("qr", (qr) => {
      this.qr = qr;
      this.state = "qr";
      this._qrCount = (this._qrCount || 0) + 1;
      this.log("info", `QR ready (refresh #${this._qrCount}) — scan the LATEST code shown, it expires every ~20s.`);
    });

    // connection lifecycle — surfaces exactly where a link attempt fails
    client.on("loading_screen", (percent, message) =>
      this.log("info", `Loading WhatsApp… ${percent}% ${message || ""}`));
    client.on("authenticated", () => this.log("info", "✓ QR accepted — finalizing link…"));
    client.on("change_state", (s) => this.log("info", "State: " + s));

    client.on("ready", () => {
      this.qr = null;
      this.state = "ready";
      this._reconnecting = false;
      this._reconnectAttempts = 0;
      const info = client.info || {};
      this.me = {
        name: info.pushname || "",
        number: info.wid?.user || "",
      };
      this.log("info", `Connected as ${this.me.name || this.me.number}.`);
      if (this._wasDisconnected) {
        this._wasDisconnected = false;
        this.log("info", "✓ Recovered from a disconnect.");
        this.alertOwner(`✅ watitool reconnected (was down since ${new Date(this.lastDisconnect).toLocaleString()}).`);
      }
      // crash-safe: resume a campaign that was interrupted
      setTimeout(() => this.maybeResume(), 4000);
    });

    // track delivery acks for the ban-detection guardrail
    client.on("message_ack", (msg, ack) => {
      const id = msg?.id?._serialized;
      if (id) this._ackById.set(id, ack);
    });

    // incoming messages → auto-reply / flow bot.
    // We listen to BOTH events because `message` is unreliable on some
    // WhatsApp Web builds; `message_create` fires for received messages too.
    // handleIncoming dedupes by message id and ignores our own (fromMe).
    const onMsg = (msg) =>
      this.handleIncoming(msg).catch((e) => this.log("error", "bot: " + (e.message || e)));
    client.on("message", onMsg);
    client.on("message_create", onMsg);

    client.on("auth_failure", (m) =>
      this.log("error", "Auth failure: " + m + " — click Log out to clear the session, then Connect again."));
    client.on("disconnected", (r) => {
      this.log("warn", `⚠️ Disconnected: ${r}`);
      this.lastDisconnect = new Date().toISOString();
      this._wasDisconnected = true;
      this.state = "disconnected";
      this.client = null;
      this.me = null;
      this.emitUpdate();
      this.scheduleReconnect();
    });

    client.initialize().catch((e) => {
      this.log("error", "Init error: " + (e.message || e));
      this.state = "disconnected";
      this.client = null;
    });
  }

  /** Log out and forget the saved session. */
  async logout() {
    if (this.state === "running") throw new Error("Stop the campaign first.");
    if (this.client) {
      try { await this.client.logout(); } catch {}
      try { await this.client.destroy(); } catch {}
    }
    this.client = null;
    this.me = null;
    this.qr = null;
    this._qrCount = 0;
    this.state = "disconnected";
    // wipe the saved session folder so the next connect is a clean re-link
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
    this.log("info", "Logged out and cleared the saved session — you can scan a fresh QR now.");
  }

  /** Start a campaign. dryRun works without a live connection. */
  async run({ dryRun = false } = {}) {
    if (this.state === "running") throw new Error("A campaign is already running.");
    if (!dryRun && this.state !== "ready")
      throw new Error("Connect to WhatsApp first (scan the QR).");

    this.control = { stopped: false };
    this.lastRunResults = [];
    this.state = "running";
    this.stats = { sent: 0, failed: 0, skipped: 0, total: 0 };
    this.progress = { index: 0, total: 0, name: "", phase: "starting", wait: 0 };
    this._campaignSends = [];
    this._banPaused = false;
    if (!dryRun) this._setActiveCampaign(true, dryRun); // crash-safe marker
    this.emitUpdate();

    try {
      await runCampaign(this.client, {
        dryRun,
        control: this.control,
        on: {
          start: (stats) => {
            this.stats = stats;
            this.emitUpdate();
          },
          sent: (msgId) => {
            if (msgId) this._campaignSends.push({ id: msgId, t: Date.now() });
            if (this._campaignSends.length > 200) this._campaignSends = this._campaignSends.slice(-100);
            this.evaluateBanRisk();
          },
          progress: (p) => {
            this.progress = { index: p.index, total: p.total, name: p.name, phase: p.phase, wait: p.wait };
            this.stats = p.stats;
            this.emitUpdate();
          },
          item: (it) => {
            this.lastRunResults.push(it);
          },
          log: (level, message) => this.log(level, message),
          done: (stats) => {
            this.stats = stats;
            this.log(
              "info",
              `Finished — ✓${stats.sent} sent, ✗${stats.failed} failed, ⊘${stats.skipped} skipped.`
            );
          },
        },
      });
    } finally {
      // clear the crash-safe marker only if it finished/stopped cleanly (not a ban-pause auto-stop)
      if (!dryRun && !this._banPaused) this._setActiveCampaign(false);
      this.state = dryRun ? "disconnected" : "ready";
      if (dryRun && this.client) this.state = "ready";
      this.progress = { ...this.progress, phase: "idle", wait: 0 };
      this.emitUpdate();
    }
  }

  stop() {
    if (this.state !== "running") return;
    this.control.stopped = true;
    this.log("warn", "Stopping…");
  }

  // ---------- auto-reply / flow bot ----------
  async handleIncoming(msg) {
    const from = msg.from || "";

    // dedupe first: the same message can arrive via both `message` and `message_create`
    const id = msg.id?._serialized || msg.id?.id;
    if (id) {
      if (this._handledMsgs.has(id)) return;
      this._handledMsgs.add(id);
      if (this._handledMsgs.size > 2000) this._handledMsgs = new Set([...this._handledMsgs].slice(-1000));
    }

    // RAW event log (proves whether WhatsApp is delivering message events at all)
    this.log("info", `· event ${msg.fromMe ? "OUT" : "IN"} from=${from.replace(/@(c\.us|lid|g\.us)$/, "")} "${(msg.body || "").slice(0, 30)}"`);

    if (msg.fromMe || msg.isStatus) return; // don't reply to our own / status
    // accept individual chats (@c.us), WhatsApp's newer LID addressing (@lid), and groups (@g.us)
    if (!from.endsWith("@c.us") && !from.endsWith("@lid") && !from.endsWith("@g.us")) return;

    // record the real phone number as "replied" (for re-engage); @lid isn't the phone number
    msg.getContact().then((c) => appendInbound(c?.number || from.replace(/@(c\.us|lid|g\.us)$/, ""))).catch(() => {});

    const name = msg._data?.notifyName || "";
    const who = name || from.replace(/@(c\.us|lid|g\.us)$/, "");
    const preview = (msg.body || "").slice(0, 50);
    this.log("info", `📩 incoming from ${who}: "${preview}"`);

    let config;
    try { config = loadJson("config.json"); } catch { this.log("error", "bot: cannot read config.json"); return; }
    const bot = config.bot || {};
    if (!bot.enabled) { this.log("warn", "🤖 auto-reply is OFF — enable it on the Auto-reply tab and Save."); return; }
    if (from.endsWith("@g.us") && !bot.replyInGroups) { this.log("info", "↳ group chat — ignored (groups disabled)."); return; }
    if (this.state === "running") { this.log("info", "↳ ignored — a campaign is currently sending."); return; }

    // cooldown (skipped if the contact is mid-flow, so quick replies aren't lost)
    const inFlow = !!this.botStore.get(from);
    const now = Date.now();
    const gap = (bot.cooldownSeconds ?? 3) * 1000;
    if (!inFlow && now - (this.botLastHandled.get(from) || 0) < gap) { this.log("info", `↳ cooldown — waited <${bot.cooldownSeconds ?? 3}s, skipped.`); return; }

    let autoreply = {}, flows = [];
    try { autoreply = loadJson("autoreply.json"); } catch { this.log("warn", "bot: autoreply.json missing"); }
    try { flows = loadJson("flows.json"); } catch { this.log("warn", "bot: flows.json missing"); }

    const plan = planReply(
      { from, body: msg.body || "", name },
      { config, autoreply, flows, store: this.botStore }
    );
    if (!plan.handled || !plan.actions.length) { this.log("info", `↳ no rule or flow matched "${preview}".`); return; }

    this.botLastHandled.set(from, now);
    const chat = await msg.getChat().catch(() => null);
    for (const action of plan.actions) {
      try { await this.sendItem(from, action, chat); }
      catch (e) { this.log("error", `bot send failed: ${e.message || e}`); }
      await sleep(randInt(700, 1800));
    }
    const shortFrom = from.replace(/@(c\.us|lid|g\.us)$/, "");
    appendBotEvent({
      from: shortFrom,
      name,
      kind: plan.kind || "autoreply",
      flow: plan.flow,
      label: plan.label,
      actions: plan.actions.length,
    });
    this.log("info", `🤖 replied to ${name || shortFrom} (${plan.actions.length} msg)`);
    this.emitUpdate();
  }

  /** Send one planned action item to a chat, human-like. */
  async sendItem(jid, item, chat) {
    if (item.type === "delay") { await sleep(Math.min(120, +item.seconds || 1) * 1000); return; }
    // prefer the chat object (routes correctly for @lid contacts); fall back to jid
    const send = (content, opts) =>
      chat ? chat.sendMessage(content, opts) : this.client.sendMessage(jid, content, opts);

    const typeText = item.text;
    if (typeText && chat) {
      try {
        await chat.sendStateTyping();
        await sleep(Math.min(6000, Math.max(800, typeText.length * 60)));
        await chat.clearState();
      } catch {}
    }
    if (item.path) {
      const file = dataPath(item.path);
      if (!fs.existsSync(file)) throw new Error(`media not found: ${item.path}`);
      const media = MessageMedia.fromFilePath(file);
      const asVoice = item.type === "voice" || item.voice === true;
      await send(media, {
        caption: item.caption || (item.type !== "voice" ? item.text : undefined) || undefined,
        sendAudioAsVoice: asVoice,
      });
      // if text accompanies a voice note, send it separately
      if (asVoice && item.text) await send(item.text);
    } else if (typeText) {
      await send(typeText);
    }
  }
}

export const engine = new Engine();
