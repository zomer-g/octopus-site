// Public, read-only access to the published archive:
//   /api/public/...  JSON (REST)
//   /mcp             MCP server (Streamable HTTP, stateless JSON-RPC)
// Both read data/content.json from the build being served, so they show
// exactly what the site shows: published content only, never drafts.
import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let data = null;

/** Load the archive of the build in `dir` (called at boot and on every swap). */
export function loadPublicData(dir) {
  const f = join(dir, "data/content.json");
  try {
    if (!existsSync(f)) throw new Error("missing");
    const d = JSON.parse(readFileSync(f, "utf-8"));
    for (const p of [...d.posts, ...d.pages]) p._search = `${p.title} ${p.content_text}`.toLowerCase();
    data = d;
  } catch (e) {
    console.warn("public data not loaded from", dir, e.message);
  }
}

const strip = ({ _search, ...p }) => p;
const summary = ({ _search, content_html, content_text, ...p }) => ({
  ...p,
  excerpt: content_text.length > 300 ? content_text.slice(0, 300).replace(/\s+\S*$/, "") + "…" : content_text,
});

function catMatches(p, cat) {
  return p.categories.some((c) => c.slug === cat || c.slug.startsWith(cat + "/") || c.name === cat);
}

/** Posts matching the filters, newest first (search results: title matches first). */
function findPosts({ q, category, tag, from, to, type = "post" } = {}) {
  let list = type === "page" ? data.pages : data.posts;
  if (category) list = list.filter((p) => catMatches(p, String(category)));
  if (tag) list = list.filter((p) => p.tags.includes(String(tag)));
  if (from) list = list.filter((p) => p.date && p.date >= String(from));
  if (to) list = list.filter((p) => p.date && p.date.slice(0, 10) <= String(to));
  if (q) {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter((p) => words.every((w) => p._search.includes(w)));
    const inTitle = (p) => words.some((w) => p.title.toLowerCase().includes(w));
    list = [...list.filter(inTitle), ...list.filter((p) => !inTitle(p))];
  }
  return list;
}

function findOne({ id, url, path }) {
  const all = [...data.posts, ...data.pages];
  if (id !== undefined && id !== null && id !== "") return all.find((p) => String(p.id) === String(id));
  const want = String(url ?? path ?? "");
  if (!want) return undefined;
  let p = want;
  try {
    p = decodeURIComponent(new URL(want, "https://x").pathname);
  } catch {}
  if (!p.endsWith("/")) p += "/";
  return all.find((x) => x.path === p);
}

const page = (list, limit, offset) => {
  const l = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const o = Math.max(Number(offset) || 0, 0);
  return { total: list.length, limit: l, offset: o, items: list.slice(o, o + l).map(summary) };
};

// ---------- REST ----------
export const publicApi = express.Router();
publicApi.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=300");
  if (!data) return res.status(503).json({ error: "הנתונים עוד לא נטענו, נסו שוב בעוד דקה" });
  next();
});
publicApi.get("/", (req, res) =>
  res.json({
    name: data.site.name,
    generated_at: data.generated_at,
    counts: { posts: data.posts.length, pages: data.pages.length, categories: data.categories.length },
    endpoints: {
      "GET /api/public/posts": "q, category, tag, from (YYYY-MM-DD), to, limit (עד 100), offset",
      "GET /api/public/posts/{id}": "פוסט מלא, כולל content_html ו-content_text",
      "GET /api/public/pages": "q, limit, offset",
      "GET /api/public/pages/{id}": "עמוד מלא",
      "GET /api/public/lookup?url=": "פוסט או עמוד לפי הכתובת שלו",
      "GET /api/public/categories": "",
      "GET /api/public/tags": "",
      "GET /data/content.json": "כל הארכיון בקובץ אחד",
      "GET /rss.xml": "RSS של 30 הפרסומים האחרונים",
      "GET /category/{slug}/rss.xml": "RSS לפי נושא",
      "POST /mcp": "שרת MCP (Streamable HTTP)",
    },
    license_note: data.license_note,
  }),
);
publicApi.get("/posts", (req, res) => res.json(page(findPosts(req.query), req.query.limit, req.query.offset)));
publicApi.get("/posts/:id", (req, res) => {
  const p = data.posts.find((x) => String(x.id) === req.params.id);
  return p ? res.json(strip(p)) : res.status(404).json({ error: "לא נמצא" });
});
publicApi.get("/pages", (req, res) => res.json(page(findPosts({ ...req.query, type: "page" }), req.query.limit, req.query.offset)));
publicApi.get("/pages/:id", (req, res) => {
  const p = data.pages.find((x) => String(x.id) === req.params.id);
  return p ? res.json(strip(p)) : res.status(404).json({ error: "לא נמצא" });
});
publicApi.get("/lookup", (req, res) => {
  const p = findOne({ url: req.query.url });
  return p ? res.json(strip(p)) : res.status(404).json({ error: "לא נמצא" });
});
publicApi.get("/categories", (req, res) =>
  res.json(data.categories.map((c) => ({ ...c, posts: data.posts.filter((p) => catMatches(p, c.slug)).length }))),
);
publicApi.get("/tags", (req, res) => {
  const used = new Map();
  for (const p of data.posts) for (const t of p.tags) used.set(t, (used.get(t) ?? 0) + 1);
  res.json(data.tags.filter((t) => used.has(t.slug)).map((t) => ({ ...t, posts: used.get(t.slug) })));
});
publicApi.use((req, res) => res.status(404).json({ error: "לא נמצא" }));

