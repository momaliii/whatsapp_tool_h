# Deploying watitool online (VPS, always-on)

This puts the dashboard on a Linux server so it runs 24/7 — others can open it
in a browser, log in with the shared password, and send from your one WhatsApp
number. You scan the QR **once**, from the web dashboard, and the session stays
logged in even when your own computer is off.

It runs as two containers:
- **app** — watitool (Node + headless Chromium / WhatsApp Web)
- **caddy** — reverse proxy that gives you **automatic HTTPS** for your domain

---

## What you need

1. **A VPS** — Ubuntu 22.04, **2 GB RAM** recommended (Chromium is hungry; 1 GB
   can work but add swap). ~$5–6/mo on Hetzner, DigitalOcean, Vultr, etc.
2. **A domain or subdomain** you can edit DNS for (e.g. `wati.yourdomain.com`).
   HTTPS needs this — don't run the password over plain `http`.

---

## Step 1 — Point the domain at the server

In your DNS provider, add an **A record**:

```
wati.yourdomain.com   →   <your server's IP>
```

Wait a few minutes for it to take effect.

## Step 2 — Install Docker on the server

SSH in, then:

```bash
curl -fsSL https://get.docker.com | sh
```

## Step 3 — Get the code onto the server

Either `git clone` your repo, or copy this folder up with `scp`:

```bash
scp -r ./watitool root@<server-ip>:/root/watitool
```

Then on the server:

```bash
cd /root/watitool      # or wherever you put it
```

## Step 4 — Configure

```bash
cp .env.example .env
nano .env              # set a strong WATITOOL_PASSWORD and your DOMAIN
touch results.csv      # so the results bind-mount has a file to attach to
```

> Tip: you can leave `auth.password` in `config.json` as-is — the
> `WATITOOL_PASSWORD` in `.env` overrides it and keeps the real password out of
> any file you might commit.

## Step 5 — Launch

```bash
docker compose up -d --build
```

First build takes a few minutes (it installs Chromium). Check it's up:

```bash
docker compose ps
docker compose logs -f app
```

## Step 6 — Connect WhatsApp (once)

1. Open **https://wati.yourdomain.com** in your browser.
2. Log in with the password.
3. Go to the **Connection** tab → **Connect** → scan the QR with
   WhatsApp → Linked Devices.

That's it. The session is stored in a Docker volume, so it stays connected
across restarts and redeploys. Share the URL + password with whoever should
have access.

---

## Day-to-day

| Task | Command |
|---|---|
| View logs | `docker compose logs -f app` |
| Restart | `docker compose restart` |
| Stop | `docker compose down` |
| Update after code changes | `git pull && docker compose up -d --build` |
| Back up the WhatsApp session | `docker run --rm -v watitool_wwebjs_auth:/d -v $PWD:/b alpine tar czf /b/session-backup.tgz -C /d .` |

## Notes & safety

- **One account, shared access.** Everyone with the URL + password sends from
  *your* number. Treat the password like a key; rotate it by changing
  `WATITOOL_PASSWORD` and running `docker compose up -d`.
- **Keep the sending slow.** Being online 24/7 makes it tempting to blast — the
  same ban risk applies. The safe defaults in `config.json` still matter.
- **Sessions log out** in everyone's browser whenever you change the password.
- **No domain yet?** You can test over plain HTTP by temporarily mapping the app
  port (add `ports: ["3000:3000"]` to the `app` service and open
  `http://<server-ip>:3000`) — but **don't** use a real password that way; the
  login would be unencrypted. Get a domain for anything real.
