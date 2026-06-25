#!/usr/bin/env node
import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { engine } from "./src/engine.js";
import { color, template } from "./src/utils.js";
import { parse as parseCsv } from "csv-parse/sync";
import { dataPath, MEDIA_DIR, ensureData } from "./src/paths.js";
import { planReply, memStore } from "./src/bot.js";
import { computeInsights, estimateDuration, contactHistory, suggestSettings, nonRepliers, engagedContacts, failedContacts, loadBlocklist, saveBlocklist } from "./src/analytics.js";
import { loadSequences, saveSequences, enroll, stats as dripStats } from "./src/drip.js";
import { createLink, findLink, logClick, linksWithStats } from "./src/links.js";
import {
  requireAuth,
  authEnabled,
  checkPassword,
  createSession,
  destroySession,
  getToken,
  getPassword,
  sessionCookie,
} from "./src/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

ensureData(); // seed defaults + create folders under DATA_DIR

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "text/csv", limit: "5mb" }));

// ---------- public short-link redirect + click tracking (no login) ----------
app.get("/l/:code", (req, res) => {
  const link = findLink(req.params.code);
  if (!link) return res.status(404).send("Link not found.");
  logClick(link.code, req.query.c, req.headers["user-agent"]);
  res.redirect(link.url);
});

// ---------- public pages (no login required) ----------
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC, "home.html")));
app.get("/pricing", (_req, res) => res.redirect("/#pricing"));
app.get("/login", (_req, res) => res.sendFile(path.join(PUBLIC, "login.html")));
app.get("/style.css", (_req, res) => res.sendFile(path.join(PUBLIC, "style.css")));

app.get("/api/auth-status", (req, res) =>
  res.json({ enabled: authEnabled(), authed: !authEnabled() || !!getToken(req) })
);

app.post("/api/login", (req, res) => {
  if (!checkPassword(req.body?.password))
    return res.status(401).json({ error: "Wrong password" });
  const token = createSession();
  res.setHeader("Set-Cookie", sessionCookie(req, token));
  res.json({ ok: true });
});

app.post("/api/signout", (req, res) => {
  destroySession(getToken(req));
  res.setHeader("Set-Cookie", sessionCookie(req, "", true));
  res.json({ ok: true });
});

// ---------- everything below requires a valid session ----------
app.use(requireAuth);
// the dashboard lives at /app (gated); "/" is the public landing page
app.get("/app", (_req, res) => res.sendFile(path.join(PUBLIC, "index.html")));
app.use(express.static(PUBLIC));

// ---- media uploads ----
const upload = multer({ dest: MEDIA_DIR });

const readJson = (f) => JSON.parse(fs.readFileSync(dataPath(f), "utf8"));
const writeJson = (f, o) => fs.writeFileSync(dataPath(f), JSON.stringify(o, null, 2));

// ---------- state + live events (SSE) ----------
app.get("/api/state", (_req, res) => res.json(engine.snapshot()));

app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  const send = (snap) => res.write(`data: ${JSON.stringify(snap)}\n\n`);
  send(engine.snapshot());
  const onUpdate = (snap) => send(snap);
  engine.on("update", onUpdate);
  const ka = setInterval(() => res.write(": keep-alive\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ka);
    engine.off("update", onUpdate);
  });
});

