import fs from "node:fs";
import { dataPath } from "./paths.js";

const FILE = "templates.json";

export function loadTemplates() {
  try { return JSON.parse(fs.readFileSync(dataPath(FILE), "utf8")); } catch { return { templates: [] }; }
}
function save(o) { fs.writeFileSync(dataPath(FILE), JSON.stringify(o, null, 2)); }

/** Save the current campaign (message + media) as a named template. */
export function saveTemplate(name, campaign) {
  const o = loadTemplates();
  const id = "tpl_" + Math.random().toString(36).slice(2, 7);
  o.templates.push({
    id, name: name || "Untitled",
    message: campaign.message || [],
    media: campaign.media || { enabled: false, path: "" },
    sendCaptionAsSeparateText: !!campaign.sendCaptionAsSeparateText,
    savedAt: new Date().toISOString(),
  });
  save(o);
  return { id };
}

export function getTemplate(id) {
  return loadTemplates().templates.find((t) => t.id === id);
}

export function deleteTemplate(id) {
  const o = loadTemplates();
  o.templates = o.templates.filter((t) => t.id !== id);
  save(o);
}
