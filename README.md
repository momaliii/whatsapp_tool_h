# watitool 📲

Safe, human-like **bulk WhatsApp sender** — no Cloud API, no Business account.
It drives your normal WhatsApp through **WhatsApp Web** (one-time QR scan), so it
behaves like you sending from your own phone.

## What it does

- ✅ Send **text**, or **image / video / file** with the text as caption
- ⌨️ Shows the real **"typing…"** indicator before each message (length-based)
- 🎲 **Random delay** between messages + longer **batch breaks** (anti-ban)
- 🔍 Skips numbers that **aren't on WhatsApp** (`isRegisteredUser`)
- 🔁 **Resumable** — never messages the same number twice (`results.csv`)
- 🌀 **Message variants** — picks one of several phrasings at random per contact
- 🧩 **Templating** — `{{name}}` and any CSV column
- 📊 Live **progress bar** with sent / failed / skipped + live countdown

## Setup

```bash
npm install
```

> First install downloads a headless Chromium (used to run WhatsApp Web).

## 🌐 Putting it online (so others can use it)

This tool keeps a real browser + WhatsApp session running, so it needs an
**always-on** host (not Netlify/Vercel — those are stateless and would log
WhatsApp out). All state lives under one folder (`DATA_DIR`), so any host with a
persistent volume works.

- **Railway** (easiest) → see **[RAILWAY.md](RAILWAY.md)**. Deploy from GitHub,
  add a volume at `/data`, set `DATA_DIR=/data` + `WATITOOL_PASSWORD`. HTTPS is
  automatic.
- **Your own VPS** (Docker + Caddy + HTTPS) → see **[DEPLOY.md](DEPLOY.md)**.

Either way you scan the QR **once** from the dashboard and the session persists.

> `DATA_DIR` (default: the app folder) is where the WhatsApp session, config,
> contacts, results and media are stored. Point it at a mounted volume on hosted
> platforms so everything survives restarts/redeploys.

## 🔒 Password

The dashboard is protected by a password. Set it in `config.json`:

```json
"auth": { "password": "your-strong-password" }
```

…or via an environment variable (recommended when hosting — keeps it out of the file):

```bash
WATITOOL_PASSWORD="your-strong-password" npm start
```

Leave it empty (`""`) to disable the gate (local use only). The default is
`changeme` — **change it before putting the dashboard online.** The server prints
a warning on startup until you do.

## 🖥️ The dashboard (recommended)

Manage everything from your browser — no editing files by hand:

```bash
npm start
```

Then open **http://localhost:3000**. The dashboard has 5 tabs:

1. **Connection** — click *Connect*, scan the QR with WhatsApp → Linked Devices.
2. **Contacts** — paste/import your CSV, validate numbers, save.
3. **Message** — write message variants, attach image/video/file, live preview.
4. **Settings** — delays, typing, batch breaks, safety toggles.
5. **Send** — *Dry run* or *Start sending* with a live progress bar, log, and results.

Everything below (CLI) still works and shares the same files/engine — use whichever you prefer.

---

## 1. Edit your files

- **`contacts.csv`** — must have a `number` column. Add `name` and any other
  columns you want to use as `{{placeholders}}`. Numbers can be local
  (`01001234567`) or international (`+201001234567`); the default `countryCode`
  in `config.json` is added when missing.
- **`campaign.json`** — the message text (give several variants), and optional
  media path.
- **`config.json`** — delays, typing, batch breaks, safety. **Defaults are
  deliberately slow and safe.**

## 2. Validate (no sending)

```bash
node index.js check          # see how each number normalizes
node index.js send --dry-run # simulate the whole run, send nothing
```

## 3. Log in & send

```bash
node index.js login   # scan the QR with WhatsApp → Linked Devices (once)
node index.js send    # run the campaign
```

Results are written to **`results.csv`** (number, name, status, detail, time).
Re-running `send` automatically skips anyone already marked `sent`.

## Message variables

Drop these into any message (or click the chips in the dashboard). They're
filled in fresh for **every** message, so each contact gets a slightly different
text — more human, less "blast".

| Variable | Becomes |
|---|---|
| `{{name}}`, `{{city}}`, … | Any column from `contacts.csv` |
| `{{firstname}}` | First word of the contact's name |
| `{{greeting}}` | Good morning / afternoon / evening (by time of day) |
| `{{date}}` | e.g. `June 23, 2026` |
| `{{time}}` | e.g. `09:30` |
| `{{day}}` | Weekday, e.g. `Tuesday` |
| `{{month}}` / `{{year}}` | `June` / `2026` |
| `{{random}}` | Random number 1–100 |
| `{{random:1000-9999}}` | Random number in a range (great for codes) |
| `{{random:a|b|c}}` | Picks one of the options |
| `{hi|hey|hello}` | **Spintax** — picks one at random inline |

