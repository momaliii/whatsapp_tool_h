# Deploying watitool on Railway

Railway runs the app as an always-on container (built from the `Dockerfile`),
gives you an HTTPS URL automatically, and — with a **volume** — keeps your
WhatsApp login and data across restarts and redeploys.

You scan the QR **once** from the dashboard; everyone else just opens the URL and
logs in with the shared password.

> 💡 The single most important step is **#4 (add a Volume + `DATA_DIR`)**. Without
> it, every redeploy logs WhatsApp out. Do it *before* you scan the QR.

---

## Step 1 — Put the code on GitHub

Push this folder to a GitHub repo (private is fine). Railway deploys from it.

## Step 2 — Create the project

1. Go to **railway.com** → **New Project** → **Deploy from GitHub repo**.
2. Pick your repo. Railway detects the `Dockerfile` and starts building
   (first build takes a few minutes — it installs Chromium).

## Step 3 — Set environment variables

Open the service → **Variables** → add:

| Variable | Value |
|---|---|
| `WATITOOL_PASSWORD` | a strong password (what users type to log in) |
| `DATA_DIR` | `/data` |

(Don't set `PORT` — Railway provides it and the app uses it automatically.)

## Step 4 — Add the Volume (the important one)

Service → **Settings** → **Volumes** → **+ New Volume** → set the **Mount path**
to:

```
/data
```

This is where the WhatsApp session, contacts, message, settings, results and
media are stored — so they survive restarts. `DATA_DIR=/data` from Step 3 tells
the app to use it.

## Step 5 — Get a URL

Service → **Settings** → **Networking** → **Generate Domain**. You'll get
something like `https://watitool-production.up.railway.app` (HTTPS already on).

## Step 6 — Redeploy, then connect WhatsApp

1. Trigger a redeploy (Railway usually does this automatically after adding the
   volume/variables — if not, **Deploy** → **Redeploy**).
2. Open your Railway URL, log in with `WATITOOL_PASSWORD`.
3. **Connection** tab → **Connect** → scan the QR with
   WhatsApp → Linked Devices.

Done. Share the URL + password with whoever should have access — everyone sends
from your one connected number.

---

## Alternative: deploy with the Railway CLI (no GitHub)

```bash
npm i -g @railway/cli
railway login
railway init           # create a project
railway up             # build & deploy this folder
# then in the dashboard: add the Volume at /data and the variables above
railway domain         # generate a public URL
```

## Notes

- **Always-on:** use Railway's Hobby plan (~$5/mo). It does **not** sleep, which
  is required — a sleeping app drops the WhatsApp session.
- **Memory:** Chromium needs roughly 1 GB. If deploys get OOM-killed, bump the
  service resources.
- **Rotating the password:** change `WATITOOL_PASSWORD` in Variables and redeploy;
  everyone's session is logged out.
- **Re-scanning:** only needed if you log out, or if you ever deploy *without* the
  volume mounted. With the volume, the login sticks.
- **Backups:** download `/data/.wwebjs_auth` (and `results.csv`) from the volume
  if you want a backup of the session/history.
