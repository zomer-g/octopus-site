// The whole published archive as one JSON file: the public API and the MCP
// server (server/public-api.js) read it, and anyone can download it.
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { allPosts, categories, categoryName, SITE, tags, type Post } from "../../lib/site";

const text = (html: string) =>
  html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

export const GET: APIRoute = async ({ site }) => {
  const abs = (path?: string) => (path ? new URL(path, site).href : null);
  const entry = (p: Post, type: "post" | "page") => {
    const html = p.body ?? "";
    return {
      id: p.data.wpId ?? null,
      type,
      title: p.data.title,
      url: abs(p.data.permalink),
      path: p.data.permalink,
      date: p.data.date?.toISOString() ?? null,
      modified: p.data.modified?.toISOString() ?? null,
      description: p.data.description ?? null,
      image: abs(p.data.image),
      categories: (p.data.categories ?? []).map((c) => ({ slug: c, name: categoryName(c) })),
      tags: p.data.tags ?? [],
      content_html: html,
      content_text: text(html),
    };
  };
  const pages = (await getCollection("pages")) as unknown as Post[];
  const data = {
    site: { name: SITE.fullName, url: site!.href, language: "he" },
    generated_at: new Date().toISOString(),
    license_note: "תוכן ארכיון האתר של עמותת התמנון. יש לציין את המקור ולקשר לפרסום המקורי.",
    categories: categories.map((c) => ({ slug: c.slug, name: c.name, parent: c.parent, description: c.description })),
    tags: tags.map((t) => ({ slug: t.slug, name: t.name })),
    posts: (await allPosts()).map((p) => entry(p, "post")),
    pages: pages.filter((p) => p.data.permalink !== "/").map((p) => entry(p, "page")),
  };
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json; charset=utf-8" } });
};
