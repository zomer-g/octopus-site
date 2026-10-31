import type { APIRoute } from "astro";
import { allPosts, SITE } from "../lib/site";
import { feedTitle, rssResponse } from "../lib/feed";

export const GET: APIRoute = async ({ site }) =>
  rssResponse({
    title: feedTitle(),
    link: site!,
    self: new URL("/rss.xml", site),
    description: SITE.tagline,
    posts: (await allPosts()).slice(0, 30),
  });
