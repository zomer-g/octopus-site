import type { APIRoute } from "astro";
import { categories, categoryUrl, postsInCategory, type Category } from "../../../lib/site";
import { feedTitle, rssResponse } from "../../../lib/feed";

export function getStaticPaths() {
  return categories.map((c) => ({ params: { slug: c.slug }, props: { cat: c } }));
}

export const GET: APIRoute = async ({ site, props }) => {
  const cat = props.cat as Category;
  return rssResponse({
    title: feedTitle(cat.name),
    link: new URL(categoryUrl(cat.slug), site),
    self: new URL(`${categoryUrl(cat.slug)}rss.xml`, site),
    description: cat.description || `פרסומים בנושא ${cat.name}`,
    posts: (await postsInCategory(cat.slug)).slice(0, 30),
  });
};
