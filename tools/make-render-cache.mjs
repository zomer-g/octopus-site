// One-off: map each published WordPress item (by post_id) to the HTML that
// WordPress actually rendered (scraped + cleaned, with the recovered post-list
// markers), keyed by a hash of the raw WXR content. The generator uses this
// HTML while an item's content is unchanged, and renders it itself otherwise.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import matter from "gray-matter";
import { parseWxr } from "../server/wxr.js";

const site = parseWxr(readFileSync("archive/wxr/octopus-2026-09-19.xml", "utf-8"));
const byId = new Map(site.items.map((i) => [i.post_id, i]));
const cache = {};
let missing = 0;
for (const dir of ["posts", "pages"]) {
  for (const f of readdirSync(`src/content/${dir}`)) {
    const { data, content } = matter(readFileSync(`src/content/${dir}/${f}`, "utf-8"));
    const item = byId.get(data.wpId);
    if (!item) { missing++; continue; }
    cache[item.post_id] = { hash: createHash("sha1").update(item.content).digest("hex"), html: content.trim() };
  }
}
writeFileSync("archive/rendered.json", JSON.stringify(cache));
console.log("cached", Object.keys(cache).length, "missing", missing);
