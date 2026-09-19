import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const common = {
  title: z.string(),
  permalink: z.string(),
  date: z.coerce.date(),
  modified: z.coerce.date().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  wpId: z.number().optional(),
  // "html" = archived WordPress markup (rendered as-is); "markdown" = new content
  format: z.enum(["html", "markdown"]).default("html"),
};

const posts = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/posts" }),
  schema: z.object({
    ...common,
    categories: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

const pages = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/pages" }),
  schema: z.object({ ...common, date: z.coerce.date().optional() }),
});

export const collections = { posts, pages };
