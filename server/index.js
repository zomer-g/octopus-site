// Octopus site server: serves the built static site and media, and the
// /admin editor + /api over WordPress-shaped data (see store.js), with
// WXR import (replace / append) and export.
import express from "express";
import multer from "multer";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { currentUser, isEditor, loginUrl } from "./auth.js";
import { initBuilder, currentDir, isBuilding, onSwap, requestBuild, siteOptions } from "./builder.js";
import { initStorage, putFile, getFile, deleteFile } from "./storage.js";
import { initMedia, hasMedia, localMediaPath, storageKey, syncMedia, mediaSyncState, mirrorUploads, mirrorState, loadManifest } from "./media.js";
import { parseWxr, serializeWxr } from "./wxr.js";
import { readZip } from "./zip.js";
import { decode, indexSite, metaValue, wpSlug, attachmentFile, isReserved, isSafeUploadPath } from "./generate.js";
import { buildMenuTree, saveMenuTree } from "./menu.js";
import * as store from "./store.js";
import { loadPublicData, mcp, publicApi } from "./public-api.js";
import { createToken, listTokens, MAX_HOURS, revokeToken, userForToken } from "./tokens.js";
import { fileStatus, isPublicFile, refreshVisibility, setFileMode, visibilityReady } from "./visibility.js";

const ROOT = process.cwd();
const PORT = Number(process.env.XHOST_HTTP_PORT || process.env.PORT || 3000);

await db.init();
initStorage(ROOT);
initMedia(ROOT);
initBuilder(ROOT, join(ROOT, "dist"));

const siteUrl = async () => ((await siteOptions()).siteUrl || "https://octopus.org.il").replace(/\/$/, "");

// first boot: load the archived WordPress export shipped with the image
if ((await store.itemCount()) === 0) {
  const { baseline } = await siteOptions();
  if (baseline && existsSync(join(ROOT, baseline))) {
    console.log("empty database – importing", baseline);
    const r = await store.runImport(parseWxr(readFileSync(join(ROOT, baseline), "utf-8")), "replace", "system", await siteUrl());
    console.log("imported", r.added, "items");
    await db.setSetting("needs_media_sync", true);
  }
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// baseline security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  if (req.path.startsWith("/admin") || req.path.startsWith("/api")) {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

// ---------- site ----------
let routes = { redirects: {}, ids: {} };
const loadRoutes = (dir) => {
  const f = join(dir, "_routes.json");
  routes = existsSync(f) ? JSON.parse(readFileSync(f, "utf-8")) : { redirects: {}, ids: {} };
};
const siteStatic = (dir) =>
  express.static(dir, {
    setHeaders(res, path) {
      if (path.includes("_astro")) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      else if (path.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
      else res.setHeader("Cache-Control", "public, max-age=3600");
    },
  });
let serveSite = siteStatic(currentDir());
loadRoutes(currentDir());
loadPublicData(currentDir());
refreshVisibility(currentDir(), await siteOptions());
onSwap(async (dir) => {
  serveSite = siteStatic(dir);
  loadRoutes(dir);
  loadPublicData(dir);
  refreshVisibility(dir, await siteOptions());
});

// WordPress-style addresses: /?p=123, /?page_id=123 and renamed posts
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const id = req.path === "/" && (req.query.p || req.query.page_id);
  if (id && routes.ids[id]) return res.redirect(301, encodeURI(routes.ids[id]));
  let path;
  try {
    path = decodeURIComponent(req.path);
  } catch {
    return next();
  }
  const to = routes.redirects[path] || routes.redirects[path.endsWith("/") ? path : path + "/"];
  if (to) return res.redirect(301, encodeURI(to));
  // WordPress feed addresses that readers may still be subscribed to
  const feed = path.match(/^(\/|\/category\/.+\/)feed\/?$/);
  if (feed) return res.redirect(301, encodeURI(`${feed[1]}rss.xml`));
  next();
});

// public, read-only: JSON API and MCP server over the published archive
app.use("/api/public", publicApi);
app.use("/mcp", mcp);

