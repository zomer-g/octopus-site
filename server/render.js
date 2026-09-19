// A small subset of WordPress' `the_content` pipeline, enough for this site:
// dynamic blocks -> post-list markers / embeds, classic content -> wpautop,
// a few shortcodes, and own-domain URLs made relative.

// the attributes JSON never runs past the end of its own comment
const BLOCK = /<!--\s+wp:([a-z0-9-]+(?:\/[a-z0-9-]+)?)(\s+(\{(?:(?!-->)[\s\S])*?\}))?\s+(\/)?-->/g;

const LIST_BLOCKS = new Set([
  "a8c/blog-posts", "a8c/posts-carousel", "newspack-blocks/homepage-articles", "newspack-blocks/carousel",
  "latest-posts", "core/latest-posts", "uagb/post-grid",
]);

/** True when the content holds a dynamic post list, which must be rendered from its settings. */
export function hasPostList(content) {
  for (const m of (content ?? "").matchAll(BLOCK)) if (LIST_BLOCKS.has(m[1]) || LIST_BLOCKS.has(`core/${m[1]}`)) return true;
  return false;
}

function parseAttrs(json) {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

const ids = (v) =>
  [].concat(v ?? []).map((x) => (typeof x === "object" && x !== null ? x.id ?? x.value : x)).map(Number).filter(Boolean);

/** Marker the site templates expand into a list of post cards (see src/lib/site.ts). */
function listMarker(attrs, ctx) {
  const cats = ids(attrs.categories).map((id) => ctx.categoryPathById.get(id)).filter(Boolean);
  const tags = ids(attrs.tags).map((id) => ctx.tagSlugById.get(id)).filter(Boolean);
  const specific = ids(attrs.specificPosts).map((id) => ctx.permalinkById.get(id)).filter(Boolean);
  let spec = "*";
  if (attrs.specificMode && specific.length) spec = "paths:" + specific.join("|");
  else if (cats.length === 1) spec = cats[0];
  else if (cats.length > 1) spec = "cats:" + cats.join(",");
  else if (tags.length) spec = "tag:" + tags[0];
  const limit = Number(attrs.postsToShow ?? (spec === "*" ? 6 : 0));
  const esc = (s) => s.replace(/"/g, "&quot;");
  return `<div data-post-list="${esc(spec)}"${limit ? ` data-limit="${limit}"` : ""}></div>`;
}

/** WordPress caches the oEmbed HTML it fetched in postmeta (_oembed_<hash>); reuse it. */
function cachedEmbed(url, item) {
  const key = url.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/$/, "");
  const hit = (item?.meta ?? []).find(
    (m) => m.key.startsWith("_oembed_") && !m.key.startsWith("_oembed_time_") && m.value && m.value !== "{{unknown}}" && m.value.includes(key),
  );
  return hit ? hit.value.replace(/<script[\s\S]*?<\/script>/gi, "") : null;
}

function embedHtml(url, item) {
  url = url.trim();
  const cached = cachedEmbed(url, item);
  if (cached) return cached;
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/);
  if (yt) return `<iframe loading="lazy" width="560" height="315" src="https://www.youtube.com/embed/${yt[1]}" title="YouTube" frameborder="0" allowfullscreen></iframe>`;
  const vimeo = url.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return `<iframe loading="lazy" width="560" height="315" src="https://player.vimeo.com/video/${vimeo[1]}" frameborder="0" allowfullscreen></iframe>`;
  const sp = url.match(/open\.spotify\.com\/(\w+)\/(\w+)/);
  if (sp) return `<iframe loading="lazy" width="100%" height="380" src="https://open.spotify.com/embed/${sp[1]}/${sp[2]}" frameborder="0"></iframe>`;
  if (/(twitter|x)\.com\/.+\/status\//.test(url)) return `<blockquote class="twitter-tweet"><a href="${url}">${url}</a></blockquote>`;
  return `<p><a href="${url}" target="_blank" rel="noopener">${url}</a></p>`;
}

/** Replace the block comments of dynamic blocks; static blocks keep their saved HTML. */
function renderBlocks(content, ctx) {
  // paired embed blocks: <!-- wp:embed {...} --> <figure>…URL…</figure> <!-- /wp:embed -->
  content = content.replace(
    /<!--\s+wp:((?:core-)?embed(?:\/[a-z0-9-]+)?)(\s+\{(?:(?!-->)[\s\S])*?\})?\s+-->([\s\S]*?)<!--\s+\/wp:\1\s+-->/g,
    (all, name, json, inner) => {
      const attrs = parseAttrs(json?.trim());
      const url = attrs.url || (inner.match(/https?:\/\/[^\s<"]+/) || [])[0];
      if (!url) return inner;
      return inner.replace(/(<div class="wp-block-embed__wrapper">)[\s\S]*?(<\/div>)/, `$1${embedHtml(url, ctx.item)}$2`);
    },
  );
  // classic block inside block content
  content = content.replace(/<!--\s+wp:freeform\s+-->([\s\S]*?)<!--\s+\/wp:freeform\s+-->/g, (a, inner) => wpautop(inner));
  content = content.replace(/<!--\s+wp:shortcode\s+-->([\s\S]*?)<!--\s+\/wp:shortcode\s+-->/g, (a, inner) => shortcodes(inner, ctx));
  // self-closing dynamic blocks
  content = content.replace(BLOCK, (all, name, _s, json, selfClosing) => {
    if (!selfClosing) return all;
    if (LIST_BLOCKS.has(name) || LIST_BLOCKS.has(`core/${name}`)) return listMarker(parseAttrs(json), ctx);
    if (name === "block") {
      const ref = parseAttrs(json).ref;
      const reusable = ctx.itemById.get(Number(ref));
      return reusable ? renderBlocks(reusable.content, ctx) : "";
    }
    return ""; // other dynamic blocks (widgets, forms…) have no static fallback
  });
  // drop the remaining (static) block delimiters
  return content.replace(/<!--\s+\/?wp:[\s\S]*?-->/g, "");
}

const BLOCK_TAGS =
  "table|thead|tfoot|caption|col|colgroup|tbody|tr|td|th|div|dl|dd|dt|ul|ol|li|pre|form|map|area|blockquote|address|math|style|p|h[1-6]|hr|fieldset|legend|section|article|aside|hgroup|header|footer|nav|figure|figcaption|details|menu|summary|iframe|object|video|audio";

/** Simplified port of WordPress' wpautop(). */
export function wpautop(text) {
  if (!text.trim()) return "";
  const pre = [];
  text = text.replace(/<pre[\s\S]*?<\/pre>/gi, (m) => `<wp-pre-${pre.push(m) - 1}>`);
  text = text.replace(/\r\n|\r/g, "\n");
  text = text.replace(new RegExp(`(<(?:${BLOCK_TAGS})[\\s/>])`, "gi"), "\n\n$1");
  text = text.replace(new RegExp(`(</(?:${BLOCK_TAGS})>)`, "gi"), "$1\n\n");
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const blockStart = new RegExp(`^</?(?:${BLOCK_TAGS})[\\s/>]`, "i");
  text = paras
    .map((p) => {
      if (blockStart.test(p) || /^<wp-pre-/.test(p)) return p;
      return `<p>${p.replace(/\n/g, "<br />\n")}</p>`;
    })
    .join("\n");
  return text.replace(/<wp-pre-(\d+)>/g, (m, i) => pre[i]);
}

function shortcodes(text, ctx) {
  // [caption id="" align="" width=""]<img …> caption text[/caption]
  text = text.replace(/\[caption[^\]]*\]([\s\S]*?)\[\/caption\]/g, (m, inner) => {
    const img = (inner.match(/<a[^>]*>\s*<img[^>]*>\s*<\/a>|<img[^>]*>/) || [""])[0];
    const cap = inner.replace(img, "").trim();
    return `<figure class="wp-caption">${img}${cap ? `<figcaption>${cap}</figcaption>` : ""}</figure>`;
  });
  text = text.replace(/\[embed[^\]]*\]([\s\S]*?)\[\/embed\]/g, (m, url) => embedHtml(url, ctx.item));
  text = text.replace(/\[gallery[^\]]*ids="([\d,\s]+)"[^\]]*\]/g, (m, list) => {
    const imgs = list
      .split(",")
      .map((id) => ctx.itemById.get(Number(id)))
      .filter((a) => a?.attachment_url)
      .map((a) => `<figure><img src="${a.attachment_url}" alt="" loading="lazy"></figure>`);
    return `<div class="wp-block-gallery">${imgs.join("")}</div>`;
  });
  // shortcodes of plugins that are gone (woocommerce, colibri…) render nothing
  return text.replace(/\[\/?(woocommerce_[a-z_]+|colibri_[a-z_]+|contact-form[^\]]*|gravityform[^\]]*)[^\]]*\]/g, "");
}

