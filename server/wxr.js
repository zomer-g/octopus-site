// WordPress eXtended RSS (WXR 1.2) – parse to a plain "site" object and
// serialize back in the same layout WordPress' own exporter writes.
//
// site = {
//   meta:    { title, link, description, pubDate, language, base_site_url, base_blog_url, generator },
//   authors: [{ id, login, email, display_name, first_name, last_name }],
//   terms:   [{ term_id, taxonomy, slug, name, parent, description, meta: [{key,value}] }],
//   items:   [{ post_id, post_type, status, title, link, pubDate, creator, guid, guid_is_permalink,
//               description, content, excerpt, post_date, post_date_gmt, post_modified, post_modified_gmt,
//               comment_status, ping_status, post_name, post_parent, menu_order, post_password,
//               is_sticky, attachment_url, terms: [{domain, nicename, name}], meta: [{key, value}],
//               comments: [{...}] }]
// }
// Slugs (post_name, term slugs, nicenames) are kept exactly as WordPress stores them
// (percent-encoded UTF-8 for Hebrew), so a round trip is lossless.
import { XMLParser } from "fast-xml-parser";

const ARRAYS = new Set([
  "rss.channel.item",
  "rss.channel.wp:author",
  "rss.channel.wp:category",
  "rss.channel.wp:tag",
  "rss.channel.wp:term",
  "rss.channel.item.category",
  "rss.channel.item.wp:postmeta",
  "rss.channel.item.wp:comment",
  "rss.channel.item.wp:comment.wp:commentmeta",
  "rss.channel.wp:category.wp:termmeta",
  "rss.channel.wp:tag.wp:termmeta",
  "rss.channel.wp:term.wp:termmeta",
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  htmlEntities: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (name, jpath) => ARRAYS.has(jpath),
});

const text = (v) => {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return text(v["#text"]);
  return String(v);
};
const str = (v) => text(v).trim(); // scalar fields
const meta = (list) => (list ?? []).map((m) => ({ key: str(m["wp:meta_key"]), value: text(m["wp:meta_value"]) }));

export const COMMENT_FIELDS = [
  "comment_id", "comment_author", "comment_author_email", "comment_author_url", "comment_author_IP",
  "comment_date", "comment_date_gmt", "comment_content", "comment_approved", "comment_type",
  "comment_parent", "comment_user_id",
];