// uploads: the archive in the image, then the object store, then (for a
// WordPress resized copy like name-300x200.jpg that we never stored) the original
// files that a browser could run as a page (svg, html…) are served sandboxed,
// so an uploaded or imported file can never act with an editor's session
// full-site export/backup files that ended up in the old uploads folder: kept in
// storage as part of the copy, never served (they hold unpublished data and e-mails)
// a file the published site does not use is private (visibility.js): editors only, never cached
const PRIVATE_UPLOADS = /(^|\/)(wordpress\.\d{4}-\d{2}-\d{2}[^/]*\.xml[^/]*|[^/]*\.wordpress\.com-\d{4}-\d{2}-\d{2}[^/]*)$/i;
const ACTIVE_TYPES = /\.(svg|svgz|html?|xhtml|xml|xsl)$/i;
app.get("/wp-content/uploads/{*file}", async (req, res, next) => {
  const file = [].concat(req.params.file).join("/");
  if (!isSafeUploadPath(file) || PRIVATE_UPLOADS.test(file)) return next();
  const visible = await isPublicFile(file);
  if (!visible) {
    const user = await currentUser(req);
    if (!user || !(await isEditor(user.email))) return next();
  }
  // short public caching, so a file made private stops being served soon after
  const cacheControl = visible ? "public, max-age=3600" : "private, no-store";
  if (ACTIVE_TYPES.test(file)) res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  const send = async (f) => {
    const local = localMediaPath(f);
    if (local) {
      res.setHeader("Cache-Control", cacheControl);
      res.sendFile(local);
      return true;
    }
    const obj = await getFile(storageKey(f)).catch(() => null);
    if (!obj) return false;
    res.type(obj.contentType || extname(f) || "application/octet-stream");
    if (obj.length) res.setHeader("Content-Length", obj.length);
    res.setHeader("Cache-Control", cacheControl);
    obj.stream.pipe(res);
    return true;
  };
  if (await send(file)) return;
  const original = file.replace(/-\d+x\d+(\.\w+)$/, "$1");
  if (original !== file && (await send(original))) return;
  next();
});

// ---------- admin ----------
async function requireEditor(req, res, next) {
  const isApi = req.baseUrl.startsWith("/api");
  // an API token (Authorization: Bearer oct_...) works on /api only, never on the admin pages
  const bearer = (req.get("authorization") || "").match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer) {
    if (!isApi) return res.status(400).send("tokens work on /api only");
    const tokenUser = await userForToken(bearer);
    if (!tokenUser) return res.status(401).json({ error: "הטוקן אינו בתוקף" });
    if (!(await isEditor(tokenUser.email))) return res.status(403).json({ error: "מי שיצר את הטוקן כבר אינו עורך" });
    req.user = tokenUser;
    return next();
  }
  const user = await currentUser(req);
  if (!user) {
    if (isApi) return res.status(401).json({ error: "not signed in", login: loginUrl() });
    return res.redirect(loginUrl(req.originalUrl));
  }
  if (!(await isEditor(user.email))) {
    if (isApi) return res.status(403).json({ error: "not an editor" });
    return res
      .status(403)
      .type("html")
      .send(`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>אין הרשאה</title>
<body style="font-family:Arial;padding:40px"><h1>אין הרשאת עריכה</h1>
<p>החשבון שאיתו התחברת אינו מורשה לערוך את האתר. בקשו ממנהל האתר להוסיף אותו.</p>
<p><a href="/xhost-auth/logout?return_to=/admin/">התנתקות והתחברות עם חשבון אחר</a></p></body></html>`);
  }
  req.user = user;
  next();
}

app.use("/admin", requireEditor);
app.use("/admin/vendor/tinymce", express.static(join(ROOT, "node_modules/tinymce")));
app.get("/admin/vendor/tinymce-he.js", (req, res) => res.sendFile(join(ROOT, "node_modules/tinymce-i18n/langs8/he-IL.js")));
app.use("/admin", express.static(join(ROOT, "server/admin"), { index: "index.html" }));

// ---------- api ----------
const api = express.Router();
api.use(requireEditor);
api.use(express.json({ limit: "10mb" }));
api.use((req, res, next) => {
  // a custom header cannot be sent by a cross-site form: CSRF guard for writes
  // (a token request carries no cookie, so it needs none)
  if (req.method !== "GET" && !req.user.token && req.get("x-octopus-admin") !== "1") return res.status(403).json({ error: "missing header" });
  next();
});
// a token may read, add drafts and files, and edit drafts. Publishing, deleting,
// menus, editors and tokens stay with signed-in editors.
const TOKEN_ROUTES = new Set([
  "GET /me", "GET /meta", "GET /items", "GET /item", "GET /uploads", "GET /status", "GET /history",
  "POST /item", "PUT /item", "POST /upload", "POST /categories", "POST /import/preview", "POST /import/run",
]);
const DRAFT_STATUSES = ["draft", "pending"];
api.use((req, res, next) => {
  if (!req.user.token) return next();
  if (!TOKEN_ROUTES.has(`${req.method} ${req.path}`)) return res.status(403).json({ error: "הפעולה הזו אינה מותרת בטוקן" });
  if ((req.path === "/item" && req.method !== "GET") && !DRAFT_STATUSES.includes(req.body?.status ?? "draft"))
    return res.status(403).json({ error: "בטוקן אפשר לשמור רק טיוטה (draft) או ממתין לאישור (pending)" });
  if (req.path === "/categories" && req.body?.id) return res.status(403).json({ error: "בטוקן אפשר רק להוסיף קטגוריה" });
  if (req.path.startsWith("/import/") && req.body?.mode === "replace") return res.status(403).json({ error: "בטוקן אפשר לייבא רק בהוספה (append)" });
  next();
});
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const httpError = (status, message) => Object.assign(new Error(message), { status });

