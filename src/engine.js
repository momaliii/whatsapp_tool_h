import { EventEmitter } from "node:events";
import fs from "node:fs";
import pkg from "whatsapp-web.js";
import { runCampaign } from "./campaign.js";
import { AUTH_DIR, dataPath } from "./paths.js";
import { loadJson, sleep, randInt } from "./utils.js";
import { planReply, fileStore } from "./bot.js";
import { appendBotEvent } from "./analytics.js";

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
      const info = client.info || {};
      this.me = {
        name: info.pushname || "",
        number: info.wid?.user || "",
      };
      this.log("info", `Connected as ${this.me.name || this.me.number}.`);
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
      this.log("warn", "Disconnected: " + r);
      this.state = "disconnected";
      this.client = null;
      this.me = null;
      this.emitUpdate();
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
    if (msg.fromMe || msg.isStatus) return; // ignore own / status updates silently
    if (!from.endsWith("@c.us") && !from.endsWith("@g.us")) return; // not a normal chat

    // dedupe: the same message can arrive via both `message` and `message_create`
    const id = msg.id?._serialized || msg.id?.id;
    if (id) {
      if (this._handledMsgs.has(id)) return;
      this._handledMsgs.add(id);
      if (this._handledMsgs.size > 2000) this._handledMsgs = new Set([...this._handledMsgs].slice(-1000));
    }

    const name = msg._data?.notifyName || "";
    const who = name || from.replace("@c.us", "");
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
    appendBotEvent({
      from: from.replace("@c.us", ""),
      name,
      kind: plan.kind || "autoreply",
      flow: plan.flow,
      label: plan.label,
      actions: plan.actions.length,
    });
    this.log("info", `🤖 replied to ${name || from.replace("@c.us", "")} (${plan.actions.length} msg)`);
    this.emitUpdate();
  }

  /** Send one planned action item to a chat, human-like. */
  async sendItem(jid, item, chat) {
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
      await this.client.sendMessage(jid, media, {
        caption: item.caption || (item.type !== "voice" ? item.text : undefined) || undefined,
        sendAudioAsVoice: asVoice,
      });
      // if text accompanies a voice note, send it separately
      if (asVoice && item.text) await this.client.sendMessage(jid, item.text);
    } else if (typeText) {
      await this.client.sendMessage(jid, typeText);
    }
  }
}

export const engine = new Engine();
