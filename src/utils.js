import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { dataPath } from "./paths.js";

// ---- console colors (no dependency) ----
const c = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
export const color = {
  green: c("32"),
  red: c("31"),
  yellow: c("33"),
  cyan: c("36"),
  gray: c("90"),
  bold: c("1"),
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Random integer in [min, max] inclusive. */
export const randInt = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

/** Pick a random element from an array. */
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Turn a raw phone number into a WhatsApp JID (e.g. "201001234567@c.us").
 * - strips spaces, dashes, parentheses, leading "+" and "00"
 * - if the result is short / has no country code, prepends the default one
 */
export function toJid(raw, defaultCountryCode) {
  let n = String(raw).trim();
  n = n.replace(/[\s\-()]/g, "");
  n = n.replace(/^\+/, "");
  n = n.replace(/^00/, "");
  n = n.replace(/\D/g, "");

  // Heuristic: numbers shorter than ~11 digits usually lack a country code.
  const cc = String(defaultCountryCode || "").replace(/\D/g, "");
  if (cc && n.length <= 10) n = cc + n.replace(/^0+/, "");

  return { number: n, jid: `${n}@c.us` };
}

/**
 * Built-in dynamic variables available in every message.
 * locale/timezone are optional (e.g. "ar-EG", "Africa/Cairo").
 */
export function builtinVars(now = new Date(), opts = {}) {
  const { locale, timezone } = opts;
  const fmt = (o) =>
    new Intl.DateTimeFormat(locale || undefined, { timeZone: timezone || undefined, ...o }).format(now);
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone || undefined, hour: "2-digit", hour12: false }).format(now)
  );
  // Arabic uses a simple two-way split at noon: صباح الخير / مساء الخير.
  const greetingAr = hour < 12 ? "صباح الخير" : "مساء الخير";
  const greetingEn = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const isArabic = /^ar\b/i.test(String(locale || ""));
  const greeting = isArabic ? greetingAr : greetingEn;
  return {
    date: fmt({ year: "numeric", month: "long", day: "numeric" }),
    shortdate: fmt({ year: "numeric", month: "2-digit", day: "2-digit" }),
    time: fmt({ hour: "2-digit", minute: "2-digit" }),
    day: fmt({ weekday: "long" }),
    month: fmt({ month: "long" }),
    year: fmt({ year: "numeric" }),
    greeting,          // locale-aware (Arabic when vars.locale is ar-*)
    greeting_ar: greetingAr, // always Arabic
    greeting_en: greetingEn, // always English
  };
}

/** Resolve a {{random[:arg]}} token. */
function randomToken(arg) {
  if (!arg) return String(randInt(1, 100));
  if (arg.includes("|")) return pick(arg.split("|").map((s) => s.trim()));
  const m = arg.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) return String(randInt(+m[1], +m[2]));
  return arg;
}

/**
 * Render a message template.
 * Supports: {{column}} from the CSV, built-ins ({{date}}, {{time}}, {{day}},
 * {{greeting}}, {{month}}, {{year}}, {{firstname}}), {{random}} /
 * {{random:1000-9999}} / {{random:a|b|c}}, and inline spintax {hi|hey|hello}.
 */
export function template(text, row = {}, opts = {}) {
  const now = opts.now || new Date();
  const builtins = builtinVars(now, opts);

  // 1) {{ ... }} placeholders
  let out = String(text).replace(/\{\{\s*([\w.]+)(?::([^}]+))?\s*\}\}/g, (_, key, arg) => {
    // exact CSV column
    if (row && key in row) return row[key] == null ? "" : String(row[key]);
    const lk = key.toLowerCase();
    // case-insensitive CSV column
    if (row) {
      const ck = Object.keys(row).find((k) => k.toLowerCase() === lk);
      if (ck) return row[ck] == null ? "" : String(row[ck]);
    }
    if (lk === "if") {
      // {{if:VAR=VALUE?yes-text:no-text}} (also != and bare VAR for "exists")
      const q = arg.indexOf("?");
      if (q < 0) return "";
      const cond = arg.slice(0, q), rest = arg.slice(q + 1);
      const c = rest.indexOf(":");
      const yes = c < 0 ? rest : rest.slice(0, c);
      const no = c < 0 ? "" : rest.slice(c + 1);
      const getv = (k) => {
        const kk = k.trim();
        if (kk in row) return row[kk];
        const lk2 = kk.toLowerCase(); const ck = Object.keys(row).find((x) => x.toLowerCase() === lk2);
        return ck ? row[ck] : undefined;
      };
      const ne = cond.match(/^(.+?)\s*!=\s*(.*)$/), eqm = cond.match(/^(.+?)\s*=\s*(.*)$/);
      let pass;
      if (ne) pass = String(getv(ne[1]) ?? "").toLowerCase().trim() !== ne[2].toLowerCase().trim();
      else if (eqm) pass = String(getv(eqm[1]) ?? "").toLowerCase().trim() === eqm[2].toLowerCase().trim();
      else pass = String(getv(cond) ?? "").trim().length > 0;
      return template(pass ? yes : no, row, opts); // resolve nested vars in the chosen branch
    }
    if (lk === "daysleft" || lk === "countdown") {
      const t = Date.parse((arg || "").trim());
      if (isNaN(t)) return "";
      return String(Math.max(0, Math.ceil((t - now.getTime()) / 86400000)));
    }
    if (lk === "track") {
      // {{track:CODE}} → tracked short link with the contact appended for click attribution
      const base = String(opts.publicUrl || "").replace(/\/$/, "");
      if (!base) return "";
      const num = opts.number || row.number || row._number || "";
      return `${base}/l/${(arg || "").trim()}${num ? "?c=" + encodeURIComponent(num) : ""}`;
    }
    if (lk === "random") return randomToken(arg ? arg.trim() : "");
    if (lk === "firstname") {
      const n = row.name || row.Name || row.firstname || "";
      return String(n).trim().split(/\s+/)[0] || "";
    }
    if (lk in builtins) return builtins[lk];
    return ""; // unknown → empty
  });

  // 2) inline spintax: {a|b|c} → one chosen at random
  out = out.replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, (_, body) => pick(body.split("|")).trim());

  return out;
}

/** Load contacts from a CSV file. Must have a "number" column. */
export function loadContacts(file) {
  const raw = fs.readFileSync(dataPath(file), "utf8");
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true, // a row missing the name (or extra columns) shouldn't abort the whole file
  });
  if (!rows.length) throw new Error(`No rows found in ${file}`);
  if (!("number" in rows[0]))
    throw new Error(`${file} must have a "number" column`);
  return rows;
}

export function loadJson(file) {
  return JSON.parse(fs.readFileSync(dataPath(file), "utf8"));
}

// ---- results log (CSV) for resume + reporting ----
const RESULTS_FILE = dataPath("results.csv");

export function readSentNumbers() {
  if (!fs.existsSync(RESULTS_FILE)) return new Set();
  const raw = fs.readFileSync(RESULTS_FILE, "utf8");
  const sent = new Set();
  for (const line of raw.split("\n").slice(1)) {
    const [number, , status] = line.split(",");
    if (number && status === "sent") sent.add(number.trim());
  }
  return sent;
}

export function appendResult(number, name, status, detail = "") {
  const exists = fs.existsSync(RESULTS_FILE);
  if (!exists) {
    fs.writeFileSync(RESULTS_FILE, "number,name,status,detail,timestamp\n");
  }
  const safe = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const line = [
    number,
    safe(name),
    status,
    safe(detail),
    new Date().toISOString(),
  ].join(",");
  fs.appendFileSync(RESULTS_FILE, line + "\n");
}