async function siteIndex() {
  const site = await store.loadSite();
  const opts = await siteOptions();
  return { site, idx: indexSite(site, opts), opts };
}

const lastBuild = () => db.one("SELECT started_at FROM builds WHERE status = 'success' ORDER BY id DESC LIMIT 1");

// --- dates (WordPress keeps local time + GMT) ---
const TZ = "Asia/Jerusalem";
const pad = (n) => String(n).padStart(2, "0");
const wpDate = (d) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
function tzOffsetMinutes(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - date.getTime()) / 60000;
}
/** "YYYY-MM-DDTHH:MM" in Israel time -> WordPress local + GMT strings */
function fromLocalInput(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) throw httpError(400, "תאריך לא תקין");
  const guess = Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5]);
  const utc = new Date(guess - tzOffsetMinutes(new Date(guess)) * 60000);
  return { local: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:00`, gmt: wpDate(utc), date: utc };
}
function nowDates() {
  const now = new Date();
  now.setMilliseconds(0);
  const local = new Date(now.getTime() + tzOffsetMinutes(now) * 60000);
  return { local: wpDate(local), gmt: wpDate(now), date: now };
}
const rfc2822 = (d) => d.toUTCString().replace("GMT", "+0000");

// --- meta helpers ---
const setMeta = (doc, key, value) => {
  doc.meta = (doc.meta ?? []).filter((m) => m.key !== key);
  if (value !== undefined && value !== null && value !== "") doc.meta.push({ key, value: String(value) });
};
const addMeta = (doc, key, value) => {
  if (!(doc.meta ?? []).some((m) => m.key === key && m.value === value)) (doc.meta ??= []).push({ key, value });
};

/** The WordPress author login for a signed-in editor (created on first use). */
async function authorFor(user) {
  const authors = (await db.all("SELECT doc FROM wp_authors")).map((r) => r.doc);
  const found = authors.find((a) => a.email?.toLowerCase() === user.email);
  if (found) return found.login;
  const login = user.email.split("@")[0].replace(/[^a-z0-9._-]/gi, "").toLowerCase() || "editor";
  if (!authors.some((a) => a.login === login)) {
    const id = Math.max(0, ...authors.map((a) => Number(a.id) || 0)) + 1;
    await store.saveAuthor({ id: String(id), login, email: user.email, display_name: user.name || login, first_name: "", last_name: "" });
  }
  return login;
}

// --- the editor's view of an item ---
function toEditor(doc, idx) {
  const thumbId = Number(metaValue(doc, "_thumbnail_id")) || null;
  const thumb = thumbId && idx.itemById.get(thumbId);
  return {
    id: doc.post_id,
    type: doc.post_type,
    status: doc.status,
    title: doc.title,
    content: doc.content,
    excerpt: doc.excerpt,
    date: (doc.post_date || "").replace(" ", "T").slice(0, 16),
    slug: decode(doc.post_name),
    categories: doc.terms.filter((t) => t.domain === "category").map((t) => idx.categoryPathBySlug.get(t.nicename)).filter(Boolean),
    tags: doc.terms.filter((t) => t.domain === "post_tag").map((t) => t.name),
    thumbnailId: thumbId,
    thumbnailUrl: thumb ? (thumb.attachment_url || "").replace(/^https?:\/\/[^/]+/, "") : null,
    description: metaValue(doc, "_yoast_wpseo_metadesc") || "",
    permalink: idx.permalink(doc),
    password: doc.post_password || "",
  };
}

const STATUSES = ["publish", "draft", "pending", "private"];

/** Apply the editor's fields to a WordPress item, the way WordPress would store them. */
async function applyEdit(doc, input, idx, site, user, isNew) {
  const title = String(input.title ?? "").trim();
  if (!title) throw httpError(400, "חסרה כותרת");
  const status = STATUSES.includes(input.status) ? input.status : "draft";
  const wasPublic = !isNew && doc.status === "publish";
  doc.title = title;
  doc.content = String(input.content ?? "").replace(/<script[\s\S]*?<\/script>/gi, "");
  doc.excerpt = String(input.excerpt ?? "");
  doc.status = status;
  doc.post_password = String(input.password ?? "");

  const d = input.date ? fromLocalInput(input.date) : isNew ? nowDates() : null;
  if (d && d.local.slice(0, 16) !== (doc.post_date || "").slice(0, 16)) {
    // WordPress remembers old dates/slugs so old links keep working
    if (wasPublic && doc.post_type === "post" && doc.post_date) addMeta(doc, "_wp_old_date", doc.post_date.slice(0, 10));
    doc.post_date = d.local;
    doc.post_date_gmt = d.gmt;
    doc.pubDate = rfc2822(d.date);
  }

  const wantedSlug = wpSlug(input.slug || (isNew || !doc.post_name ? title : "")) || doc.post_name;
  if (wantedSlug && wantedSlug !== doc.post_name) {
    let slug = wantedSlug;
    const taken = new Set(site.items.filter((i) => i.post_type === doc.post_type && i.post_id !== doc.post_id && i.status !== "trash").map((i) => i.post_name));
    for (let n = 2; taken.has(slug); n++) slug = `${wantedSlug}-${n}`;
    if (wasPublic && doc.post_name) addMeta(doc, "_wp_old_slug", doc.post_name);
    doc.post_name = slug;
  }
  const link = idx.permalink(doc);
  if (status === "publish" && link && isReserved(link)) throw httpError(400, `הכתובת ${link} שמורה לאתר – בחרו כתובת אחרת`);

  if (doc.post_type === "post") {
    const byPath = new Map([...idx.categoryPathBySlug].map(([slug, path]) => [path, slug]));
    const cats = [].concat(input.categories ?? []).map((p) => byPath.get(p)).filter(Boolean);
    if (!cats.length) throw httpError(400, "יש לבחור לפחות קטגוריה אחת");
    const terms = cats.map((slug) => ({ domain: "category", nicename: slug, name: idx.catBySlug.get(slug).name }));
    const tagTerms = site.terms.filter((t) => t.taxonomy === "post_tag");
    let nextTerm = await store.nextId("terms");
    for (const raw of [].concat(input.tags ?? [])) {
      const name = String(raw).trim();
      if (!name) continue;
      let t = tagTerms.find((x) => x.name === name) || tagTerms.find((x) => decode(x.slug) === decode(wpSlug(name)));
      if (!t) {
        t = { term_id: nextTerm++, taxonomy: "post_tag", slug: wpSlug(name), parent: "", name, description: "", meta: [] };
        await store.saveTerm(t);
        tagTerms.push(t);
      }
      if (!terms.some((x) => x.domain === "post_tag" && x.nicename === t.slug)) terms.push({ domain: "post_tag", nicename: t.slug, name: t.name });
    }
    doc.terms = [...terms, ...doc.terms.filter((t) => t.domain !== "category" && t.domain !== "post_tag")];
  }
  setMeta(doc, "_thumbnail_id", input.thumbnailId ? Number(input.thumbnailId) : null);
  setMeta(doc, "_yoast_wpseo_metadesc", String(input.description ?? "").trim());
  const now = nowDates();
  doc.post_modified = now.local;
  doc.post_modified_gmt = now.gmt;
  if (isNew) doc.creator = await authorFor(user);
  return doc;
}

async function newItemDoc(type) {
  const id = await store.nextId();
  const base = await siteUrl();
  return {
    post_id: id, post_type: type, status: "draft", title: "", link: "", pubDate: "", creator: "",
    guid: type === "page" ? `${base}/?page_id=${id}` : `${base}/?p=${id}`, guid_is_permalink: "false", description: "",
    content: "", excerpt: "", post_date: "", post_date_gmt: "", post_modified: "", post_modified_gmt: "",
    comment_status: "closed", ping_status: "closed", post_name: "", post_parent: 0, menu_order: 0,
    post_password: "", is_sticky: 0, terms: [], meta: [], comments: [],
  };
}

api.get("/me", (req, res) => res.json(req.user));

api.get("/meta", wrap(async (req, res) => {
  const { site, idx } = await siteIndex();
  const categories = site.terms
    .filter((t) => t.taxonomy === "category")
    .map((c) => ({
      id: c.term_id,
      slug: idx.categoryPathBySlug.get(c.slug),
      name: c.name,
      description: c.description,
      parent: c.parent && idx.catBySlug.get(c.parent) ? idx.categoryPathBySlug.get(c.parent) : null,
    }));
  const tags = site.terms.filter((t) => t.taxonomy === "post_tag").map((t) => ({ id: t.term_id, slug: decode(t.slug), name: t.name }));
  res.json({ categories, tags, siteUrl: await siteUrl() });
}));

api.get("/status", wrap(async (req, res) => {
  const last = await lastBuild();
  const pending = await db.one(
    `SELECT (SELECT count(*) FROM wp_items WHERE $1::timestamptz IS NULL OR updated_at > $1)
          + (SELECT count(*) FROM settings WHERE key = 'taxonomy_changed' AND ($1::timestamptz IS NULL OR updated_at > $1)) AS n`,
    [last?.started_at ?? null],
  );
  const builds = await db.all("SELECT id, started_at, finished_at, status, requested_by FROM builds ORDER BY id DESC LIMIT 5");
  res.json({ building: isBuilding(), pending: Number(pending.n), builds, media: mediaSyncState(), mirror: mirrorState() });
}));

api.get("/build-log", wrap(async (req, res) => res.json(await db.one("SELECT id, status, log FROM builds ORDER BY id DESC LIMIT 1"))));

api.get("/items", wrap(async (req, res) => {
  const type = req.query.type === "page" ? "page" : "post";
  const { site, idx, opts } = await siteIndex();
  const last = await lastBuild();
  const rows = await db.all("SELECT post_id, updated_at, updated_by FROM wp_items WHERE post_type = $1", [type]);
  const upd = new Map(rows.map((r) => [Number(r.post_id), r]));
  const front = Number(opts.frontPageId);
  res.json(
    site.items
      .filter((i) => i.post_type === type && i.status !== "auto-draft" && i.post_id !== front)
      .map((i) => {
        const u = upd.get(i.post_id);
        return {
          id: i.post_id,
          title: i.title,
          status: i.status,
          date: i.post_date,
          permalink: idx.permalink(i),
          categories: i.terms.filter((t) => t.domain === "category").map((t) => idx.categoryPathBySlug.get(t.nicename)).filter(Boolean),
          updatedAt: u?.updated_at,
          updatedBy: u?.updated_by,
          pending: !!u && (!last || new Date(u.updated_at) > new Date(last.started_at)),
        };
      })
      .sort((a, b) => String(b.date).localeCompare(String(a.date))),
  );
}));

api.get("/item", wrap(async (req, res) => {
  const { idx } = await siteIndex();
  const doc = idx.itemById.get(Number(req.query.id));
  if (!doc || !["post", "page"].includes(doc.post_type)) throw httpError(404, "לא נמצא");
  const imported = await db.one("SELECT count(*) AS n FROM wp_item_history WHERE post_id = $1 AND reason = 'import'", [doc.post_id]);
  res.json({ ...toEditor(doc, idx), hasImported: Number(imported.n) > 0 });
}));

api.post("/item", wrap(async (req, res) => {
  const type = req.body.type === "page" ? "page" : "post";
  const { site, idx } = await siteIndex();
  const doc = await applyEdit(await newItemDoc(type), req.body, idx, site, req.user, true);
  await store.saveItem(doc, req.user.email);
  res.status(201).json({ id: doc.post_id });
}));

api.put("/item", wrap(async (req, res) => {
  const { site, idx } = await siteIndex();
  const current = idx.itemById.get(Number(req.query.id));
  if (!current || !["post", "page"].includes(current.post_type)) throw httpError(404, "לא נמצא");
  if (req.user.token && !DRAFT_STATUSES.includes(current.status)) throw httpError(403, "בטוקן אפשר לערוך רק טיוטות");
  const doc = await applyEdit(structuredClone(current), req.body, idx, site, req.user, false);
  await store.saveItem(doc, req.user.email);
  res.json({ id: doc.post_id });
}));

// deleting moves to the trash, like WordPress (restorable, still exported)
api.delete("/item", wrap(async (req, res) => {
  const doc = await store.getItem(Number(req.query.id));
  if (!doc || !["post", "page"].includes(doc.post_type)) throw httpError(404, "לא נמצא");
  setMeta(doc, "_wp_trash_meta_status", doc.status);
  setMeta(doc, "_wp_trash_meta_time", Math.floor(Date.now() / 1000));
  doc.status = "trash";
  await store.saveItem(doc, req.user.email, "trash");
  res.json({ ok: true });
}));

api.post("/untrash", wrap(async (req, res) => {
  const doc = await store.getItem(Number(req.body.id));
  if (!doc) throw httpError(404, "לא נמצא");
  doc.status = metaValue(doc, "_wp_trash_meta_status") || "draft";
  setMeta(doc, "_wp_trash_meta_status", null);
  setMeta(doc, "_wp_trash_meta_time", null);
  await store.saveItem(doc, req.user.email, "untrash");
  res.json({ ok: true });
}));

api.get("/history", wrap(async (req, res) => {
  res.json(
    await db.all(
      "SELECT id, saved_at, saved_by, reason, doc->>'title' AS title, doc->>'status' AS status FROM wp_item_history WHERE post_id = $1 ORDER BY id DESC LIMIT 60",
      [Number(req.query.id)],
    ),
  );
}));

api.post("/restore", wrap(async (req, res) => {
  const id = Number(req.body.id);
  const h =
    req.body.version === "import"
      ? await db.one("SELECT doc FROM wp_item_history WHERE post_id = $1 AND reason = 'import' ORDER BY id DESC LIMIT 1", [id])
      : await db.one("SELECT doc FROM wp_item_history WHERE post_id = $1 AND id = $2", [id, Number(req.body.version)]);
  if (!h) throw httpError(404, "הגרסה לא נמצאה");
  await store.saveItem(h.doc, req.user.email, "restore");
  res.json({ ok: true });
}));

api.post("/categories", wrap(async (req, res) => {
  const { site, idx } = await siteIndex();
  const name = String(req.body.name ?? "").trim();
  if (!name) throw httpError(400, "חסר שם קטגוריה");
  if (req.body.id) {
    const t = site.terms.find((x) => x.term_id === Number(req.body.id) && x.taxonomy === "category");
    if (!t) throw httpError(404, "הקטגוריה לא נמצאה");
    await store.saveTerm({ ...t, name, description: req.body.description ?? t.description });
  } else {
    const slug = wpSlug(name);
    if (!slug) throw httpError(400, "שם הקטגוריה חייב לכלול אותיות או ספרות");
    if (site.terms.some((t) => t.taxonomy === "category" && t.slug === slug)) throw httpError(409, "קטגוריה בשם הזה כבר קיימת");
    const byPath = new Map([...idx.categoryPathBySlug].map(([s, p]) => [p, s]));
    const parent = req.body.parent ? byPath.get(req.body.parent) : "";
    if (req.body.parent && !parent) throw httpError(400, "קטגוריית האב לא קיימת");
    await store.saveTerm({ term_id: await store.nextId("terms"), taxonomy: "category", slug, parent, name, description: String(req.body.description ?? ""), meta: [] });
  }
  await db.setSetting("taxonomy_changed", new Date().toISOString());
  res.json({ ok: true, slug: req.body.id ? undefined : indexSite(await store.loadSite(), await siteOptions()).categoryPathBySlug.get(wpSlug(name)) });
}));

// --- menu: edited as a tree, stored as WordPress nav_menu_item posts ---
api.get("/menu", wrap(async (req, res) => {
  const { site, idx, opts } = await siteIndex();
  res.json(buildMenuTree(site, idx, opts));
}));
api.put("/menu", wrap(async (req, res) => {
  const { site, idx, opts } = await siteIndex();
  await saveMenuTree(site, idx, opts, req.body.tree, req.user.email, await siteUrl());
  res.json({ ok: true });
}));

api.post("/publish", wrap(async (req, res) => {
  requestBuild(req.user.email);
  res.json({ ok: true });
}));

// --- media library (WordPress attachments) ---
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });
// what WordPress allows by default for non-admins (no html/svg/php/js)
const UPLOAD_MIME = {
  ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "video/mp4", ".txt": "text/plain; charset=utf-8",
};
const UPLOAD_TYPES = /^\.(jpe?g|png|gif|webp|avif|ico|heic|pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|zip|mp3|m4a|ogg|wav|mp4|m4v|mov|webm|ogv|key|pages|numbers)$/;
api.post("/upload", upload.single("file"), wrap(async (req, res) => {
  if (!req.file) throw httpError(400, "לא התקבל קובץ");
  const name = Buffer.from(req.file.originalname, "latin1").toString("utf8"); // multer reads names as latin1
  const ext = extname(name).toLowerCase().replace(/[^.a-z0-9]/g, "");
  if (!UPLOAD_TYPES.test(ext)) throw httpError(400, `סוג הקובץ ${ext || "(ללא סיומת)"} אינו מותר להעלאה`);
  const stem = name.slice(0, name.length - extname(name).length);
  const safeStem = decode(wpSlug(stem)) || "file";
  const now = nowDates();
  const dir = now.local.slice(0, 7).replace("-", "/");
  const files = new Set(
    (await db.all("SELECT doc->'meta' AS meta FROM wp_items WHERE post_type = 'attachment'")).map((r) => r.meta?.find((m) => m.key === "_wp_attached_file")?.value),
  );
  let file = `${dir}/${safeStem}${ext}`;
  for (let n = 2; files.has(file); n++) file = `${dir}/${safeStem}-${n}${ext}`;
  await putFile(storageKey(file), req.file.buffer, req.file.mimetype);
  const base = await siteUrl();
  const doc = await newItemDoc("attachment");
  Object.assign(doc, {
    status: "inherit", title: stem, post_name: wpSlug(stem), post_date: now.local, post_date_gmt: now.gmt,
    post_modified: now.local, post_modified_gmt: now.gmt, pubDate: rfc2822(now.date), comment_status: "open",
    guid: `${base}/wp-content/uploads/${file}`, attachment_url: `${base}/wp-content/uploads/${file}`,
    post_parent: Number(req.body.parent) || 0, creator: await authorFor(req.user),
    meta: [{ key: "_wp_attached_file", value: file }],
  });
  await store.saveItem(doc, req.user.email, "upload");
  res.json({ id: doc.post_id, url: `/wp-content/uploads/${file}`, name, size: req.file.size });
}));

api.get("/uploads", wrap(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const rows = await db.all(
    `SELECT post_id, doc->>'title' AS title, doc->>'post_date' AS date, doc->'meta' AS meta FROM wp_items
     WHERE post_type = 'attachment' AND ($3 = '' OR doc->>'title' ILIKE '%' || $3 || '%' OR doc::text ILIKE '%' || $3 || '%')
     ORDER BY doc->>'post_date' DESC LIMIT $1 OFFSET $2`,
    [Math.min(Number(req.query.limit) || 60, 200), Number(req.query.offset) || 0, q],
  );
  const total = await db.one("SELECT count(*) AS n FROM wp_items WHERE post_type = 'attachment'");
  await visibilityReady();
  res.json({
    total: Number(total.n),
    items: rows.map((r) => {
      const file = r.meta?.find((m) => m.key === "_wp_attached_file")?.value;
      return { id: Number(r.post_id), title: r.title, date: r.date, file, url: file ? `/wp-content/uploads/${file}` : null, visibility: file ? fileStatus(file) : null };
    }),
  });
}));

// a file's visibility: auto (public when the published site uses it), or pinned public / private
api.put("/uploads/visibility", wrap(async (req, res) => {
  const file = String(req.body.file ?? "");
  if (!file || !isSafeUploadPath(file)) throw httpError(400, "קובץ לא תקין");
  res.json(await setFileMode(file, String(req.body.mode), req.user.email));
}));

api.delete("/uploads", wrap(async (req, res) => {
  const doc = await store.getItem(Number(req.query.id));
  if (!doc || doc.post_type !== "attachment") throw httpError(404, "לא נמצא");
  const file = attachmentFile(doc);
  if (file) await deleteFile(storageKey(file)).catch(() => {});
  await store.deleteItem(doc.post_id);
  res.json({ ok: true });
}));

// --- WXR export / import ---
api.get("/export", wrap(async (req, res) => {
  const { idx } = await siteIndex();
  // published items get their real address; others keep WordPress' ?p= / ?page_id= link
  const site = await store.siteForExport(await siteUrl(), (doc) => idx.permalinkById.get(doc.post_id));
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="octopus.WordPress.${stamp}.xml"`);
  res.send(serializeWxr(site));
}));

