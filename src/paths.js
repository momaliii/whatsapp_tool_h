import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Repo/app root (one level up from /src).
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * All mutable state lives under DATA_DIR. Locally (and on the VPS) this is the
 * app folder itself, so nothing changes. On single-volume hosts (Railway, Fly,
 * Render) set DATA_DIR to the mounted volume path (e.g. /data) and everything —
 * the WhatsApp session, config, contacts, results, media — persists there.
 */
export const DATA_DIR = path.resolve(process.env.DATA_DIR || APP_ROOT);

/** Resolve a name/relative path against DATA_DIR (absolute paths pass through). */
export const dataPath = (f) => (path.isAbsolute(f) ? f : path.join(DATA_DIR, f));

export const AUTH_DIR = dataPath(".wwebjs_auth");
export const MEDIA_DIR = dataPath("media");

/** Seed default files into a fresh DATA_DIR and make sure folders exist. */
export function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  if (DATA_DIR === APP_ROOT) return; // local/VPS: defaults already present
  for (const f of ["config.json", "campaign.json", "contacts.csv", "autoreply.json", "flows.json"]) {
    const dest = dataPath(f);
    const src = path.join(APP_ROOT, f);
    if (!fs.existsSync(dest) && fs.existsSync(src)) fs.copyFileSync(src, dest);
  }
}