/** Standalone URLs on their own line become embeds (WordPress auto-embeds). */
const autoEmbed = (html, item) =>
  html.replace(/^\s*(https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|vimeo\.com|twitter\.com|x\.com|open\.spotify\.com)\/[^\s<]+)\s*$/gm, (m, url) => embedHtml(url, item));

export function localizeUrls(html, baseUrls) {
  for (const base of baseUrls) {
    const host = base.replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/\./g, "\\.");
    // Jetpack Photon CDN copies of this site's uploads
    html = html.replace(new RegExp(`https?://i[0-3]\\.wp\\.com/${host}(/wp-content/[^"'?\\s)]+)(\\?[^"'\\s)]*)?`, "g"), "$1");
    html = html.replace(new RegExp(`https?://(?:www\\.)?${host}(?=/|"|')`, "g"), "");
  }
  return html.replace(/\s(?:srcset|sizes)="[^"]*"/g, "");
}

export function renderContent(item, baseCtx) {
  const ctx = { ...baseCtx, item };
  let html = item.content ?? "";
  if (/<!--\s+wp:/.test(html)) html = renderBlocks(html, ctx);
  else html = wpautop(shortcodes(autoEmbed(html, item), ctx));
  html = shortcodes(html, ctx);
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  return localizeUrls(html, ctx.baseUrls).trim();
}

/**
 * Defence in depth for HTML that reaches the public site: content can come from
 * an imported file, so drop scripts, inline event handlers, javascript: URLs and
 * elements that can redirect or rewrite the page.
 */
export function sanitizeHtml(html) {
  return String(html ?? "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<\/?(?:script|base|meta|link)\b[^>]*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(\s(?:href|src|action|formaction|data|poster|xlink:href)\s*=\s*)(["'])\s*(?:javascript|vbscript|data:text\/html)[^"']*\2/gi, '$1"#"')
    .replace(/(\s(?:href|src|action|formaction|data|poster)\s*=\s*)(?:javascript|vbscript):[^\s>]*/gi, '$1"#"');
}