const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
const pendingImports = new Map(); // token -> { site, at }

api.post("/import/preview", importUpload.single("file"), wrap(async (req, res) => {
  if (!req.file) throw httpError(400, "לא התקבל קובץ");
  const mode = req.body.mode === "replace" ? "replace" : "append";
  // a ZIP package holds one WXR file and the files it uses, under wp-content/uploads/
  let xml = req.file.buffer;
  let files = [];
  if (req.file.buffer.subarray(0, 2).toString() === "PK") {
    let entries;
    try {
      entries = readZip(req.file.buffer);
    } catch (e) {
      throw httpError(400, e.message);
    }
    const xmls = entries.filter((e) => /\.xml$/i.test(e.name) && !e.name.includes("wp-content/uploads/"));
    if (xmls.length !== 1) throw httpError(400, "בקובץ ה-ZIP צריך להיות קובץ XML אחד של וורדפרס");
    xml = xmls[0].data;
    for (const e of entries) {
      const file = e.name.split("wp-content/uploads/")[1];
      if (!file) continue;
      if (!isSafeUploadPath(file) || !UPLOAD_TYPES.test(extname(file).toLowerCase())) throw httpError(400, `הקובץ ${e.name} אינו מותר להעלאה`);
      files.push({ file, data: e.data });
    }
  }
  let site;
  try {
    site = parseWxr(xml.toString("utf-8"));
  } catch (e) {
    throw httpError(400, /^(הקובץ|חסר)/.test(e.message) ? e.message : `הקובץ אינו קובץ XML תקין: ${e.message}`);
  }
  if (req.user.token) {
    if (mode !== "append") throw httpError(403, "בטוקן אפשר לייבא רק בהוספה (append)");
    const visible = site.items.filter((i) => ["post", "page"].includes(i.post_type) && !DRAFT_STATUSES.includes(i.status));
    if (visible.length) throw httpError(403, `בטוקן אפשר לייבא רק טיוטות. לא בטיוטה: ${visible.slice(0, 5).map((i) => i.title).join(", ")}`);
    const other = site.items.find((i) => !["post", "page", "attachment"].includes(i.post_type));
    if (other) throw httpError(403, `בטוקן אפשר לייבא רק פוסטים, עמודים וקבצים (נמצא: ${other.post_type})`);
  }
  for (const [k, v] of pendingImports) if (Date.now() - v.at > 3600e3) pendingImports.delete(k);
  const token = randomUUID();
  pendingImports.set(token, { site, files, at: Date.now(), by: req.user.sub });
  res.json({ token, title: site.meta.title, files: files.length, plan: await store.planImport(site, mode, await siteUrl()) });
}));