Date/time formatting follows `vars.locale` + `vars.timezone` in `config.json`
(e.g. `"ar-EG"` + `"Africa/Cairo"` for Arabic dates in Cairo time).

**Multiple wordings:** separate full message variants with a line containing
only `---`; one variant is chosen at random per contact.

## Sending media

In `campaign.json`:

```json
"media": { "enabled": true, "path": "./media/promo.jpg" }
```

- Image/video → the `message` text becomes the **caption**.
- PDF / doc / any file → set `"sendCaptionAsSeparateText": true` so the text is
  sent as its own message after the file.

## 📊 Insights

The **Insights** tab turns your activity into a dashboard:

- **Stat cards** — contacts, messages sent, failed, delivery rate, bot replies.
- **Activity chart** — stacked sent / failed / skipped / bot-replies per day (14d).
- **Outcome breakdown** — donut of sent vs failed vs skipped.
- **Top bot triggers** — which keywords/flows fire most.
- **Recent activity** — a live feed of sends and bot replies.

Data comes from `results.csv` (campaign sends) and `bot-log.jsonl` (auto-reply &
flow activity, recorded automatically). Hit **Refresh** any time.

Also on Insights: a **7d / 30d / 90d** range switch, an **⬇ Export** button
(downloads `results.csv`), and a **Contact lookup** — type a number to see that
person's full history (every send + bot reply).

## ⏱️ How long will a send take?

The **Send** tab shows a live **Estimated time** based on your current settings —
type any number (e.g. `1000`) or click *use my list*. With the safe defaults,
**1000 contacts ≈ 20 hours**: this is intentional. The breakdown line shows the
avg gap, batch breaks, and a projected finish time.

Want it faster? Lower the delays / batch breaks on the **Settings** tab and the
estimate updates — e.g. aggressive settings cut 1000 contacts to ~5h, but **the
faster you go, the higher the ban risk.** There is no safe way to blast 1000
messages in minutes from a normal WhatsApp account.

**Auto-tune** — under the estimate, enter a target ("finish in 10 hours") and
click *Suggest settings*. It works out the gap (and shrinks batch breaks if
needed) to hit that time, rates the result **safe / risky / very-risky**, and
one click applies it. If a target isn't safely achievable it tells you the
fastest realistic time instead.

## 🗓️ Scheduling & sending window

- **Schedule start** (Send tab) — pick a date/time and the campaign auto-starts
  then (as long as you're connected). The schedule survives restarts.
- **Sending window** (Settings tab) — restrict sending to set hours (e.g.
  09:00–21:00, server local time; overnight windows like 22:00–06:00 work too). A
  long campaign **pauses outside the window and resumes** when it reopens — so a
  20-hour send never messages people at 3am. Pair the two: schedule for 9am with
  a 9–9 window and a big list spreads cleanly across business hours.

## 🤖 Auto-reply & flows (incoming messages)

watitool can also **reply automatically** to people who message your connected
number — turn it on with the master switch on the **Auto-reply** tab. It only
runs while connected, and pauses itself while a bulk campaign is sending.

**Auto-reply (keyword rules)** — when an incoming message matches a rule's
keywords (`contains` / `exact` / `starts` / `regex`), the bot sends that rule's
reply: text, image, video, file, a **voice note**, or several of these. First
matching rule wins. Variables like `{{name}}` and `{{time}}` work here too.

**Flows (interactive menu bot)** — a keyword starts a flow; the bot sends a
menu, **waits** for the reply, branches (`1`/`2`/`3` or keywords), can send media
and **collect** answers into variables, then continue or end. Edit flows on the
**Flows** tab and **test them live in the built-in chat simulator** — no WhatsApp
needed. Step keys: `send`, `options`, `collect`, `next`, `end`, `fallback` (see
the "Step reference" in the tab, and `flows.json`).

Settings live in `config.json → bot` (`enabled`, `replyInGroups`,
`cooldownSeconds`, `exitKeywords`). An active flow takes priority over keyword
rules; the `exitKeywords` (cancel/stop/exit) end a flow.

## Staying safe (please read)

This tool is for messaging **people who expect to hear from you** (your
customers, your contacts, opt-in lists). Blasting strangers is spam, violates
WhatsApp's Terms, and **will get your number banned** — no tool can prevent that.

To keep an account healthy:

- Warm up new numbers: start with `maxPerRun: 20–30`/day, raise slowly.
- Keep delays human (the defaults: 25–70s, plus a 12-min break every 40).
- Personalize (`{{name}}`) and vary the wording (multiple `message` variants).
- Make it easy to opt out; stop messaging anyone who asks.

You are responsible for how you use it and for complying with WhatsApp's Terms
and the laws in your country.
