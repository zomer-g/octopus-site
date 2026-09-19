import type { APIRoute } from "astro";
import { allPosts, excerpt, SITE } from "../lib/site";

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export const GET: APIRoute = async ({ site }) => {
  const posts = (await allPosts()).slice(0, 30);
  const items = posts
    .map((p) => {
      const url = new URL(p.data.permalink, site).href;
      return `<item><title>${esc(p.data.title)}</title><link>${esc(url)}</link><guid>${esc(url)}</guid><pubDate>${p.data.date.toUTCString()}</pubDate><description>${esc(excerpt(p, 400))}</description></item>`;
    })
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${SITE.name}</title><link>${site}</link><description>${SITE.tagline}</description><language>he-IL</language>${items}</channel></rss>`;
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
};