export function parseWxr(xml) {
  // WordPress never writes a DOCTYPE; refusing one rules out entity-expansion tricks
  // (only the prolog counts: post content may legitimately mention "<!DOCTYPE")
  const rssAt = xml.search(/<rss[\s>]/);
  if (/<!DOCTYPE/i.test(rssAt >= 0 ? xml.slice(0, rssAt) : xml)) throw new Error("הקובץ אינו תקין: קובץ ייצוא של וורדפרס אינו מכיל DOCTYPE");
  const doc = parser.parse(xml);
  const ch = doc?.rss?.channel;
  if (!ch) throw new Error("הקובץ אינו קובץ ייצוא של וורדפרס (WXR)");
  if (!ch["wp:wxr_version"]) throw new Error("חסר wxr_version – הקובץ אינו ייצוא וורדפרס תקין");

  const site = {
    meta: {
      title: str(ch.title),
      link: str(ch.link),
      description: str(ch.description),
      pubDate: str(ch.pubDate),
      language: str(ch.language),
      wxr_version: str(ch["wp:wxr_version"]),
      base_site_url: str(ch["wp:base_site_url"]),
      base_blog_url: str(ch["wp:base_blog_url"]),
      generator: str(ch.generator),
    },
    authors: (ch["wp:author"] ?? []).map((a) => ({
      id: str(a["wp:author_id"]),
      login: str(a["wp:author_login"]),
      email: str(a["wp:author_email"]),
      display_name: str(a["wp:author_display_name"]),
      first_name: str(a["wp:author_first_name"]),
      last_name: str(a["wp:author_last_name"]),
    })),
    terms: [],
    items: [],
  };

  for (const c of ch["wp:category"] ?? [])
    site.terms.push({
      term_id: Number(str(c["wp:term_id"])),
      taxonomy: "category",
      slug: str(c["wp:category_nicename"]),
      parent: str(c["wp:category_parent"]),
      name: text(c["wp:cat_name"]),
      description: text(c["wp:category_description"]),
      meta: meta(c["wp:termmeta"]),
    });
  for (const t of ch["wp:tag"] ?? [])
    site.terms.push({
      term_id: Number(str(t["wp:term_id"])),
      taxonomy: "post_tag",
      slug: str(t["wp:tag_slug"]),
      parent: "",
      name: text(t["wp:tag_name"]),
      description: text(t["wp:tag_description"]),
      meta: meta(t["wp:termmeta"]),
    });
  for (const t of ch["wp:term"] ?? [])
    site.terms.push({
      term_id: Number(str(t["wp:term_id"])),
      taxonomy: str(t["wp:term_taxonomy"]),
      slug: str(t["wp:term_slug"]),
      parent: str(t["wp:term_parent"]),
      name: text(t["wp:term_name"]),
      description: text(t["wp:term_description"]),
      meta: meta(t["wp:termmeta"]),
    });

  for (const it of ch.item ?? []) {
    const guid = it.guid;
    site.items.push({
      post_id: Number(str(it["wp:post_id"])),
      post_type: str(it["wp:post_type"]),
      status: str(it["wp:status"]),
      title: text(it.title),
      link: str(it.link),
      pubDate: str(it.pubDate),
      creator: str(it["dc:creator"]),
      guid: str(guid),
      guid_is_permalink: typeof guid === "object" ? guid["@isPermaLink"] ?? "false" : "false",
      description: text(it.description),
      content: text(it["content:encoded"]),
      excerpt: text(it["excerpt:encoded"]),
      post_date: str(it["wp:post_date"]),
      post_date_gmt: str(it["wp:post_date_gmt"]),
      post_modified: str(it["wp:post_modified"]),
      post_modified_gmt: str(it["wp:post_modified_gmt"]),
      comment_status: str(it["wp:comment_status"]),
      ping_status: str(it["wp:ping_status"]),
      post_name: str(it["wp:post_name"]),
      post_parent: Number(str(it["wp:post_parent"]) || 0),
      menu_order: Number(str(it["wp:menu_order"]) || 0),
      post_password: text(it["wp:post_password"]),
      is_sticky: Number(str(it["wp:is_sticky"]) || 0),
      attachment_url: it["wp:attachment_url"] !== undefined ? str(it["wp:attachment_url"]) : undefined,
      terms: (it.category ?? []).map((c) => ({ domain: c["@domain"], nicename: c["@nicename"], name: text(c) })),
      meta: meta(it["wp:postmeta"]),
      comments: (it["wp:comment"] ?? []).map((c) => {
        const out = {};
        for (const f of COMMENT_FIELDS) out[f] = text(c[`wp:${f}`]);
        out.meta = (c["wp:commentmeta"] ?? []).map((m) => ({ key: str(m["wp:meta_key"]), value: text(m["wp:meta_value"]) }));
        return out;
      }),
    });
  }
  // ids are used as numbers and file names: reject a file where they are not
  const badItem = site.items.find((i) => !Number.isSafeInteger(i.post_id) || i.post_id <= 0);
  if (badItem) throw new Error(`הקובץ אינו תקין: מזהה פריט לא חוקי (${badItem.title || "ללא כותרת"})`);
  const badTerm = site.terms.find((t) => !Number.isSafeInteger(t.term_id) || t.term_id <= 0);
  if (badTerm) throw new Error(`הקובץ אינו תקין: מזהה קטגוריה/תגית לא חוקי (${badTerm.name})`);
  return site;
}

// ---------- serialize ----------
const cdata = (s) => `<![CDATA[${String(s ?? "").replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
const xmlEsc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function serializeWxr(site) {
  const m = site.meta;
  const out = [];
  const w = (s) => out.push(s);
  w(`<?xml version="1.0" encoding="UTF-8" ?>
<!-- This is a WordPress eXtended RSS file generated by WordPress as an export of your site. -->
<!-- It contains information about your site's posts, pages, comments, categories, and other content. -->
<!-- You may use this file to transfer that content from one site to another. -->
<!-- This file is not intended to serve as a complete backup of your site. -->

