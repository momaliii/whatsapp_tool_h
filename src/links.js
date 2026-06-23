import fs from "node:fs";
import { dataPath } from "./paths.js";

const LINKS_FILE = "links.json";
const CLICKS_FILE = "clicks.jsonl";

export function loadLinks() {
  try { return JSON.parse(fs.readFileSync(dataPath(LINKS_FILE), "utf8")); } catch { return { links: [] }; }
}
function saveLinks(o) { fs.writeFileSync(dataPath(LINKS_FILE), JSON.stringify(o, null, 2)); }

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
const rand = () => Math.random().toString(36).slice(2, 7);

/** Create (or reuse by name) a short link. Returns {code, url, name}. */
export function createLink(url, name) {
  if (!/^https?:\/\//i.test(url || "")) throw new Error("URL must start with http:// or https://");
  const o = loadLinks();
  let code = slug(name) || slug(url) || rand();
  if (o.links.some((l) => l.code === code)) code = code + "-" + rand();
  const link = { code, url, name: name || url, createdAt: new Date().toISOString() };
  o.links.push(link);
  saveLinks(o);
  return link;
}

export function findLink(code) {
  return loadLinks().links.find((l) => l.code === code);
}

export function logClick(code, contact, ua) {
  try {
    fs.appendFileSync(dataPath(CLICKS_FILE), JSON.stringify({ time: new Date().toISOString(), code, c: contact || "", ua: (ua || "").slice(0, 120) }) + "\n");
  } catch {}
}

function readClicks() {
  try {
    return fs.readFileSync(dataPath(CLICKS_FILE), "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Links with click totals + unique contacts who clicked. */
export function linksWithStats() {
  const clicks = readClicks();
  const byCode = {};
  for (const c of clicks) {
    (byCode[c.code] ||= { total: 0, contacts: new Set() }).total++;
    if (c.c) byCode[c.code].contacts.add(c.c);
  }
  return loadLinks().links.map((l) => ({
    ...l,
    clicks: byCode[l.code]?.total || 0,
    uniqueContacts: byCode[l.code]?.contacts.size || 0,
    clickedBy: [...(byCode[l.code]?.contacts || [])],
  })).reverse();
}
