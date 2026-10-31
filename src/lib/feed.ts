import { excerpt, SITE, type Post } from "./site";

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** An RSS 2.0 feed of the given posts (newest first). */
export function rssResponse(opts: { title: string; link: URL; self: URL; description: string; posts: Post[] }) {
  const items = opts.posts
    .map((p) => {
      const url = new URL(p.data.permalink, opts.link).href;
      const cats = p.data.categories.map((c) => `<category>${esc(c)}</category>`).join("");
      return `<item><title>${esc(p.data.title)}</title><link>${esc(url)}</link><guid>${esc(url)}</guid><pubDate>${p.data.date.toUTCString()}</pubDate>${cats}<description>${esc(excerpt(p, 400))}</description></item>`;
    })
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${esc(opts.title)}</title><link>${esc(opts.link.href)}</link><atom:link href="${esc(opts.self.href)}" rel="self" type="application/rss+xml"/><description>${esc(opts.description)}</description><language>he-IL</language>${items}</channel></rss>`;
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}

export const feedTitle = (name?: string) => (name ? `${SITE.name} – ${name}` : SITE.name);
