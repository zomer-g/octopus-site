// site (WordPress-shaped data) -> Astro inputs:
//   <root>/src/content/posts/<id>.md, <root>/src/content/pages/<id>.md
//   <root>/src/data/{categories,tags,menu}.json
// and the routing tables the server uses: redirects.json and ids.json.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderContent, localizeUrls, hasPostList, sanitizeHtml } from "./render.js";

/**
 * A stored (percent-encoded) slug as one safe path segment. Slugs come from
 * imported files too, so anything that could leave the segment (/ \ ? # ..),
 * break an attribute (" < >) or a header (control chars) is replaced.
 */
export const decode = (s) => {
  let out;
  try {
    out = decodeURIComponent(s ?? "");
  } catch {
    out = s ?? "";
  }
  out = out.replace(/[\/\\?#"'<>`\u0000-\u001f\u007f]/g, "-");
  return /^\.+$/.test(out) ? "-" : out;
};

/** Menu links may only be site paths, http(s), mailto or tel. */
export const safeHref = (href) => {
  const h = String(href ?? "").trim();
  if (/^\/(?!\/)/.test(h) || /^#/.test(h)) return h;
  if (/^(https?:\/\/|mailto:|tel:)/i.test(h)) return h;
  return "/";
};

/** WordPress sanitize_title for storage: lowercase, dashes, UTF-8 percent-encoded. */
export function wpSlug(text) {
  const plain = String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/["'״׳`]/g, "")
    .replace(/[^\p{L}\p{N}_]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
  return encodeURIComponent(plain).toLowerCase().replace(/%2d/g, "-");
}

// addresses the site itself owns; a page may not take them
const RESERVED = [/^\/(news|posts|search|categories)\/$/, /^\/(category|tag|admin|api|media|wp-content|_astro|pagefind)\//];
export const isReserved = (p) => RESERVED.some((r) => r.test(p));

export const metaValue = (item, key) => item.meta?.find((m) => m.key === key)?.value;
export const metaValues = (item, key) => (item.meta ?? []).filter((m) => m.key === key).map((m) => m.value);

/** Lookup tables shared by the generator, the renderer and the admin API. */
export function indexSite(site, opts = {}) {
  const itemById = new Map(site.items.map((i) => [i.post_id, i]));
  const cats = site.terms.filter((t) => t.taxonomy === "category");
  const catBySlug = new Map(cats.map((c) => [c.slug, c]));
  const catPath = (c, depth = 0) => {
    const parent = c.parent && catBySlug.get(c.parent);
    const own = decode(c.slug);
    return parent && parent !== c && depth < 20 ? `${catPath(parent, depth + 1)}/${own}` : own;
  };
  const categoryPathBySlug = new Map(cats.map((c) => [c.slug, catPath(c)]));
  const categoryPathById = new Map(cats.map((c) => [c.term_id, catPath(c)]));
  const tags = site.terms.filter((t) => t.taxonomy === "post_tag");
  const tagSlugById = new Map(tags.map((t) => [t.term_id, decode(t.slug)]));

  const permalink = (item) => {
    if (opts.frontPageId && item.post_id === Number(opts.frontPageId)) return "/";
    const name = decode(item.post_name);
    if (!name) return null;
    if (item.post_type === "post") {
      const [y, m, d] = (item.post_date || "").slice(0, 10).split("-");
      return y ? `/${y}/${m}/${d}/${name}/` : null;
    }
    if (item.post_type === "page") {
      const chain = [name];
      let p = itemById.get(item.post_parent);
      for (let i = 0; p && i < 20; i++, p = itemById.get(p.post_parent)) chain.unshift(decode(p.post_name));
      return `/${chain.join("/")}/`;
    }
    return null;
  };
  const isPublic = (i) => (i.post_type === "post" || i.post_type === "page") && i.status === "publish" && !i.post_password;
  const permalinkById = new Map(site.items.filter(isPublic).map((i) => [i.post_id, permalink(i)]));

  return {
    itemById, catBySlug, categoryPathBySlug, categoryPathById, tagSlugById, permalink, permalinkById, isPublic,
    baseUrls: [...new Set([site.meta?.base_site_url, site.meta?.base_blog_url, ...(opts.baseUrls ?? [])].filter(Boolean))],
  };
}

/** The attachment's path under uploads/ (null when missing or unsafe). */
export const attachmentFile = (a) => {
  const f = metaValue(a, "_wp_attached_file") || (a.attachment_url || "").split("/wp-content/uploads/")[1] || null;
  return f && isSafeUploadPath(f) ? f : null;
};
export const isSafeUploadPath = (f) => !/(^|\/)\.\.(\/|$)|\\|^\/|[\u0000-\u001f]/.test(f);

const inMenu = (i, slug) => i.terms.some((t) => t.domain === "nav_menu" && t.nicename === slug);
const navItemsOf = (site) => site.items.filter((i) => i.post_type === "nav_menu_item" && i.status !== "trash");

/** The site's main menu: the configured one, else the WordPress menu with the most items. */
export function primaryMenu(site, opts = {}) {
  const menus = site.terms.filter((t) => t.taxonomy === "nav_menu");
  const navItems = navItemsOf(site);
  return (
    menus.find((m) => m.slug === opts.primaryMenu) ??
    menus.map((m) => [m, navItems.filter((i) => inMenu(i, m.slug)).length]).sort((a, b) => b[1] - a[1])[0]?.[0] ??
    null
  );
}

export function buildMenu(site, idx, opts) {
  const navItems = navItemsOf(site);
  const menu = primaryMenu(site, opts);
  if (!menu) return [];
  const entries = navItems.filter((i) => inMenu(i, menu.slug)).sort((a, b) => a.menu_order - b.menu_order);
  const node = (i) => {
    const type = metaValue(i, "_menu_item_type");
    const objId = Number(metaValue(i, "_menu_item_object_id"));
    let href = metaValue(i, "_menu_item_url") || "/";
    let label = i.title;
    if (type === "post_type") {
      const target = idx.itemById.get(objId);
      href = (target && idx.permalinkById.get(objId)) || href;
      label ||= target?.title;
    } else if (type === "taxonomy") {
      const term = site.terms.find((t) => t.term_id === objId);
      if (term?.taxonomy === "category") href = `/category/${idx.categoryPathBySlug.get(term.slug)}/`;
      else if (term?.taxonomy === "post_tag") href = `/tag/${decode(term.slug)}/`;
      label ||= term?.name;
    }
    return { id: i.post_id, label: label || href, href: safeHref(localizeUrls(href, idx.baseUrls) || "/") };
  };
  const top = entries.filter((i) => !Number(metaValue(i, "_menu_item_menu_item_parent")));
  return top.map((t) => {
    const children = entries.filter((i) => Number(metaValue(i, "_menu_item_menu_item_parent")) === t.post_id).map(node);
    return { ...node(t), ...(children.length ? { children } : {}) };
  });
}

function redirects(site, idx, extra) {
  const out = { ...(extra ?? {}) };
  const taken = new Set(idx.permalinkById.values());
  for (const item of site.items) {
    if (!idx.isPublic(item) || item.post_type !== "post") continue;
    const current = idx.permalinkById.get(item.post_id);
    const slugs = [decode(item.post_name), ...metaValues(item, "_wp_old_slug").map(decode)];
    const dates = [item.post_date.slice(0, 10), ...metaValues(item, "_wp_old_date")];
    let n = 0;
    for (const d of new Set(dates))
      for (const s of new Set(slugs)) {
        const [y, m, dd] = d.split("-");
        const from = `/${y}/${m}/${dd}/${s}/`;
        if (from !== current && !taken.has(from) && n++ < 40) out[from] = current;
      }
  }
  for (const [from, to] of Object.entries(out)) if (taken.has(from) || from === to) delete out[from];
  return out;
}

const hash = (s) => createHash("sha1").update(s ?? "").digest("hex");
const yaml = (d) =>
  "---\n" +
  Object.entries(d)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n") +
  "\n---\n\n";

const toIso = (local, gmt) => {
  const g = gmt && gmt !== "0000-00-00 00:00:00" ? gmt : null;
  if (g) return new Date(g.replace(" ", "T") + "Z").toISOString();
  return local ? new Date(local.replace(" ", "T") + "+02:00").toISOString() : undefined;
};
const plain = (html, n = 300) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * Write the Astro inputs for `site` under `root`.
 * opts: { frontPageId, primaryMenu, extraRedirects, renderCache, baseUrls }
 */
export function generate(site, root, opts = {}) {
  const idx = indexSite(site, opts);
  const cache = opts.renderCache ?? {};
  const contentDir = join(root, "src/content");
  rmSync(contentDir, { recursive: true, force: true });
  for (const d of ["posts", "pages"]) mkdirSync(join(contentDir, d), { recursive: true });
  const dataDir = join(root, "src/data");
  mkdirSync(dataDir, { recursive: true });

  const stats = { posts: 0, pages: 0, cached: 0, rendered: 0, skipped: [] };
  const used = new Set();
  for (const item of site.items) {
    if (!idx.isPublic(item)) continue;
    const link = idx.permalinkById.get(item.post_id);
    if (!link || link === "/" || isReserved(link) || used.has(link)) {
      if (link !== "/") stats.skipped.push(`${item.post_id} ${link}`);
      continue;
    }
    used.add(link);
    const c = cache[item.post_id];
    let body;
    // cached = the HTML WordPress rendered, valid while the content is unchanged;
    // pages with post lists are rendered from the list settings instead
    if (c && c.hash === hash(item.content) && !hasPostList(item.content)) {
      body = c.html;
      stats.cached++;
    } else {
      body = renderContent(item, idx);
      stats.rendered++;
    }
    body = sanitizeHtml(body);
    const thumb = idx.itemById.get(Number(metaValue(item, "_thumbnail_id")));
    const firstImg = (body.match(/<img[^>]+src="([^"]+)"/) || [])[1];
    const image = thumb?.attachment_url ? localizeUrls(thumb.attachment_url, idx.baseUrls) : firstImg;
    const description = metaValue(item, "_yoast_wpseo_metadesc") || plain(item.excerpt || "") || undefined;
    const front = {
      title: item.title,
      permalink: link,
      wpId: item.post_id,
      date: toIso(item.post_date, item.post_date_gmt),
      modified: toIso(item.post_modified, item.post_modified_gmt),
      description,
      image,
      format: "html",
    };
    if (item.post_type === "post") {
      front.categories = item.terms.filter((t) => t.domain === "category").map((t) => idx.categoryPathBySlug.get(t.nicename)).filter(Boolean);
      front.tags = item.terms.filter((t) => t.domain === "post_tag").map((t) => decode(t.nicename));
      stats.posts++;
    } else stats.pages++;
    writeFileSync(join(contentDir, item.post_type === "post" ? "posts" : "pages", `${item.post_id}.md`), yaml(front) + body + "\n");
  }

  const cats = site.terms
    .filter((t) => t.taxonomy === "category")
    .map((c) => ({
      id: c.term_id,
      slug: idx.categoryPathBySlug.get(c.slug),
      name: c.name,
      description: c.description || "",
      parent: c.parent && idx.catBySlug.get(c.parent) ? idx.categoryPathBySlug.get(c.parent) : null,
    }));
  writeFileSync(join(dataDir, "categories.json"), JSON.stringify(cats, null, 1));
  const tags = site.terms.filter((t) => t.taxonomy === "post_tag").map((t) => ({ id: t.term_id, slug: decode(t.slug), name: t.name }));
  writeFileSync(join(dataDir, "tags.json"), JSON.stringify(tags, null, 1));
  writeFileSync(join(dataDir, "menu.json"), JSON.stringify(buildMenu(site, idx, opts), null, 1));

  const routes = {
    redirects: redirects(site, idx, opts.extraRedirects),
    ids: Object.fromEntries([...idx.permalinkById].filter(([, p]) => p)),
  };
  writeFileSync(join(dataDir, "routes.json"), JSON.stringify(routes));
  stats.redirects = Object.keys(routes.redirects).length;
  return stats;
}

/** Defaults for this site (the DB settings override them at runtime). */
export function loadConfig(root) {
  const f = join(root, "site.config.json");
  const config = existsSync(f) ? JSON.parse(readFileSync(f, "utf-8")) : {};
  // "baseline" may list several files: the first one present is used (the full
  // private export where it exists, the public one in the public repository)
  if (Array.isArray(config.baseline)) config.baseline = config.baseline.find((b) => existsSync(join(root, b))) ?? null;
  return config;
}

export function loadRenderCache(root) {
  const f = join(root, "archive/rendered.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf-8")) : {};
}