<!-- To import this information into a WordPress site follow these steps: -->
<!-- 1. Log in to that site as an administrator. -->
<!-- 2. Go to Tools: Import in the WordPress admin panel. -->
<!-- 3. Install the "WordPress" importer from the list. -->
<!-- 4. Activate & Run Importer. -->
<!-- 5. Upload this file using the form provided on that page. -->
<!-- 6. You will first be asked to map the authors in this export file to users -->
<!--    on the site. For each author, you may choose to map to an -->
<!--    existing user on the site or to create a new user. -->
<!-- 7. WordPress will then import each of the posts, pages, comments, categories, etc. -->
<!--    contained in this file into your site. -->

	<!-- generator="WordPress/6.8" created="${new Date().toISOString().slice(0, 16).replace("T", " ")}" -->
<rss version="2.0"
	xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
	xmlns:content="http://purl.org/rss/1.0/modules/content/"
	xmlns:wfw="http://wellformedweb.org/CommentAPI/"
	xmlns:dc="http://purl.org/dc/elements/1.1/"
	xmlns:wp="http://wordpress.org/export/1.2/"
>

<channel>
	<title>${xmlEsc(m.title)}</title>
	<link>${xmlEsc(m.link)}</link>
	<description>${xmlEsc(m.description)}</description>
	<pubDate>${new Date().toUTCString().replace("GMT", "+0000")}</pubDate>
	<language>${xmlEsc(m.language || "he-IL")}</language>
	<wp:wxr_version>1.2</wp:wxr_version>
	<wp:base_site_url>${xmlEsc(m.base_site_url)}</wp:base_site_url>
	<wp:base_blog_url>${xmlEsc(m.base_blog_url)}</wp:base_blog_url>
