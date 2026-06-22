import crypto from "node:crypto";
import fs from "node:fs";
import { dataPath } from "./paths.js";

const SESSIONS = new Map(); // token -> expiry (ms)
const WEEK = 7 * 24 * 3600 * 1000;

/** Password comes from env (preferred for hosting) or config.json → auth.password. */
export function getPassword() {
  if (process.env.WATITOOL_PASSWORD) return process.env.WATITOOL_PASSWORD;
  try {
    const c = JSON.parse(fs.readFileSync(dataPath("config.json"), "utf8"));
    if (c.auth && c.auth.password) return String(c.auth.password);
  } catch {}
  return null;
}

export function authEnabled() {
  return !!getPassword();
}

export function checkPassword(pw) {
  const real = getPassword();
  if (!real) return true; // auth disabled
  const a = Buffer.from(String(pw ?? ""));
  const b = Buffer.from(String(real));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  SESSIONS.set(token, Date.now() + WEEK);
  return token;
}

export function validToken(token) {
  if (!token) return false;
  const exp = SESSIONS.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    SESSIONS.delete(token);
    return false;
  }
  return true;
}

export function destroySession(token) {
  if (token) SESSIONS.delete(token);
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function getToken(req) {
  return parseCookies(req).wati_session;
}

export function sessionCookie(req, token, clear = false) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const age = clear ? 0 : 7 * 24 * 3600;
  return (
    `wati_session=${clear ? "" : token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}` +
    (secure ? "; Secure" : "")
  );
}

/** Express middleware: gate everything except the public login routes. */
export function requireAuth(req, res, next) {
  if (!authEnabled()) return next();
  if (validToken(getToken(req))) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
  return res.redirect("/login");
}
