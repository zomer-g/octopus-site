// Build a WXR file with only what the public site shows, for the public repository:
// published (non-password) posts and pages, the media they use, categories/tags/menus.
// Left out: drafts, private/pending items, contact-form entries, other plugin data,
// e-mail addresses and IPs.
//   node tools/make-public-wxr.mjs <full.xml> <public.xml>
import { readFileSync, writeFileSync } from "node:fs";
import { parseWxr, serializeWxr } from "../server/wxr.js";
import { metaValue } from "../server/generate.js";

const [src, out] = process.argv.slice(2);
const site = parseWxr(readFileSync(src, "utf-8"));

const isPublic = (i) => ["post", "page"].includes(i.post_type) && i.status === "publish" && !i.post_password;
const items = site.items.filter(isPublic);
const publicIds = new Set(items.map((i) => i.post_id));
const text = items.map((i) => i.content + i.excerpt).join("\n");

// media: featured images, attachments of public items, files linked from public content
const thumbs = new Set(items.map((i) => Number(metaValue(i, "_thumbnail_id"))).filter(Boolean));
const media = site.items.filter((a) => {
  if (a.post_type !== "attachment") return false;
  const file = metaValue(a, "_wp_attached_file") || "";
  const stem = file.replace(/\.[^.]+$/, "");
  return thumbs.has(a.post_id) || publicIds.has(a.post_parent) || (stem && text.includes(stem));
});

// menu items that point at public content or plain links
const menuItems = site.items.filter((i) => {
  if (i.post_type !== "nav_menu_item" || i.status !== "publish") return false;
  const type = metaValue(i, "_menu_item_type");
  return type !== "post_type" || publicIds.has(Number(metaValue(i, "_menu_item_object_id")));
});

// allowlist: only meta the site (or a WordPress re-import) needs; plugin data may hold private settings
const KEEP_META = /^(_thumbnail_id|_wp_attached_file|_wp_attachment_metadata|_wp_attachment_image_alt|_wp_old_slug|_wp_old_date|_wp_page_template|_yoast_wpseo_metadesc|_yoast_wpseo_primary_category|_menu_item_[a-z_]+|_oembed_[0-9a-f]{32})$/;
const scrub = (i) => ({ ...i, meta: i.meta.filter((m) => KEEP_META.test(m.key)), comments: [] });

const pub = {
  meta: site.meta,
  authors: site.authors.map((a) => ({ ...a, email: "" })),
  terms: site.terms.filter((t) => ["category", "post_tag", "nav_menu"].includes(t.taxonomy)),
  items: [...media, ...items, ...menuItems].map(scrub).sort((a, b) => a.post_id - b.post_id),
};
writeFileSync(out, serializeWxr(pub));
const count = (t) => pub.items.filter((i) => i.post_type === t).length;
console.log(`public WXR: ${count("post")} posts, ${count("page")} pages, ${count("attachment")} media, ${count("nav_menu_item")} menu items, ${pub.terms.length} terms`);
