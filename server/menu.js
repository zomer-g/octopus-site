// The main menu, edited in /admin as a simple tree and stored the way
// WordPress stores menus: a nav_menu term plus nav_menu_item posts.
import { buildMenu, primaryMenu, wpSlug, safeHref } from "./generate.js";
import * as store from "./store.js";

export function buildMenuTree(site, idx, opts) {
  const menu = primaryMenu(site, opts);
  const tree = buildMenu(site, idx, opts).map(({ label, href, children }) => ({
    label,
    href,
    children: (children ?? []).map(({ label, href }) => ({ label, href })),
  }));
  return { menu: menu && { slug: menu.slug, name: menu.name }, tree };
}

export async function saveMenuTree(site, idx, opts, tree, by, siteUrl) {
  const nodes = Array.isArray(tree) ? tree.flatMap((n) => [n, ...(Array.isArray(n?.children) ? n.children : [])]) : null;
  if (!nodes || !nodes.every((n) => n && typeof n.label === "string" && n.label && typeof n.href === "string" && n.href))
    throw Object.assign(new Error("מבנה תפריט לא תקין"), { status: 400 });
  const bad = nodes.find((n) => safeHref(n.href) !== n.href.trim());
  if (bad) throw Object.assign(new Error(`קישור לא מותר בתפריט: ${bad.href}`), { status: 400 });

  let menu = primaryMenu(site, opts);
  if (!menu) {
    menu = { term_id: await store.nextId("terms"), taxonomy: "nav_menu", slug: wpSlug("תפריט ראשי"), parent: "", name: "תפריט ראשי", description: "", meta: [] };
    await store.saveTerm(menu);
  }
  // replace the menu's items
  for (const i of site.items)
    if (i.post_type === "nav_menu_item" && i.terms.some((t) => t.domain === "nav_menu" && t.nicename === menu.slug)) await store.deleteItem(i.post_id);

  const byPermalink = new Map([...idx.permalinkById].map(([id, p]) => [p, id]));
  const byCatPath = new Map([...idx.categoryPathBySlug].map(([slug, path]) => [`/category/${path}/`, idx.catBySlug.get(slug)]));
  const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace("T", " ");
  let nextId = await store.nextId();
  let order = 1;

  const save = async (node, parentId) => {
    const id = nextId++;
    const href = String(node.href).trim();
    const postId = byPermalink.get(href);
    const cat = byCatPath.get(href);
    const target = postId ? site.items.find((i) => i.post_id === postId) : null;
    const [type, object, objectId, url] = target
      ? ["post_type", target.post_type, String(postId), ""]
      : cat
        ? ["taxonomy", "category", String(cat.term_id), ""]
        : ["custom", "custom", String(id), href];
    await store.saveItem(
      {
        post_id: id, post_type: "nav_menu_item", status: "publish", title: node.label, link: "", pubDate: now.toUTCString().replace("GMT", "+0000"),
        creator: "", guid: `${siteUrl}/?p=${id}`, guid_is_permalink: "false", description: "", content: "", excerpt: "",
        post_date: stamp, post_date_gmt: stamp, post_modified: stamp, post_modified_gmt: stamp,
        comment_status: "closed", ping_status: "closed", post_name: String(id), post_parent: 0, menu_order: order++,
        post_password: "", is_sticky: 0, comments: [],
        terms: [{ domain: "nav_menu", nicename: menu.slug, name: menu.name }],
        meta: [
          { key: "_menu_item_type", value: type },
          { key: "_menu_item_menu_item_parent", value: String(parentId || 0) },
          { key: "_menu_item_object_id", value: objectId },
          { key: "_menu_item_object", value: object },
          { key: "_menu_item_target", value: "" },
          { key: "_menu_item_classes", value: 'a:1:{i:0;s:0:"";}' },
          { key: "_menu_item_xfn", value: "" },
          { key: "_menu_item_url", value: url },
        ],
      },
      by,
      "menu",
    );
    return id;
  };
  for (const node of tree) {
    const id = await save(node, 0);
    for (const child of node.children ?? []) await save(child, id);
  }
}
