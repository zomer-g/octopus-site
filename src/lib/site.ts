import { getCollection, type CollectionEntry } from "astro:content";
import categoriesData from "../data/categories.json";
import tagsData from "../data/tags.json";
import noticesData from "../data/notices.json";

export type Post = CollectionEntry<"posts">;
export type Category = { slug: string; name: string; description: string; parent: string | null };
export type Tag = { slug: string; name: string };

export const SITE = {
  name: "התמנון",
  tagline: "מידע ציבורי לכל",
  fullName: "התמנון – מידע ציבורי לכל (ע\"ר)",
  logo: "/wp-content/uploads/2020/07/cropped-octopus-4.png",
};

export type Notice = { label: string; text: string; link?: string; linkLabel?: string };
/** Status notes ("notices" in site.config.json), such as a project the association no longer runs. */
const notices = noticesData as Record<string, Notice>;
export const noticeFor = (permalink: string): Notice | undefined => notices[permalink];

export const categories = categoriesData as Category[];
export const tags = tagsData as Tag[];
const catBySlug = new Map(categories.map((c) => [c.slug, c]));
const tagBySlug = new Map(tags.map((t) => [t.slug, t]));

export const categoryName = (slug: string) => catBySlug.get(slug)?.name ?? slug;
export const tagName = (slug: string) => tagBySlug.get(slug)?.name ?? slug;
export const categoryUrl = (slug: string) => `/category/${slug}/`;
export const tagUrl = (slug: string) => `/tag/${slug}/`;

let cache: Post[] | undefined;
export async function allPosts(): Promise<Post[]> {
  if (!cache) {
    const list = await getCollection("posts", (p) => !p.data.draft);
    cache = list.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
  }
  return cache;
}

/** A category archive includes its sub-categories, like WordPress. */
export const inCategory = (post: Post, slug: string) =>
  post.data.categories.some((c) => c === slug || c.startsWith(slug + "/"));

export async function postsInCategory(slug: string) {
  return (await allPosts()).filter((p) => inCategory(p, slug));
}

export const childCategories = (slug: string | null) => categories.filter((c) => c.parent === slug);

const dateFmt = new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jerusalem" });
export const formatDate = (d: Date) => dateFmt.format(d);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function excerpt(post: Post, len = 180) {
  let text = post.data.description;
  if (!text) text = (post.body ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > len ? text.slice(0, len).replace(/\s+\S*$/, "") + "…" : text;
}

/** HTML for a list of post cards (used inside archived page bodies, so it is a string). */
export function postCardsHtml(posts: Post[], opts: { moreUrl?: string; limit?: number } = {}) {
  const shown = opts.limit ? posts.slice(0, opts.limit) : posts;
  const cards = shown
    .map((p) => {
      const img = p.data.image
        ? `<a class="card-img" href="${escapeHtml(p.data.permalink)}" tabindex="-1" aria-hidden="true"><img src="${escapeHtml(p.data.image)}" alt="" loading="lazy"></a>`
        : `<a class="card-img placeholder" href="${escapeHtml(p.data.permalink)}" tabindex="-1" aria-hidden="true"><img src="${SITE.logo}" alt="" loading="lazy"></a>`;
      const cats = (p.data.categories ?? [])
        .slice(0, 2)
        .map((c) => `<a href="${escapeHtml(categoryUrl(c))}">${escapeHtml(categoryName(c))}</a>`)
        .join("");
      const notice = noticeFor(p.data.permalink);
      const badge = notice ? `<span class="badge-notice">${escapeHtml(notice.label)}</span>` : "";
      return `<article class="card">${img}<div class="card-body"><div class="card-cats">${badge}${cats}</div><h3><a href="${escapeHtml(p.data.permalink)}">${escapeHtml(p.data.title)}</a></h3>${p.data.date && p.data.categories ? `<time datetime="${p.data.date.toISOString()}">${formatDate(p.data.date)}</time>` : ""}<p>${escapeHtml(notice ? notice.text : excerpt(p))}</p></div></article>`;
    })
    .join("");
  const more =
    opts.moreUrl && opts.limit && posts.length > opts.limit
      ? `<p class="more"><a class="button" href="${escapeHtml(opts.moreUrl)}">לכל ${posts.length} הפרסומים ←</a></p>`
      : "";
  return `<div class="cards">${cards}</div>${more}`;
}

/** Posts selected by a list spec: "*", "<category>", "tag:<slug>", "cats:a,b", "paths:/x/|/y/". */
export async function postsForSpec(spec: string): Promise<{ posts: Post[]; moreUrl?: string }> {
  const all = await allPosts();
  if (spec === "*") return { posts: all, moreUrl: "/posts/" };
  if (spec.startsWith("tag:")) {
    const t = spec.slice(4);
    return { posts: all.filter((p) => p.data.tags.includes(t)), moreUrl: tagUrl(t) };
  }
  if (spec.startsWith("cats:")) {
    const cs = spec.slice(5).split(",");
    return { posts: all.filter((p) => cs.some((c) => inCategory(p, c))) };
  }
  if (spec.startsWith("paths:")) {
    const pages = (await getCollection("pages")) as unknown as Post[];
    const byPath = new Map([...all, ...pages].map((p) => [p.data.permalink, p]));
    return { posts: spec.slice(6).split("|").map((x) => byPath.get(x)).filter((p): p is Post => !!p) };
  }
  return { posts: all.filter((p) => inCategory(p, spec)), moreUrl: categoryUrl(spec) };
}

/** Replace <div data-post-list="spec"></div> markers (restored Newspack lists). */
export async function expandPostLists(html: string) {
  // \s also matches the &#160; padding an editor may add; &nbsp; and <br> too
  const re = /<div (data-[^>]*)>(?:\s|&nbsp;|<br\s*\/?>)*<\/div>/g;
  let out = html;
  for (const m of [...html.matchAll(re)]) {
    const [marker, attrs] = m;
    const spec = attrs.match(/data-post-list="([^"]+)"/)?.[1];
    if (!spec) continue;
    const limit = attrs.match(/data-limit="(\d+)"/)?.[1];
    const { posts, moreUrl } = await postsForSpec(spec.replace(/&amp;/g, "&"));
    out = out.replace(marker, postCardsHtml(posts, { limit: limit ? Number(limit) : undefined, moreUrl }));
  }
  return out;
}