`);
  for (const a of site.authors)
    w(`\n\t<wp:author><wp:author_id>${Number(a.id) || 0}</wp:author_id><wp:author_login>${cdata(a.login)}</wp:author_login><wp:author_email>${cdata(a.email)}</wp:author_email><wp:author_display_name>${cdata(a.display_name)}</wp:author_display_name><wp:author_first_name>${cdata(a.first_name)}</wp:author_first_name><wp:author_last_name>${cdata(a.last_name)}</wp:author_last_name></wp:author>`);
  w("\n");

  const termMeta = (t) => (t.meta ?? []).map((x) => `\n\t\t<wp:termmeta>\n\t\t\t<wp:meta_key>${cdata(x.key)}</wp:meta_key>\n\t\t\t<wp:meta_value>${cdata(x.value)}</wp:meta_value>\n\t\t</wp:termmeta>`).join("");
  const byTax = (tax) => orderTerms(site.terms.filter((t) => t.taxonomy === tax));
  for (const c of byTax("category")) {
    w(`\n\t<wp:category>\n\t\t<wp:term_id>${c.term_id}</wp:term_id>\n\t\t<wp:category_nicename>${cdata(c.slug)}</wp:category_nicename>\n\t\t<wp:category_parent>${cdata(c.parent)}</wp:category_parent>\n\t\t<wp:cat_name>${cdata(c.name)}</wp:cat_name>`);
    if (c.description) w(`\n\t\t<wp:category_description>${cdata(c.description)}</wp:category_description>`);
    w(`${termMeta(c)}\n\t</wp:category>`);
  }
  for (const t of byTax("post_tag")) {
    w(`\n\t<wp:tag>\n\t\t<wp:term_id>${t.term_id}</wp:term_id>\n\t\t<wp:tag_slug>${cdata(t.slug)}</wp:tag_slug>\n\t\t<wp:tag_name>${cdata(t.name)}</wp:tag_name>`);
    if (t.description) w(`\n\t\t<wp:tag_description>${cdata(t.description)}</wp:tag_description>`);
    w(`${termMeta(t)}\n\t</wp:tag>`);
  }
  for (const t of orderTerms(site.terms.filter((t) => t.taxonomy !== "category" && t.taxonomy !== "post_tag"))) {
    w(`\n\t<wp:term>\n\t\t<wp:term_id>${t.term_id}</wp:term_id>\n\t\t<wp:term_taxonomy>${cdata(t.taxonomy)}</wp:term_taxonomy>\n\t\t<wp:term_slug>${cdata(t.slug)}</wp:term_slug>\n\t\t<wp:term_parent>${cdata(t.parent)}</wp:term_parent>\n\t\t<wp:term_name>${cdata(t.name)}</wp:term_name>`);
    if (t.description) w(`\n\t\t<wp:term_description>${cdata(t.description)}</wp:term_description>`);
    w(`${termMeta(t)}\n\t</wp:term>`);
  }
  w(`\n\n\t<generator>${xmlEsc(m.generator || "https://wordpress.org/?v=6.8")}</generator>\n`);

  for (const it of site.items) {
    w(`
	<item>
		<title>${cdata(it.title)}</title>
		<link>${xmlEsc(it.link)}</link>
		<pubDate>${xmlEsc(it.pubDate)}</pubDate>
		<dc:creator>${cdata(it.creator)}</dc:creator>
		<guid isPermaLink="${it.guid_is_permalink === "true" ? "true" : "false"}">${xmlEsc(it.guid)}</guid>
		<description>${xmlEsc(it.description)}</description>
		<content:encoded>${cdata(it.content)}</content:encoded>
		<excerpt:encoded>${cdata(it.excerpt)}</excerpt:encoded>
		<wp:post_id>${it.post_id}</wp:post_id>
		<wp:post_date>${cdata(it.post_date)}</wp:post_date>
		<wp:post_date_gmt>${cdata(it.post_date_gmt)}</wp:post_date_gmt>
		<wp:post_modified>${cdata(it.post_modified)}</wp:post_modified>
		<wp:post_modified_gmt>${cdata(it.post_modified_gmt)}</wp:post_modified_gmt>
		<wp:comment_status>${cdata(it.comment_status)}</wp:comment_status>
		<wp:ping_status>${cdata(it.ping_status)}</wp:ping_status>
		<wp:post_name>${cdata(it.post_name)}</wp:post_name>
		<wp:status>${cdata(it.status)}</wp:status>
		<wp:post_parent>${Number(it.post_parent) || 0}</wp:post_parent>
		<wp:menu_order>${Number(it.menu_order) || 0}</wp:menu_order>
		<wp:post_type>${cdata(it.post_type)}</wp:post_type>
		<wp:post_password>${cdata(it.post_password)}</wp:post_password>
		<wp:is_sticky>${Number(it.is_sticky) || 0}</wp:is_sticky>`);
    if (it.attachment_url !== undefined) w(`\n\t\t<wp:attachment_url>${cdata(it.attachment_url)}</wp:attachment_url>`);
    for (const t of it.terms ?? [])
      w(`\n\t\t<category domain="${xmlEsc(t.domain)}" nicename="${xmlEsc(t.nicename)}">${cdata(t.name)}</category>`);
    for (const x of it.meta ?? [])
      w(`\n\t\t<wp:postmeta>\n\t\t<wp:meta_key>${cdata(x.key)}</wp:meta_key>\n\t\t<wp:meta_value>${cdata(x.value)}</wp:meta_value>\n\t\t</wp:postmeta>`);
    for (const c of it.comments ?? []) {
      w(`\n\t\t<wp:comment>`);
      for (const f of COMMENT_FIELDS) {
        const plain = ["comment_id", "comment_parent", "comment_user_id"].includes(f);
        const v = c[f] ?? "";
        w(`\n\t\t\t<wp:${f}>${plain ? Number(v) || 0 : f === "comment_author_url" ? xmlEsc(v) : cdata(v)}</wp:${f}>`);
      }
      for (const x of c.meta ?? [])
        w(`\n\t\t\t<wp:commentmeta>\n\t\t\t\t<wp:meta_key>${cdata(x.key)}</wp:meta_key>\n\t\t\t\t<wp:meta_value>${cdata(x.value)}</wp:meta_value>\n\t\t\t</wp:commentmeta>`);
      w(`\n\t\t</wp:comment>`);
    }
    w(`\n\t</item>`);
  }
  w(`\n\t</channel>\n</rss>\n`);
  return out.join("");
}

/** Parents before children (WordPress' importer needs that order for terms). */
function orderTerms(terms) {
  const bySlug = new Map(terms.map((t) => [t.slug, t]));
  const done = new Set();
  const out = [];
  const visit = (t, depth = 0) => {
    if (done.has(t) || depth > 50) return;
    const p = t.parent && bySlug.get(t.parent);
    if (p && p !== t) visit(p, depth + 1);
    done.add(t);
    out.push(t);
  };
  terms.forEach((t) => visit(t));
  return out;
}
