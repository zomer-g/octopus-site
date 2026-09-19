// The site's content, stored in WordPress' own shape (one row per WXR item,
// term and author) so that export -> WordPress and import <- WordPress are lossless.
import { db } from "./db.js";
import { attachmentFile, decode, metaValue } from "./generate.js";

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS wp_items (
     post_id bigint PRIMARY KEY,
     post_type text NOT NULL,
     status text NOT NULL,
     doc jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     updated_by text
   )`,
  `CREATE INDEX IF NOT EXISTS wp_items_type ON wp_items (post_type)`,
  `CREATE TABLE IF NOT EXISTS wp_terms (term_id bigint PRIMARY KEY, taxonomy text NOT NULL, doc jsonb NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wp_authors (login text PRIMARY KEY, doc jsonb NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wp_item_history (
     id bigserial PRIMARY KEY,
     post_id bigint NOT NULL,
     doc jsonb NOT NULL,
     saved_at timestamptz NOT NULL DEFAULT now(),
     saved_by text,
     reason text NOT NULL DEFAULT 'edit'
   )`,
  `CREATE INDEX IF NOT EXISTS wp_item_history_post ON wp_item_history (post_id, id DESC)`,
];

export async function loadSite() {
  const [items, terms, authors, meta] = await Promise.all([
    db.all("SELECT doc FROM wp_items ORDER BY post_id"),
    db.all("SELECT doc FROM wp_terms ORDER BY term_id"),
    db.all("SELECT doc FROM wp_authors"),
    db.getSetting("site_meta", {}),
  ]);
  return { meta, items: items.map((r) => r.doc), terms: terms.map((r) => r.doc), authors: authors.map((r) => r.doc) };
}

export const itemCount = async () => Number((await db.one("SELECT count(*) AS n FROM wp_items")).n);

export async function getItem(id) {
  return (await db.one("SELECT doc FROM wp_items WHERE post_id = $1", [id]))?.doc ?? null;
}

export async function saveItem(doc, by, reason = "edit", q = db) {
  await q.query(
    `INSERT INTO wp_items (post_id, post_type, status, doc, updated_at, updated_by) VALUES ($1, $2, $3, $4, now(), $5)
     ON CONFLICT (post_id) DO UPDATE SET post_type = EXCLUDED.post_type, status = EXCLUDED.status, doc = EXCLUDED.doc,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [doc.post_id, doc.post_type, doc.status, JSON.stringify(doc), by],
  );
  if (doc.post_type === "post" || doc.post_type === "page")
    await q.query("INSERT INTO wp_item_history (post_id, doc, saved_by, reason) VALUES ($1, $2, $3, $4)", [doc.post_id, JSON.stringify(doc), by, reason]);
}

export async function saveTerm(t, q = db) {
  await q.query(
    `INSERT INTO wp_terms (term_id, taxonomy, doc) VALUES ($1, $2, $3)
     ON CONFLICT (term_id) DO UPDATE SET taxonomy = EXCLUDED.taxonomy, doc = EXCLUDED.doc`,
    [t.term_id, t.taxonomy, JSON.stringify(t)],
  );
}

export async function saveAuthor(a, q = db) {
  await q.query(
    "INSERT INTO wp_authors (login, doc) VALUES ($1, $2) ON CONFLICT (login) DO UPDATE SET doc = EXCLUDED.doc",
    [a.login, JSON.stringify(a)],
  );
}

export async function deleteItem(id, q = db) {
  await q.query("DELETE FROM wp_items WHERE post_id = $1", [id]);
}

export async function nextId(table = "items") {
  const r = table === "terms" ? await db.one("SELECT COALESCE(max(term_id), 0) AS n FROM wp_terms") : await db.one("SELECT COALESCE(max(post_id), 0) AS n FROM wp_items");
  return Number(r.n) + 1;
}

// ---------- import ----------

