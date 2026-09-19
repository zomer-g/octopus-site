// Media: every attachment lives at /wp-content/uploads/<file>, like WordPress.
// Files come from the image (media/, the original archive) or the channel's
// object store (uploads and imported files). The sync fetches attachments
// that are listed in the data but missing from both.
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { db } from "./db.js";
import { attachmentFile } from "./generate.js";
import { loadSite } from "./store.js";
import { exists, putFile } from "./storage.js";
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