api.post("/import/run", wrap(async (req, res) => {
  const pending = pendingImports.get(req.body.token);
  if (!pending) throw httpError(410, "תוקף הקובץ פג – העלו אותו שוב");
  if (req.user.token && pending.by !== req.user.sub) throw httpError(403, "הייבוא הזה הוכן בהרשאה אחרת");
  const mode = req.body.mode === "replace" ? "replace" : "append";
  // a replace first keeps a full backup of what it overwrites
  if (mode === "replace" && (await store.itemCount()) > 0) {
    const { idx } = await siteIndex();
    const backup = serializeWxr(await store.siteForExport(await siteUrl(), (d) => idx.permalinkById.get(d.post_id)));
    const key = `backups/before-replace-${new Date().toISOString().replace(/[:.]/g, "-")}.xml`;
    await putFile(key, Buffer.from(backup, "utf-8"), "application/xml");
    const list = (await db.getSetting("backups")) ?? [];
    await db.setSetting("backups", [{ key, at: new Date().toISOString(), by: req.user.email }, ...list].slice(0, 50));
  }
  // files already on the site are never overwritten by an import
  for (const f of pending.files ?? []) if (!(await hasMedia(f.file))) await putFile(storageKey(f.file), f.data, UPLOAD_MIME[extname(f.file).toLowerCase()]);
  const result = await store.runImport(pending.site, mode, req.user.email, await siteUrl());
  pendingImports.delete(req.body.token);
  if (req.body.downloadMedia !== false) syncMedia([req.headers.host]).catch((e) => console.error("media sync", e));
  requestBuild(req.user.email);
  res.json(result);
}));