/** Identity used by APPEND to decide whether an incoming item already exists. */
function identity(item) {
  const name = decode(item.post_name);
  switch (item.post_type) {
    case "attachment":
      return `attachment|${attachmentFile(item) ?? item.guid}`;
    case "post":
      return name ? `post|${item.post_date.slice(0, 10)}|${name}` : `post|guid|${item.guid}`;
    case "nav_menu_item":
      return null; // menus are handled as a whole
    default:
      return name && item.post_type === "page" ? `page|${name}` : `${item.post_type}|guid|${item.guid}|${item.title}`;
  }
}

const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/**
 * Plan an import without writing anything.
 * mode "replace": the file becomes the whole site.
 * mode "append":  only items/terms/authors that do not exist yet are added.
 */
export async function planImport(incoming, mode, siteUrl) {
  const current = await loadSite();
  const foreign = hostOf(incoming.meta.base_site_url) !== hostOf(siteUrl) && !!incoming.meta.base_site_url;
  const count = (list) => list.reduce((acc, i) => ((acc[i.post_type] = (acc[i.post_type] ?? 0) + 1), acc), {});
  if (mode === "replace") {
    return {
      mode, foreign, source: incoming.meta.base_site_url,
      add: count(incoming.items), terms: incoming.terms.length, authors: incoming.authors.length,
      remove: count(current.items),
    };
  }
  const existing = new Set(current.items.map(identity).filter(Boolean));
  const termKeys = new Set(current.terms.map((t) => `${t.taxonomy}|${t.slug}`));
  const menus = new Set(current.terms.filter((t) => t.taxonomy === "nav_menu").map((t) => t.slug));
  const newItems = incoming.items.filter((i) => {
    if (i.post_type === "nav_menu_item") return i.terms.some((t) => t.domain === "nav_menu" && !menus.has(t.nicename));
    const key = identity(i);
    return key && !existing.has(key);
  });
  return {
    mode, foreign, source: incoming.meta.base_site_url,
    add: count(newItems),
    skip: count(incoming.items.filter((i) => !newItems.includes(i))),
    terms: incoming.terms.filter((t) => !termKeys.has(`${t.taxonomy}|${t.slug}`)).length,
    authors: incoming.authors.filter((a) => !current.authors.some((c) => c.login === a.login)).length,
  };
}

