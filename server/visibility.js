// Who may download a file under /wp-content/uploads/.
// Automatic (the default): a file is public when the published site uses it,
// that is, it is attached to a published post or page, or a published page links
// to it or shows it. Any other file (say, one whose only post is still a draft)
// is private. An editor can pin a file to "public" or "private" either way.
// Private files are served to signed-in editors only.
import { readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { db } from "./db.js";
import { attachmentFile, indexSite, isSafeUploadPath, metaValue } from "./generate.js";
import { loadSite } from "./store.js";

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS file_visibility (
     file text PRIMARY KEY,
     mode text NOT NULL CHECK (mode IN ('public', 'private')),
     updated_at timestamptz NOT NULL DEFAULT now(),
     updated_by text
   )`,
];
export const MODES = ["auto", "public", "private"];

let used = { attached: new Set(), linked: new Set() };
let overrides = new Map();
let ready = null;

// a WordPress resized copy (name-300x200.jpg) follows its original
const original = (f) => f.replace(/-\d+x\d+(\.\w+)$/, "$1");

const REF = /wp-content\/uploads\/([^"'\s<>()?#\\]+)/g;
function addRefs(text, set) {
  for (const m of String(text || "").matchAll(REF)) {
    let f = m[1].replace(/&amp;/g, "&");
    try {
      f = decodeURIComponent(f);
    } catch {}
    if (!isSafeUploadPath(f)) continue;
    set.add(f);
    set.add(original(f));
  }
}

/** Every uploads address the built site refers to (pages, feeds, data files, styles). */
async function scanBuilt(dir, set) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isFile() || !/\.(html|xml|json|css|txt)$/i.test(e.name)) continue;
    const p = join(e.parentPath ?? e.path, e.name);
    if (p.includes(`${sep}pagefind${sep}`)) continue;
    addRefs(await readFile(p, "utf-8").catch(() => ""), set);
  }
}

async function compute(builtDir, opts) {
  const site = await loadSite();
  const idx = indexSite(site, opts);
  const attached = new Set();
  const linked = new Set();
  for (const i of site.items) {
    if (i.post_type === "attachment") {
      const parent = idx.itemById.get(Number(i.post_parent));
      const f = attachmentFile(i);
      if (f && parent && idx.isPublic(parent)) attached.add(f);
      continue;
    }
    if (!idx.isPublic(i)) continue;
    addRefs(i.content, linked);
    addRefs(i.excerpt, linked);
    const thumb = idx.itemById.get(Number(metaValue(i, "_thumbnail_id")));
    const tf = thumb && attachmentFile(thumb);
    if (tf) linked.add(tf);
  }
  if (builtDir) await scanBuilt(builtDir, linked);
  overrides = new Map((await db.all("SELECT file, mode FROM file_visibility")).map((r) => [r.file, r.mode]));
  used = { attached, linked };
  console.log(`file visibility: ${attached.size} attached to published items, ${linked.size} used by the site, ${overrides.size} set by hand`);
}

/** Recompute which files the published site uses (at startup and after every build). */
export function refreshVisibility(builtDir, opts) {
  const next = compute(builtDir, opts).catch((e) => console.error("file visibility:", e));
  // requests keep the previous answer until the first computation is done
  if (!ready) ready = next;
  else next.then(() => (ready = next));
  return next;
}

/** { mode: auto|public|private, reason: attached|linked|null, public } */
export function fileStatus(file) {
  const mode = overrides.get(file) ?? overrides.get(original(file)) ?? "auto";
  const has = (s) => s.has(file) || s.has(original(file));
  const reason = has(used.attached) ? "attached" : has(used.linked) ? "linked" : null;
  return { mode, reason, public: mode === "public" || (mode === "auto" && !!reason) };
}

export const visibilityReady = () => ready;

export async function isPublicFile(file) {
  await ready;
  return fileStatus(file).public;
}

export async function setFileMode(file, mode, by) {
  if (!MODES.includes(mode)) throw Object.assign(new Error("מצב לא מוכר"), { status: 400 });
  if (mode === "auto") {
    await db.query("DELETE FROM file_visibility WHERE file = $1", [file]);
    overrides.delete(file);
  } else {
    await db.query(
      `INSERT INTO file_visibility (file, mode, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (file) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [file, mode, by],
    );
    overrides.set(file, mode);
  }
  return fileStatus(file);
}