api.get("/backups", wrap(async (req, res) => res.json((await db.getSetting("backups")) ?? [])));
api.get("/backup", wrap(async (req, res) => {
  const key = String(req.query.key);
  if (!/^backups\/[\w.-]+\.xml$/.test(key)) throw httpError(400, "bad key");
  const f = await getFile(key);
  if (!f) throw httpError(404, "לא נמצא");
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${key.split("/").pop()}"`);
  f.stream.pipe(res);
}));

api.get("/media-sync", (req, res) => res.json(mediaSyncState()));
// copy every file of the old site's uploads folder (see archive/uploads-manifest.json)
api.get("/uploads-mirror", wrap(async (req, res) => res.json({ ...mirrorState(), last: await db.getSetting("upload_mirror"), source: MIRROR_SOURCE })));
api.post("/uploads-mirror", (req, res) => {
  mirrorUploads(MIRROR_SOURCE).catch((e) => console.error("uploads mirror", e));
  res.json({ ok: true });
});
api.post("/media-sync", (req, res) => {
  syncMedia([req.headers.host]).catch((e) => console.error("media sync", e));
  res.json({ ok: true });
});

// --- API tokens (signed-in editors only: a token cannot manage tokens) ---
api.get("/tokens", wrap(async (req, res) => res.json({ tokens: await listTokens(), maxHours: MAX_HOURS })));
api.post("/tokens", wrap(async (req, res) => {
  const t = await createToken({ name: req.body.name, hours: req.body.hours, createdBy: req.user.email });
  res.status(201).json(t);
}));
api.delete("/tokens", wrap(async (req, res) => {
  await revokeToken(Number(req.query.id));
  res.json({ ok: true });
}));

