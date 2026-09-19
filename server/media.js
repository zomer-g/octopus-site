// Media: every attachment lives at /wp-content/uploads/<file>, like WordPress.
// Files come from the image (media/, the original archive) or the channel's
// object store (uploads and imported files). The sync fetches attachments
// that are listed in the data but missing from both.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { db } from "./db.js";
import { attachmentFile } from "./generate.js";
import { loadSite } from "./store.js";
import { exists, listFiles, putFile } from "./storage.js";
import { safeFetch } from "./safe-fetch.js";

let ROOT;
let state = { running: false, total: 0, done: 0, downloaded: 0, failed: [] };
export const initMedia = (root) => (ROOT = root);
export const mediaSyncState = () => state;

export function localMediaPath(file) {
  const base = join(ROOT, "media/wp-content/uploads");
  const p = normalize(join(base, file));
  return p.startsWith(base) && existsSync(p) && statSync(p).isFile() ? p : null;
}

export const storageKey = (file) => `wp-content/uploads/${file}`;

export async function hasMedia(file) {
  return !!localMediaPath(file) || (await exists(storageKey(file)));
}

/** Download missing attachment files. `ownHosts` are never fetched (that would be ourselves). */
export async function syncMedia(ownHosts = []) {
  if (state.running) return state;
  const site = await loadSite();
  const attachments = site.items.filter((i) => i.post_type === "attachment" && attachmentFile(i));
  state = { running: true, total: attachments.length, done: 0, downloaded: 0, failed: [], startedAt: new Date().toISOString() };
  const queue = [...attachments];
  const worker = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      const file = attachmentFile(a);
      try {
        if (!(await hasMedia(file))) {
          const url = a.source_url || a.attachment_url;
          const host = new URL(url, "http://x").host;
          if (!/^https?:/.test(url) || ownHosts.includes(host)) throw new Error("no source");
          const r = await safeFetch(url, { headers: { "user-agent": "Mozilla/5.0 (octopus media sync)" } });
          await putFile(storageKey(file), r.buffer, r.contentType);
          state.downloaded++;
        }
      } catch (e) {
        if (state.failed.length < 500) state.failed.push({ file, error: String(e.message || e) });
      }
      state.done++;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  state.running = false;
  state.finishedAt = new Date().toISOString();
  await db.setSetting("media_sync", { ...state });
  return state;
}

// ---------- full copy of the old site's uploads folder ----------
// archive/uploads-manifest.json lists every file that was under
// /wp-content/uploads/ on the old WordPress server (tools/crawl-uploads.py),
// including the resized copies WordPress generated. The mirror copies whatever
// is not here yet into the object store, checking each file's size.

let mirror = { running: false, total: 0, done: 0, copied: 0, present: 0, bytes: 0, failed: [] };
export const mirrorState = () => mirror;

export function loadManifest() {
  const f = join(ROOT, "archive/uploads-manifest.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf-8")) : [];
}

export async function mirrorUploads(sourceBase, { log = console.log, manifest: list } = {}) {
  if (mirror.running) return mirror;
  const manifest = (list ?? loadManifest()).filter((f) => f.status === 200 && isSafe(f.path));
  mirror = { running: true, total: manifest.length, done: 0, copied: 0, present: 0, bytes: 0, failed: [], startedAt: new Date().toISOString() };
  const stored = new Map((await listFiles()).map((o) => [o.key, o.size]));
  const queue = [...manifest];
  const base = sourceBase.replace(/\/$/, "");
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      try {
        const key = storageKey(f.path);
        if (localMediaPath(f.path) || (stored.has(key) && (f.size == null || stored.get(key) === f.size))) mirror.present++;
        else {
          const url = `${base}/wp-content/uploads/${f.path.split("/").map(encodeURIComponent).join("/")}`;
          const r = await safeFetch(url, { headers: { "user-agent": "Mozilla/5.0 (octopus uploads mirror)" }, timeoutMs: 300000 });
          if (f.size != null && r.buffer.length !== f.size) throw new Error(`size ${r.buffer.length} != ${f.size}`);
          await putFile(key, r.buffer, r.contentType);
          mirror.copied++;
          mirror.bytes += r.buffer.length;
        }
      } catch (e) {
        if (mirror.failed.length < 1000) mirror.failed.push({ file: f.path, error: String(e.message || e) });
      }
      if (++mirror.done % 500 === 0) log(`uploads mirror: ${mirror.done}/${mirror.total} (copied ${mirror.copied}, ${(mirror.bytes / 1e6).toFixed(0)} MB, failed ${mirror.failed.length})`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  mirror.running = false;
  mirror.finishedAt = new Date().toISOString();
  log(`uploads mirror done: ${mirror.total} files – ${mirror.present} already here, ${mirror.copied} copied (${(mirror.bytes / 1e6).toFixed(0)} MB), ${mirror.failed.length} failed`);
  for (const f of mirror.failed.slice(0, 20)) log(`  failed: ${f.file} – ${f.error}`);
  await db.setSetting("upload_mirror", { ...mirror, failed: mirror.failed.slice(0, 200) });
  return mirror;
}

const isSafe = (p) => !/(^|\/)\.\.(\/|$)|\|^\//.test(p);
