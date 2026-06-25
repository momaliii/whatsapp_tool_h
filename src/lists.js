import fs from "node:fs";
import { dataPath } from "./paths.js";

const FILE = "contact-lists.json";

function load() {
  try { return JSON.parse(fs.readFileSync(dataPath(FILE), "utf8")); } catch { return { lists: [] }; }
}
function save(o) { fs.writeFileSync(dataPath(FILE), JSON.stringify(o, null, 2)); }

const countRows = (csv) => Math.max(0, String(csv || "").trim().split("\n").filter(Boolean).length - 1);

/** Metadata for all saved lists (no CSV bodies). */
export function listMeta() {
  return load().lists.map((l) => ({ id: l.id, name: l.name, count: countRows(l.csv), savedAt: l.savedAt }));
}

/** Save a CSV as a named list (overwrites a same-named list). Returns {id}. */
export function saveList(name, csv) {
  const o = load();
  name = (name || "Untitled").trim();
  const existing = o.lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (existing) { existing.csv = csv; existing.savedAt = new Date().toISOString(); save(o); return { id: existing.id }; }
  const id = "list_" + Math.random().toString(36).slice(2, 7);
  o.lists.push({ id, name, csv, savedAt: new Date().toISOString() });
  save(o);
  return { id };
}

export function getList(id) { return load().lists.find((l) => l.id === id); }

export function deleteList(id) {
  const o = load();
  o.lists = o.lists.filter((l) => l.id !== id);
  save(o);
}