// --- editors ---
api.get("/editors", wrap(async (req, res) => {
  const env = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  res.json({ fixed: env, editors: await db.all("SELECT email, added_at, added_by FROM editors ORDER BY added_at") });
}));
api.post("/editors", wrap(async (req, res) => {
  const email = String(req.body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, "כתובת מייל לא תקינה");
  await db.query("INSERT INTO editors (email, added_by) VALUES ($1, $2) ON CONFLICT DO NOTHING", [email, req.user.email]);
  res.json({ ok: true });
}));
api.delete("/editors", wrap(async (req, res) => {
  await db.query("DELETE FROM editors WHERE email = $1", [String(req.query.email).toLowerCase()]);
  res.json({ ok: true });
}));

app.use("/api", api);

// ---------- site (last) ----------
app.get("/_routes.json", (req, res) => res.status(404).end());
app.use((req, res, next) => serveSite(req, res, next));
app.use((req, res) => {
  const page = join(currentDir(), "404.html");
  if (existsSync(page)) res.status(404).sendFile(page);
  else res.status(404).send("Not found");
});
app.use((err, req, res, next) => {
  if (!err.status || err.status >= 500) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : "שגיאת שרת" });
});

app.listen(PORT, "0.0.0.0", () => console.log(`listening on ${PORT}`));

// the old WordPress server the uploads folder is copied from (while it is still up)
const MIRROR_SOURCE = process.env.UPLOADS_MIRROR_SOURCE || "https://octopus.org.il";

// the image holds the archived baseline; bring the served site up to date with the database
requestBuild("startup");
if (await db.getSetting("needs_media_sync")) {
  await db.setSetting("needs_media_sync", false);
  syncMedia([]).catch((e) => console.error("media sync", e));
}

// copy the old uploads folder once per manifest (runs in the background, resumable:
// files already stored are skipped, so a restart simply continues)
{
  const manifest = loadManifest();
  const version = `${manifest.length}:${manifest.reduce((n, f) => n + (f.size || 0), 0)}`;
  const last = await db.getSetting("upload_mirror");
  if (manifest.length && (last?.version !== version || last?.failed?.length)) {
    mirrorUploads(MIRROR_SOURCE)
      .then((m) => db.setSetting("upload_mirror", { ...m, failed: m.failed.slice(0, 200), version }))
      .catch((e) => console.error("uploads mirror", e));
  }
}