// ---------- QR as PNG data URL (offline) ----------
app.get("/api/qr", async (_req, res) => {
  if (!engine.qr) return res.json({ dataUrl: null });
  try {
    const dataUrl = await QRCode.toDataURL(engine.qr, { width: 320, margin: 1 });
    res.json({ dataUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- connection ----------
app.post("/api/connect", async (_req, res) => {
  try { await engine.connect(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/logout", async (_req, res) => {
  try { await engine.logout(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- config / campaign ----------
app.get("/api/config", (_req, res) => res.json(readJson("config.json")));
app.post("/api/config", (req, res) => {
  try { writeJson("config.json", req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/campaign", (_req, res) => res.json(readJson("campaign.json")));
app.post("/api/campaign", (req, res) => {
  try { writeJson("campaign.json", req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- live message preview (renders variables) ----------
app.post("/api/preview", (req, res) => {
  try {
    const text = String(req.body?.text || "");
    const cfg = readJson("config.json");
    // use the first real contact for realistic columns, else a sample
    let row = { name: "Ahmed" };
    try {
      const rows = parseCsv(fs.readFileSync(dataPath("contacts.csv"), "utf8"), {
        columns: true, skip_empty_lines: true, trim: true,
      });
      if (rows.length) row = rows[0];
    } catch {}
    const rendered = template(text, row, {
      locale: cfg.vars?.locale,
      timezone: cfg.vars?.timezone,
    });
    res.json({ rendered });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- contacts (raw CSV text) ----------
app.get("/api/contacts", (_req, res) => {
  res.type("text/plain").send(fs.readFileSync(dataPath("contacts.csv"), "utf8"));
});
app.post("/api/contacts", (req, res) => {
  try {
    const csv = typeof req.body === "string" ? req.body : req.body.csv;
    if (!csv || !/(^|\n)\s*number/i.test(csv))
      throw new Error('CSV must have a "number" column');
    fs.writeFileSync(dataPath("contacts.csv"), csv.trim() + "\n");
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- media upload ----------
app.post("/api/media", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const ext = path.extname(req.file.originalname) || "";
  const filename = req.file.filename + ext;
  fs.renameSync(req.file.path, path.join(MEDIA_DIR, filename));
  const rel = "media/" + filename; // stored relative to DATA_DIR

  const campaign = readJson("campaign.json");
  campaign.media = { ...(campaign.media || {}), enabled: true, path: rel };
  writeJson("campaign.json", campaign);

  res.json({ ok: true, path: rel, name: req.file.originalname });
});

// ---------- insights ----------
app.get("/api/insights", (req, res) => {
  try { res.json(computeInsights({ days: Math.min(90, +req.query.days || 30) })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// estimated send time for N contacts (uses current settings + message length)
app.get("/api/estimate", (req, res) => {
  try {
    const cfg = readJson("config.json");
    let avgLen = 60;
    try {
      const msgs = [].concat(readJson("campaign.json").message || []);
      if (msgs.length) avgLen = Math.round(msgs.reduce((s, m) => s + String(m).length, 0) / msgs.length);
    } catch {}
    let count = +req.query.count;
    if (!count) { // default: how many contacts are in the list
      try {
        count = parseCsv(fs.readFileSync(dataPath("contacts.csv"), "utf8"), { columns: true, skip_empty_lines: true, trim: true }).length;
      } catch { count = 0; }
    }
    res.json({ ...estimateDuration(count, cfg, avgLen), avgMessageLength: avgLen });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// auto-tune: suggest delay settings to hit a target finish time
app.get("/api/autotune", (req, res) => {
  try {
    const cfg = readJson("config.json");
    let avgLen = 60, count = +req.query.count;
    try {
      const msgs = [].concat(readJson("campaign.json").message || []);
      if (msgs.length) avgLen = Math.round(msgs.reduce((s, m) => s + String(m).length, 0) / msgs.length);
    } catch {}
    if (!count) {
      try { count = parseCsv(fs.readFileSync(dataPath("contacts.csv"), "utf8"), { columns: true, skip_empty_lines: true, trim: true }).length; } catch { count = 0; }
    }
    const targetSeconds = Math.max(60, (+req.query.hours || 1) * 3600);
    res.json({ ...suggestSettings(count, targetSeconds, cfg, avgLen), count, targetHours: +req.query.hours || 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// schedule a campaign start
app.post("/api/schedule", (req, res) => {
  const at = Date.parse(req.body?.at);
  if (isNaN(at)) return res.status(400).json({ error: "Invalid date/time" });
  if (at < Date.now() - 60000) return res.status(400).json({ error: "That time is in the past" });
  engine.schedule(at);
  res.json({ ok: true, scheduledAt: at });
});
app.post("/api/schedule/cancel", (_req, res) => { engine.cancelSchedule(); res.json({ ok: true }); });

// ---------- drip sequences ----------
app.get("/api/sequences", (_req, res) => res.json({ ...loadSequences(), stats: dripStats() }));
app.post("/api/sequences", (req, res) => {
  try { saveSequences({ sequences: req.body.sequences || [] }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/sequences/enroll", (req, res) => {
  try {
    const cfg = readJson("config.json");
    let contacts = req.body.contacts;
    if (!contacts) {
      contacts = parseCsv(fs.readFileSync(dataPath("contacts.csv"), "utf8"), { columns: true, skip_empty_lines: true, trim: true });
    }
    const added = enroll(req.body.sequenceId, contacts, cfg.countryCode, Date.now());
    res.json({ ok: true, added });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- short links ----------
app.get("/api/links", (_req, res) => res.json({ links: linksWithStats(), publicUrl: (readJson("config.json").publicUrl || "") }));
app.post("/api/links", (req, res) => {
  try { res.json(createLink(req.body.url, req.body.name)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// re-engage: contacts we messaged who never replied
app.get("/api/non-repliers", (_req, res) => {
  try { res.json(nonRepliers()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/engaged", (_req, res) => { try { res.json(engagedContacts()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/failed", (_req, res) => { try { res.json(failedContacts()); } catch (e) { res.status(500).json({ error: e.message }); } });

// blocklist / opt-out list
app.get("/api/blocklist", (_req, res) => res.json({ numbers: [...loadBlocklist()] }));
app.post("/api/blocklist", (req, res) => {
  try { res.json({ ok: true, numbers: saveBlocklist(req.body.numbers || []) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// per-contact history
app.get("/api/history", (req, res) => {
  try {
    const cc = readJson("config.json").countryCode;
    res.json(contactHistory(String(req.query.number || ""), cc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// export results as a CSV download
app.get("/api/export", (_req, res) => {
  const file = dataPath("results.csv");
  if (!fs.existsSync(file)) return res.status(404).send("No results yet.");
  res.setHeader("Content-Disposition", 'attachment; filename="watitool-results.csv"');
  res.type("text/csv").send(fs.readFileSync(file, "utf8"));
});

// ---------- auto-reply & flows ----------
app.get("/api/autoreply", (_req, res) => res.json(readJson("autoreply.json")));
app.post("/api/autoreply", (req, res) => {
  try { writeJson("autoreply.json", req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/flows", (_req, res) => res.json(readJson("flows.json")));
app.post("/api/flows", (req, res) => {
  try { writeJson("flows.json", req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// generic media upload (returns stored path; used by auto-reply & flow editors)
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const ext = path.extname(req.file.originalname) || "";
  const filename = req.file.filename + ext;
  fs.renameSync(req.file.path, path.join(MEDIA_DIR, filename));
  res.json({ ok: true, path: "media/" + filename, name: req.file.originalname });
});

// chat simulator — runs the real bot engine against typed input, sends nothing
let simStore = memStore();
app.post("/api/bot/simulate", (req, res) => {
  try {
    if (req.body?.reset) { simStore = memStore(); return res.json({ reset: true }); }
    const config = readJson("config.json");
    let autoreply = {}, flows = [];
    try { autoreply = readJson("autoreply.json"); } catch {}
    try { flows = readJson("flows.json"); } catch {}
    const plan = planReply(
      { from: "sim", body: String(req.body?.body || ""), name: req.body?.name || "You" },
      { config, autoreply, flows, store: simStore }
    );
    res.json(plan);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- run control ----------
app.post("/api/run", async (req, res) => {
  const dryRun = !!req.body?.dryRun;
  try {
    // fire and forget; progress streams over SSE
    engine.run({ dryRun }).catch((e) => engine.log("error", e.message));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/stop", (_req, res) => { engine.stop(); res.json({ ok: true }); });
app.post("/api/pause", (_req, res) => { engine.pause(); res.json({ ok: true }); });
app.post("/api/resume", (_req, res) => { engine.resume(); res.json({ ok: true }); });

// ---------- results ----------
app.get("/api/results", (_req, res) => {
  if (!fs.existsSync(dataPath("results.csv"))) return res.json([]);
  const lines = fs.readFileSync(dataPath("results.csv"), "utf8").trim().split("\n").slice(1);
  const rows = lines.filter(Boolean).map((l) => {
    const m = l.match(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g) || [];
    const cells = l.split(",");
    return {
      number: cells[0],
      name: (cells[1] || "").replace(/^"|"$/g, "").replace(/""/g, '"'),
      status: cells[2],
    };
  });
  res.json(rows.reverse());
});

app.post("/api/results/clear", (_req, res) => {
  try { if (fs.existsSync(dataPath("results.csv"))) fs.unlinkSync(dataPath("results.csv")); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(
    color.green("\n  watitool dashboard ") +
      color.gray("→ ") +
      color.cyan(`http://localhost:${PORT}`)
  );
  if (!authEnabled()) {
    console.log(color.yellow("  ⚠ No password set — anyone who reaches this URL can use it."));
    console.log(color.gray("    Set one in config.json (auth.password) or env WATITOOL_PASSWORD before going online.\n"));
  } else if (getPassword() === "changeme") {
    console.log(color.yellow("  ⚠ Password is still the default 'changeme' — change it before sharing!\n"));
  } else {
    console.log(color.green("  🔒 Password protection ON.\n"));
  }
});