// ---------- MCP ----------
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "ארכיון האתר של עמותת התמנון (octopus.org.il), עמותה לקידום הנגשת מידע ציבורי ומשפטי בישראל. " +
  "העמותה אינה יוזמת עוד פעילות, והאתר משמש כארכיון. הכלים קוראים רק תוכן שפורסם. " +
  "התחילו ב-search_posts או list_categories, וקראו פרסום מלא ב-get_post. בתשובה, קשרו לכתובת (url) של הפרסום.";

const TOOLS = [
  {
    name: "search_posts",
    description: "חיפוש פרסומים בארכיון: טקסט חופשי, נושא, תגית וטווח תאריכים. מחזיר תקצירים, מהחדש לישן (התאמות בכותרת קודם).",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "מילים לחיפוש בכותרת ובתוכן. כל המילים חייבות להופיע." },
        category: { type: "string", description: "slug או שם של נושא, מ-list_categories. כולל תתי-נושאים." },
        tag: { type: "string", description: "slug של תגית" },
        from: { type: "string", description: "מתאריך, YYYY-MM-DD" },
        to: { type: "string", description: "עד תאריך, YYYY-MM-DD" },
        limit: { type: "integer", description: "עד 100, ברירת מחדל 20" },
        offset: { type: "integer" },
      },
    },
  },
  {
    name: "get_post",
    description: "פרסום או עמוד מלא לפי id או לפי הכתובת שלו באתר: כותרת, תאריך, נושאים, תגיות וטקסט מלא.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "id מתוצאות החיפוש" },
        url: { type: "string", description: "כתובת באתר, למשל https://octopus.org.il/2021/02/04/tl8/" },
        include_html: { type: "boolean", description: "להחזיר גם את ה-HTML המקורי" },
      },
    },
  },
  {
    name: "list_categories",
    description: "כל הנושאים באתר, עם מספר הפרסומים בכל אחד.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_pages",
    description: "העמודים הקבועים של האתר (אודות, פרויקטים, ארכיונים).",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  },
];

function callTool(name, args = {}) {
  if (name === "search_posts") return page(findPosts(args), args.limit, args.offset);
  if (name === "get_post") {
    const p = findOne(args);
    if (!p) throw Object.assign(new Error("לא נמצא פרסום כזה"), { toolError: true });
    const { content_html, ...rest } = strip(p);
    return args.include_html ? { ...rest, content_html } : rest;
  }
  if (name === "list_categories") return data.categories.map((c) => ({ ...c, posts: data.posts.filter((p) => catMatches(p, c.slug)).length }));
  if (name === "list_pages") return findPosts({ q: args.q, type: "page" }).map(summary);
  throw Object.assign(new Error(`אין כלי בשם ${name}`), { code: -32602 });
}

function handleRpc(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  }
  const isNotification = msg.id === undefined || msg.id === null;
  const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, error: { code, message } });
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "octopus-archive", title: "ארכיון עמותת התמנון", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      if (!data) return reply({ isError: true, content: [{ type: "text", text: "הנתונים עוד לא נטענו, נסו שוב בעוד דקה" }] });
      try {
        const result = callTool(msg.params?.name, msg.params?.arguments ?? {});
        return reply({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: Array.isArray(result) ? { items: result } : result });
      } catch (e) {
        if (e.toolError) return reply({ isError: true, content: [{ type: "text", text: e.message }] });
        return fail(e.code ?? -32603, e.message);
      }
    }
    default:
      if (msg.method.startsWith("notifications/")) return null;
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export const mcp = express.Router();
mcp.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-protocol-version, mcp-session-id, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
mcp.post("/", express.json({ limit: "1mb" }), (req, res) => {
  const body = req.body;
  const batch = Array.isArray(body);
  const out = (batch ? body : [body]).map(handleRpc).filter(Boolean);
  if (!out.length) return res.status(202).end();
  res.json(batch ? out : out[0]);
});
// stateless server: no server-initiated stream, no sessions to end
mcp.get("/", (req, res) => res.status(405).set("Allow", "POST").json({ error: "use POST (MCP Streamable HTTP)" }));
mcp.delete("/", (req, res) => res.status(405).set("Allow", "POST").end());
mcp.use((err, req, res, next) => res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