/** Run an import. Returns the plan that was applied. */
export async function runImport(incoming, mode, by, siteUrl) {
  const plan = await planImport(incoming, mode, siteUrl);
  const current = mode === "replace" ? { items: [], terms: [], authors: [] } : await loadSite();
  const foreignBase = plan.foreign ? incoming.meta.base_site_url.replace(/\/$/, "") : null;

  // ids: keep the file's ids unless they collide with something already here
  const usedIds = new Set(current.items.map((i) => i.post_id));
  let maxId = Math.max(0, ...usedIds);
  const idMap = new Map(); // incoming post_id -> local post_id (for references)
  const newIdOf = new Map(); // incoming item -> its local post_id
  const existingByKey = new Map(current.items.map((i) => [identity(i), i]).filter(([k]) => k));
  const menus = new Set(current.terms.filter((t) => t.taxonomy === "nav_menu").map((t) => t.slug));
  const toAdd = [];
  for (const it of incoming.items) {
    if (mode === "append") {
      if (it.post_type === "nav_menu_item") {
        if (!it.terms.some((t) => t.domain === "nav_menu" && !menus.has(t.nicename))) continue;
      } else {
        const match = existingByKey.get(identity(it));
        if (match) {
          if (!idMap.has(it.post_id)) idMap.set(it.post_id, match.post_id);
          continue;
        }
      }
    }
    let id = it.post_id;
    if (usedIds.has(id)) id = ++maxId;
    usedIds.add(id);
    maxId = Math.max(maxId, id);
    idMap.set(it.post_id, id);
    newIdOf.set(it, id);
    toAdd.push(it);
  }

  // terms: same idea, keyed by taxonomy + slug
  const termIds = new Set(current.terms.map((t) => t.term_id));
  let maxTerm = Math.max(0, ...termIds);
  const termByKey = new Map(current.terms.map((t) => [`${t.taxonomy}|${t.slug}`, t]));
  const termMap = new Map();
  const termsToAdd = [];
  for (const t of incoming.terms) {
    const have = termByKey.get(`${t.taxonomy}|${t.slug}`);
    if (have) {
      termMap.set(t.term_id, have.term_id);
      continue;
    }
    let id = t.term_id;
    if (termIds.has(id)) id = ++maxTerm;
    termIds.add(id);
    maxTerm = Math.max(maxTerm, id);
    termMap.set(t.term_id, id);
    termsToAdd.push({ ...t, term_id: id });
  }

  const remapId = (v) => String(idMap.get(Number(v)) ?? v);
  const localUploads = (s) => (foreignBase ? s.split(`${foreignBase}/wp-content/uploads/`).join("/wp-content/uploads/") : s);
  // category ids inside dynamic block settings, e.g. {"categories":["12"]}
  const remapBlockTerms = (html) =>
    html.replace(/("(?:categories|tags)":\s*)\[([^\]]*)\]/g, (m, key, list) =>
      key + "[" + list.replace(/\d+/g, (n) => String(termMap.get(Number(n)) ?? n)) + "]",
    );

  const prepared = toAdd.map((it) => {
    const doc = structuredClone(it);
    doc.post_id = newIdOf.get(it);
    if (doc.post_parent) doc.post_parent = Number(remapId(doc.post_parent));
    for (const m of doc.meta) {
      if (["_thumbnail_id", "_menu_item_object_id", "_menu_item_menu_item_parent"].includes(m.key)) {
        const isPostRef = m.key !== "_menu_item_object_id" || metaValue(doc, "_menu_item_type") === "post_type";
        if (isPostRef && m.value && m.value !== "0") m.value = remapId(m.value);
        else if (m.key === "_menu_item_object_id" && metaValue(doc, "_menu_item_type") === "taxonomy")
          m.value = String(termMap.get(Number(m.value)) ?? m.value);
      }
    }
    doc.content = remapBlockTerms(localUploads(doc.content));
    doc.excerpt = localUploads(doc.excerpt);
    if (doc.post_type === "attachment" && doc.attachment_url && foreignBase) {
      doc.source_url = doc.attachment_url; // downloaded by the media sync, not exported
      doc.attachment_url = `${siteUrl.replace(/\/$/, "")}/wp-content/uploads/${attachmentFile(doc)}`;
    }
    return doc;
  });

  await db.tx(async (q) => {
    if (mode === "replace") {
      await q.query("DELETE FROM wp_items");
      await q.query("DELETE FROM wp_terms");
      await q.query("DELETE FROM wp_authors");
    }
    for (const t of termsToAdd) await saveTerm(t, q);
    for (const a of incoming.authors) if (mode === "replace" || !current.authors.some((c) => c.login === a.login)) await saveAuthor(a, q);
    for (const doc of prepared) await saveItem(doc, by, "import", q);
  });
  if (mode === "replace" || !(await db.getSetting("site_meta"))) {
    const { title, description, language, generator } = incoming.meta;
    await db.setSetting("site_meta", { ...incoming.meta, title, description, language, generator });
  }
  return { ...plan, added: prepared.length };
}

// ---------- export ----------

/** The whole site as WXR input, with this site's URLs (what WordPress' importer will fetch). */
export async function siteForExport(siteUrl, permalinkOf) {
  const site = await loadSite();
  const base = siteUrl.replace(/\/$/, "");
  site.meta = {
    ...site.meta,
    link: base,
    base_site_url: base,
    base_blog_url: base,
  };
  site.items = site.items
    .filter((i) => i.status !== "auto-draft")
    .map((i) => {
      const { source_url, ...doc } = i;
      if (doc.attachment_url?.startsWith("/")) doc.attachment_url = base + doc.attachment_url;
      const link = permalinkOf(doc);
      // WordPress writes links percent-encoded with lowercase hex, like its slugs
      if (link) doc.link = base + encodeURI(link).replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase());
      return doc;
    });
  return site;
}
