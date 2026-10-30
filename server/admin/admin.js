// Octopus admin – single page app (hash routes) over /api.
// Content is WordPress-shaped: block markup is preserved while editing.
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const view = $("#view");
let META = null; // { categories, tags, siteUrl }
let dirty = false;
let editingType = null;

const STATUS = { publish: "פורסם", draft: "טיוטה", pending: "ממתין לאישור", private: "פרטי", trash: "בפח", future: "מתוזמן" };
const REASON = { edit: "עריכה", import: "ייבוא", restore: "שחזור", trash: "העברה לפח", untrash: "שחזור מהפח", upload: "העלאה", menu: "תפריט" };

// ---------- api ----------
async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const headers = { "x-octopus-admin": "1", ...(opts.body && !isForm ? { "content-type": "application/json" } : {}) };
  const res = await fetch(`/api${path}`, { ...opts, headers, body: opts.body && !isForm ? JSON.stringify(opts.body) : opts.body });
  if (res.status === 401) {
    location.href = `/xhost-auth/login?return_to=${encodeURIComponent("/admin/" + location.hash)}`;
    throw new Error("צריך להתחבר מחדש");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `שגיאה ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (isError ? " error" : "");
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = ""), isError ? 7000 : 2500);
}

async function loadMeta(force = false) {
  if (!META || force) META = await api("/meta");
  return META;
}
const catName = (path) => META?.categories.find((c) => c.slug === path)?.name ?? path;
const fmtDate = (d) => {
  if (!d) return "";
  const date = typeof d === "string" && /^\d{4}-\d{2}-\d{2} /.test(d) ? new Date(d.replace(" ", "T")) : new Date(d);
  return isNaN(date) ? "" : date.toLocaleDateString("he-IL", { day: "numeric", month: "short", year: "numeric" });
};
const isImage = (f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f || "");

async function uploadFile(file) {
  const fd = new FormData();
  fd.append("file", file, file.name);
  return api("/upload", { method: "POST", body: fd });
}

function pickFile(accept, onFile, multiple = false) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = multiple;
  input.onchange = () => input.files.length && onFile(multiple ? [...input.files] : input.files[0]).catch((e) => toast(e.message, true));
  input.click();
}

function openDialog(html) {
  const d = $("#dialog");
  $("#dialog-body").innerHTML = html;
  d.showModal();
  d.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => d.close()));
  return d;
}

// ---------- publish status ----------
let pollTimer;
async function refreshStatus() {
  try {
    const s = await api("/status");
    const el = $("#publish-status");
    const btn = $("#publish-btn");
    const last = s.builds[0];
    btn.disabled = s.building;
    if (s.building) el.textContent = "⏳ האתר נבנה מחדש…";
    else if (last?.status === "failed") el.innerHTML = `⚠️ הפרסום האחרון נכשל <a href="#" id="show-log">פרטים</a>`;
    else if (s.pending) el.textContent = `${s.pending} שינויים שעוד לא פורסמו`;
    else el.textContent = last ? `✓ האתר מעודכן (${fmtDate(last.finished_at)})` : "";
    if (s.media?.running) el.textContent += ` · מוריד קבצים ${s.media.done}/${s.media.total}`;
    if (s.mirror?.running) el.textContent += ` · מעתיק מהשרת הישן ${s.mirror.done}/${s.mirror.total}`;
    $("#show-log")?.addEventListener("click", showLog);
    clearTimeout(pollTimer);
    pollTimer = setTimeout(refreshStatus, s.building || s.media?.running || s.mirror?.running ? 3000 : 30000);
    return s;
  } catch (e) {
    console.error(e);
  }
}
async function showLog(e) {
  e?.preventDefault();
  const b = await api("/build-log");
  openDialog(`<h3>יומן הבנייה האחרונה (${esc(b?.status)})</h3><pre class="log">${esc(b?.log || "")}</pre><div class="actions"><button data-close>סגירה</button></div>`);
}
async function publish() {
  await api("/publish", { method: "POST" });
  toast("הפרסום התחיל. האתר יתעדכן תוך דקה-שתיים.");
  setTimeout(refreshStatus, 500);
}
$("#publish-btn").addEventListener("click", () => publish().catch((e) => toast(e.message, true)));

// ---------- router ----------
const routes = {
  "": () => listView("post"),
  pages: () => listView("page"),
  edit: (q) => editView(Number(q.get("id"))),
  new: (q) => editView(null, q.get("type") === "page" ? "page" : "post"),
  media: () => mediaView(),
  categories: () => categoriesView(),
  menu: () => menuView(),
  transfer: () => transferView(),
  users: () => usersView(),
};
async function route() {
  if (window.tinymce) tinymce.remove();
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  const q = new URLSearchParams(query || "");
  const section = path === "edit" || path === "new" ? (q.get("type") === "page" ? "pages" : "posts") : path || "posts";
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === section));
  view.innerHTML = `<p class="muted">טוען…</p>`;
  try {
    await (routes[path] || routes[""])(q);
  } catch (e) {
    view.innerHTML = `<p class="badge deleted">${esc(e.message)}</p>`;
  }
}
window.addEventListener("hashchange", () => {
  if (dirty && !confirm("יש שינויים שלא נשמרו. לצאת בכל זאת?")) {
    history.back();
    return;
  }
  dirty = false;
  route();
});
window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});

// ---------- list ----------
const listState = { post: { q: "", cat: "", status: "", page: 1 }, page: { q: "", cat: "", status: "", page: 1 } };
async function listView(type) {
  await loadMeta();
  const items = await api(`/items?type=${type}`);
  const st = listState[type];
  const isPost = type === "post";
  const count = (s) => items.filter((i) => i.status === s).length;
  view.innerHTML = `
    <div class="toolbar">
      <h1 style="margin:0">${isPost ? "פוסטים" : "עמודים"}</h1>
      <span class="muted">${count("publish")} פורסמו · ${count("draft")} טיוטות${count("private") ? ` · ${count("private")} פרטיים` : ""}${count("pending") ? ` · ${count("pending")} ממתינים` : ""}${count("trash") ? ` · ${count("trash")} בפח` : ""}</span>
      <span class="spacer"></span>
      <a class="button primary" href="#/new?type=${type}">＋ ${isPost ? "פוסט חדש" : "עמוד חדש"}</a>
    </div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="חיפוש לפי כותרת או כתובת…" value="${esc(st.q)}" />
      ${isPost ? `<select id="cat"><option value="">כל הקטגוריות</option>${META.categories.map((c) => `<option value="${esc(c.slug)}" ${c.slug === st.cat ? "selected" : ""}>${esc(c.name)}${c.parent ? ` (${esc(catName(c.parent))})` : ""}</option>`).join("")}</select>` : ""}
      <select id="status">
        <option value="">הכול (חוץ מהפח)</option>
        ${["publish", "draft", "pending", "private"].map((s) => `<option value="${s}" ${st.status === s ? "selected" : ""}>${STATUS[s]}</option>`).join("")}
        <option value="unpublished" ${st.status === "unpublished" ? "selected" : ""}>שינויים שעוד לא פורסמו</option>
        <option value="trash" ${st.status === "trash" ? "selected" : ""}>פח</option>
      </select>
    </div>
    <div id="rows"></div>`;
  const render = () => {
    const q = st.q.trim();
    const rows = items.filter((i) => {
      if (st.status === "trash") return i.status === "trash";
      if (i.status === "trash") return false;
      if (st.status === "unpublished" && !i.pending) return false;
      if (["publish", "draft", "pending", "private"].includes(st.status) && i.status !== st.status) return false;
      if (st.cat && !i.categories.some((c) => c === st.cat || c.startsWith(st.cat + "/"))) return false;
      return !q || (i.title || "").includes(q) || (i.permalink || "").includes(q);
    });
    const per = 50;
    const pages = Math.max(1, Math.ceil(rows.length / per));
    st.page = Math.min(st.page, pages);
    const shown = rows.slice((st.page - 1) * per, st.page * per);
    $("#rows").innerHTML = rows.length
      ? `<table class="list"><thead><tr><th>כותרת</th>${isPost ? "<th>קטגוריות</th>" : ""}<th>תאריך</th><th>עודכן</th></tr></thead><tbody>
        ${shown
          .map(
            (i) => `<tr>
          <td class="title"><a href="#/edit?id=${i.id}&type=${type}">${esc(i.title || "(ללא כותרת)")}</a>
            ${i.status !== "publish" ? `<span class="badge ${i.status === "trash" ? "deleted" : "draft"}">${STATUS[i.status] ?? esc(i.status)}</span>` : ""}
            ${i.pending ? `<span class="badge pending">לא פורסם עדיין</span>` : ""}
            ${i.permalink ? `<small>${esc(i.permalink)}</small>` : ""}</td>
          ${isPost ? `<td>${i.categories.map((c) => esc(catName(c))).join(", ")}</td>` : ""}
          <td class="nowrap">${fmtDate(i.date)}</td>
          <td class="nowrap muted">${i.updatedBy && i.updatedBy !== "system" ? `${fmtDate(i.updatedAt)}<br><small>${esc(i.updatedBy)}</small>` : "—"}</td>
        </tr>`,
          )
          .join("")}</tbody></table>
        ${pages > 1 ? `<div class="pager"><button id="prev" ${st.page === 1 ? "disabled" : ""}>→ הקודם</button><span>עמוד ${st.page} מתוך ${pages} (${rows.length} פריטים)</span><button id="next" ${st.page === pages ? "disabled" : ""}>הבא ←</button></div>` : ""}`
      : `<p class="muted">לא נמצאו פריטים.</p>`;
    $("#prev")?.addEventListener("click", () => { st.page--; render(); });
    $("#next")?.addEventListener("click", () => { st.page++; render(); });
  };
  $("#q").addEventListener("input", (e) => { st.q = e.target.value; st.page = 1; render(); });
  $("#cat")?.addEventListener("change", (e) => { st.cat = e.target.value; st.page = 1; render(); });
  $("#status").addEventListener("change", (e) => { st.status = e.target.value; st.page = 1; render(); });
  render();
}

// ---------- block markup inside the editor ----------
// Self-closing dynamic blocks (<!-- wp:name {...} /-->) have no HTML of their own; while editing
// they are shown as a labelled placeholder and turned back into the exact comment on save.
const LIST_BLOCKS = ["a8c/blog-posts", "a8c/posts-carousel", "latest-posts", "newspack-blocks/homepage-articles", "newspack-blocks/carousel", "uagb/post-grid"];
function blockLabel(name, attrs) {
  if (LIST_BLOCKS.includes(name)) {
    if (attrs.specificMode && attrs.specificPosts?.length) return `📋 רשימה של ${attrs.specificPosts.length} פריטים נבחרים`;
    const ids = [].concat(attrs.categories ?? []).map((x) => Number(typeof x === "object" && x ? x.id : x));
    const names = ids.map((id) => META.categories.find((c) => c.id === id)?.name).filter(Boolean);
    return `📋 רשימת פוסטים אוטומטית: ${names.length ? names.join(", ") : "הפוסטים האחרונים"}${attrs.postsToShow ? ` (עד ${attrs.postsToShow})` : ""}`;
  }
  if (name === "block") return "🧩 בלוק משותף מוורדפרס";
  return `🧩 רכיב וורדפרס: ${name}`;
}
function toEditorHtml(content) {
  return String(content ?? "").replace(/<!--\s+wp:([a-z0-9-]+(?:\/[a-z0-9-]+)?)(\s+(\{(?:(?!-->)[\s\S])*?\}))?\s+\/-->/g, (all, name, _s, json) => {
    let attrs = {};
    try {
      attrs = json ? JSON.parse(json) : {};
    } catch {}
    return `<div class="wp-dyn" contenteditable="false" data-wp-block="${encodeURIComponent(all)}">${esc(blockLabel(name, attrs))}</div>`;
  });
}
const fromEditorHtml = (html) => html.replace(/<div[^>]*data-wp-block="([^"]*)"[^>]*>[\s\S]*?<\/div>/g, (m, enc) => decodeURIComponent(enc));

// ---------- editor ----------
function categoryTree(selected) {
  const cats = META.categories.filter((c) => c.slug !== "uncategorized");
  const kids = (p) => cats.filter((c) => (c.parent ?? null) === p).sort((a, b) => a.name.localeCompare(b.name, "he"));
  const out = [];
  const walk = (p, depth) =>
    kids(p).forEach((c) => {
      out.push(`<label class="${depth === 1 ? "child" : depth >= 2 ? "child2" : ""}"><input type="checkbox" name="cat" value="${esc(c.slug)}" ${selected.includes(c.slug) ? "checked" : ""}/> ${esc(c.name)}</label>`);
      walk(c.slug, depth + 1);
    });
  walk(null, 0);
  return out.join("");
}

async function editView(id, newType) {
  await loadMeta();
  const item = id
    ? await api(`/item?id=${id}`)
    : { id: null, type: newType, status: "draft", title: "", content: "", excerpt: "", date: "", slug: "", categories: [], tags: [], description: "", thumbnailId: null, thumbnailUrl: null, password: "" };
  editingType = item.type;
  const isPost = item.type === "post";
  const origSlug = item.slug;
  view.innerHTML = `
    <div class="toolbar">
      <a href="#/${isPost ? "" : "pages"}">→ חזרה לרשימה</a>
      <span class="spacer"></span>
      ${item.status === "trash" ? `<span class="badge deleted">הפריט בפח</span> <button id="untrash">שחזור מהפח</button>` : ""}
      ${item.permalink && item.status === "publish" ? `<a class="button" href="${esc(item.permalink)}" target="_blank">צפייה באתר ↗</a>` : ""}
    </div>
    <div class="editor">
      <div>
        <div class="field"><input class="title-input" id="title" placeholder="כותרת" value="${esc(item.title)}" /></div>
        <div class="field">
          <label>כתובת <span class="hint">(החלק האחרון של הקישור; אפשר עברית)</span></label>
          <div class="slug-row"><input id="slug" value="${esc(origSlug)}" placeholder="נוצר אוטומטית מהכותרת" /></div>
          <div class="address" id="address">${esc(item.permalink || "")}</div>
        </div>
        <textarea id="body"></textarea>
        <div class="panel" style="margin-top:16px">
          <label for="excerpt">תקציר <span class="hint">(excerpt של וורדפרס; מופיע ברשימות)</span></label>
          <textarea id="excerpt" rows="3">${esc(item.excerpt)}</textarea>
        </div>
      </div>
      <aside class="sticky-actions">
        <div class="panel">
          <div class="field"><label for="status">מצב</label>
            <select id="status">${["publish", "draft", "pending", "private"].map((s) => `<option value="${s}" ${item.status === s ? "selected" : ""}>${STATUS[s]}</option>`).join("")}</select>
          </div>
          <div class="actions">
            <button class="primary" id="save-publish">שמירה ופרסום</button>
            <button id="save">שמירה בלבד</button>
          </div>
          <p class="hint">"שמירה בלבד" שומרת בלי לבנות את האתר מחדש; אפשר לפרסם כמה שינויים יחד בכפתור שלמעלה.</p>
        </div>
        <div class="panel">
          <div class="field"><label for="date">תאריך</label><input type="datetime-local" id="date" value="${esc(item.date)}" /></div>
          <div class="field"><label for="description">תיאור לשיתוף ולמנועי חיפוש</label><textarea id="description" rows="3">${esc(item.description)}</textarea></div>
          <div class="field"><label for="password">סיסמה <span class="hint">(ריק = פתוח לכולם)</span></label><input id="password" value="${esc(item.password)}" /></div>
        </div>
        ${isPost ? `
        <div class="panel">
          <h3>קטגוריות</h3>
          <p class="hint" id="cats-selected"></p>
          <div class="cat-list" id="cats">${categoryTree(item.categories)}</div>
          <p><a href="#" id="new-cat">＋ קטגוריה חדשה</a></p>
        </div>
        <div class="panel">
          <h3>תגיות <span class="hint">(מופרדות בפסיק)</span></h3>
          <input id="tags" list="tag-options" value="${esc(item.tags.join(", "))}" />
          <datalist id="tag-options">${META.tags.slice(0, 3000).map((t) => `<option value="${esc(t.name)}">`).join("")}</datalist>
        </div>` : ""}
        <div class="panel">
          <h3>תמונה ראשית</h3>
          <img id="image-preview" class="image-preview" ${item.thumbnailUrl ? `src="${esc(item.thumbnailUrl)}"` : "hidden"} alt="" />
          <div class="actions" style="margin-top:8px">
            <button id="image-pick">בחירה מהספרייה</button><button id="image-upload">העלאה</button>
            <button id="image-clear" class="danger" ${item.thumbnailId ? "" : "hidden"}>הסרה</button>
          </div>
        </div>
        ${id ? `
        <div class="panel">
          <h3>גרסאות</h3>
          <div class="actions">
            <button id="history">גרסאות קודמות</button>
            ${item.hasImported ? `<button id="revert">חזרה לנוסח המיובא</button>` : ""}
            ${item.status !== "trash" ? `<button id="delete" class="danger">העברה לפח</button>` : ""}
          </div>
        </div>` : ""}
      </aside>
    </div>`;
  $("#body").value = toEditorHtml(item.content);

  let thumbnailId = item.thumbnailId;
  const setThumb = (tid, url) => {
    thumbnailId = tid;
    const img = $("#image-preview");
    img.hidden = !url;
    if (url) img.src = url;
    $("#image-clear").hidden = !tid;
    dirty = true;
  };
  $("#image-clear").addEventListener("click", () => setThumb(null, null));
  $("#image-upload").addEventListener("click", () =>
    pickFile("image/*", async (file) => {
      toast("מעלה…");
      const r = await uploadFile(file);
      setThumb(r.id, r.url);
      toast("התמונה הועלתה");
    }),
  );
  $("#image-pick").addEventListener("click", async () => {
    const a = await mediaPicker({ images: true });
    if (a) setThumb(a.id, a.url);
  });

  const markDirty = () => (dirty = true);
  view.querySelectorAll("input, textarea, select").forEach((el) => el.addEventListener("input", markDirty));
  view.querySelectorAll("input[type=checkbox], select").forEach((el) => el.addEventListener("change", markDirty));
  const showSelectedCats = () => {
    const el = $("#cats-selected");
    if (!el) return;
    const names = [...view.querySelectorAll("input[name=cat]:checked")].map((i) => catName(i.value));
    el.textContent = names.length ? `נבחרו: ${names.join(", ")}` : "לא נבחרה קטגוריה";
  };
  $("#cats")?.addEventListener("change", showSelectedCats);
  showSelectedCats();

  const updateAddress = () => {
    const raw = $("#slug").value.trim() || (!origSlug ? $("#title").value.trim() : "");
    const slug = raw.toLowerCase().replace(/["'״׳`]/g, "").replace(/[^\p{L}\p{N}_]+/gu, "-").replace(/^-+|-+$/g, "");
    if (!slug) return;
    if (isPost) {
      const dt = $("#date").value || new Date().toISOString();
      $("#address").textContent = `/${dt.slice(0, 4)}/${dt.slice(5, 7)}/${dt.slice(8, 10)}/${slug}/`;
    } else $("#address").textContent = `/${slug}/`;
  };
  ["#slug", "#title"].forEach((s) => $(s).addEventListener("input", updateAddress));
  $("#date").addEventListener("change", updateAddress);

  $("#new-cat")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const path = await newCategoryDialog();
    if (!path) return;
    const checked = [...view.querySelectorAll("input[name=cat]:checked")].map((i) => i.value).concat(path);
    $("#cats").innerHTML = categoryTree(checked);
    showSelectedCats();
  });

  await initEditor("#body", markDirty);

  const collect = () => ({
    type: item.type,
    title: $("#title").value,
    status: $("#status").value,
    date: $("#date").value,
    slug: $("#slug").value.trim() !== origSlug ? $("#slug").value.trim() : undefined,
    description: $("#description").value,
    excerpt: $("#excerpt").value,
    password: $("#password").value,
    thumbnailId,
    categories: isPost ? [...view.querySelectorAll("input[name=cat]:checked")].map((i) => i.value) : undefined,
    tags: isPost ? $("#tags").value.split(/[,،]/).map((t) => t.trim()).filter(Boolean) : undefined,
    content: fromEditorHtml(tinymce.get("body").getContent()),
  });

  const save = async (andPublish) => {
    const buttons = view.querySelectorAll("#save, #save-publish");
    buttons.forEach((b) => (b.disabled = true));
    try {
      const payload = collect();
      const r = id ? await api(`/item?id=${id}`, { method: "PUT", body: payload }) : await api("/item", { method: "POST", body: payload });
      dirty = false;
      await loadMeta(true);
      if (andPublish) await publish();
      else toast("נשמר. השינוי יופיע באתר אחרי פרסום.");
      refreshStatus();
      if (!id) location.hash = `#/edit?id=${r.id}&type=${item.type}`;
      else route();
    } catch (e) {
      toast(e.message, true);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  };
  $("#save").addEventListener("click", () => save(false));
  $("#save-publish").addEventListener("click", () => save(true));

  $("#delete")?.addEventListener("click", async () => {
    if (!confirm(`להעביר את "${item.title}" לפח? אפשר לשחזר מהפח בכל עת.`)) return;
    await api(`/item?id=${id}`, { method: "DELETE" });
    dirty = false;
    toast("הועבר לפח. יוסר מהאתר בפרסום הבא.");
    refreshStatus();
    location.hash = isPost ? "#/" : "#/pages";
  });
  $("#untrash")?.addEventListener("click", async () => {
    await api("/untrash", { method: "POST", body: { id } });
    toast("שוחזר מהפח");
    refreshStatus();
    route();
  });
  $("#revert")?.addEventListener("click", async () => {
    if (!confirm("לבטל את כל העריכות ולחזור לנוסח שיובא מוורדפרס?")) return;
    await api("/restore", { method: "POST", body: { id, version: "import" } });
    dirty = false;
    toast("שוחזר הנוסח המיובא");
    refreshStatus();
    route();
  });
  $("#history")?.addEventListener("click", async () => {
    const h = await api(`/history?id=${id}`);
    const dlg = openDialog(`<h3>גרסאות קודמות</h3>
      ${h.length ? `<table class="list"><tbody>${h.map((v) => `<tr><td>${new Date(v.saved_at).toLocaleString("he-IL")}<br><small>${esc(v.saved_by)}</small></td><td>${esc(v.title)}<br><small>${REASON[v.reason] ?? esc(v.reason)} · ${STATUS[v.status] ?? esc(v.status)}</small></td><td><button class="mini" data-restore="${v.id}">שחזור</button></td></tr>`).join("")}</tbody></table>` : `<p class="muted">עוד אין גרסאות שמורות.</p>`}
      <div class="actions" style="margin-top:12px"><button data-close>סגירה</button></div>`);
    dlg.querySelectorAll("[data-restore]").forEach((b) =>
      b.addEventListener("click", async () => {
        await api("/restore", { method: "POST", body: { id, version: b.dataset.restore } });
        dlg.close();
        dirty = false;
        toast("הגרסה שוחזרה");
        refreshStatus();
        route();
      }),
    );
  });
}

async function newCategoryDialog() {
  const roots = META.categories.filter((c) => !c.parent && c.slug !== "uncategorized");
  const dlg = openDialog(`<h3>קטגוריה חדשה</h3>
    <div class="field"><label>שם</label><input id="cat-name" /></div>
    <div class="field"><label>קטגוריית אב <span class="hint">(לא חובה)</span></label>
      <select id="cat-parent"><option value="">— ללא —</option>${roots.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join("")}</select></div>
    <div class="actions"><button class="primary" id="cat-ok">הוספה</button><button data-close>ביטול</button></div>`);
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(null), { once: true });
    $("#cat-ok").addEventListener("click", async () => {
      try {
        const r = await api("/categories", { method: "POST", body: { name: $("#cat-name").value, parent: $("#cat-parent").value || null } });
        await loadMeta(true);
        resolve(r.slug);
        dlg.close();
      } catch (e) {
        toast(e.message, true);
      }
    });
  });
}

/** Choose an attachment from the media library. Resolves { id, url } or null. */
async function mediaPicker({ images = false } = {}) {
  const dlg = openDialog(`<h3>ספריית המדיה</h3>
    <div class="toolbar"><input type="search" id="mp-q" placeholder="חיפוש…" /><button id="mp-upload">העלאה</button></div>
    <div class="media-grid" id="mp-grid" style="max-height:55vh;overflow:auto"></div>
    <div class="actions" style="margin-top:12px"><button data-close>ביטול</button></div>`);
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(null), { once: true });
    const load = async () => {
      const r = await api(`/uploads?limit=120&q=${encodeURIComponent($("#mp-q").value)}`);
      const list = r.items.filter((a) => !images || isImage(a.file));
      $("#mp-grid").innerHTML =
        list
          .map((a) => `<button class="media-item" data-id="${a.id}" data-url="${esc(a.url)}" type="button"><span class="thumb">${isImage(a.file) ? `<img src="${esc(a.url)}" loading="lazy" alt="">` : "📄"}</span><span class="name">${esc(a.title)}</span></button>`)
          .join("") || `<p class="muted">לא נמצאו קבצים.</p>`;
      dlg.querySelectorAll("[data-id]").forEach((b) =>
        b.addEventListener("click", () => {
          resolve({ id: Number(b.dataset.id), url: b.dataset.url });
          dlg.close();
        }),
      );
    };
    $("#mp-q").addEventListener("input", () => {
      clearTimeout(load._t);
      load._t = setTimeout(load, 300);
    });
    $("#mp-upload").addEventListener("click", () =>
      pickFile(images ? "image/*" : "*/*", async (file) => {
        const r = await uploadFile(file);
        resolve({ id: r.id, url: r.url });
        dlg.close();
      }),
    );
    load();
  });
}

async function listPickerDialog() {
  const cats = META.categories.filter((c) => c.slug !== "uncategorized");
  const dlg = openDialog(`<h3>הוספת רשימת פוסטים אוטומטית</h3>
    <p class="hint">נשמר כבלוק "Latest Posts" של וורדפרס, כך שיעבוד גם אם האתר יועבר לוורדפרס.</p>
    <div class="field"><label>קטגוריה</label><select id="lp-cat"><option value="">הפוסטים האחרונים (מכל הקטגוריות)</option>${cats.map((c) => `<option value="${c.id}">${esc(c.name)}${c.parent ? ` (${esc(catName(c.parent))})` : ""}</option>`).join("")}</select></div>
    <div class="field"><label>מספר פריטים</label><input id="lp-limit" type="number" min="1" value="12" /></div>
    <div class="actions"><button class="primary" id="lp-ok">הוספה</button><button data-close>ביטול</button></div>`);
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(null), { once: true });
    $("#lp-ok").addEventListener("click", () => {
      const cat = Number($("#lp-cat").value);
      const attrs = { postsToShow: Number($("#lp-limit").value) || 12, displayFeaturedImage: true, displayPostDate: true, postLayout: "grid", columns: 3 };
      if (cat) attrs.categories = [{ id: cat, value: META.categories.find((c) => c.id === cat)?.name }];
      resolve(toEditorHtml(`<!-- wp:latest-posts ${JSON.stringify(attrs)} /-->`) + "<p></p>");
      dlg.close();
    });
  });
}

async function initEditor(selector, onChange) {
  await tinymce.init({
    selector,
    license_key: "gpl",
    base_url: "/admin/vendor/tinymce",
    suffix: ".min",
    language: "he-IL",
    language_url: "/admin/vendor/tinymce-he.js",
    directionality: "rtl",
    height: 640,
    menubar: false,
    branding: false,
    promotion: false,
    plugins: "link image lists table code media searchreplace fullscreen autolink wordcount",
    toolbar:
      "undo redo | blocks | bold italic underline | alignright aligncenter alignleft | bullist numlist blockquote | link image insertfile media table | postlist | removeformat code fullscreen",
    block_formats: "פסקה=p; כותרת 2=h2; כותרת 3=h3; כותרת 4=h4",
    content_css: "/admin/editor-content.css",
    // keep WordPress markup intact: block delimiters, classes, embeds
    protect: [/<!--\s+\/?wp:[\s\S]*?-->/g],
    valid_elements: "*[*]",
    extended_valid_elements: "*[*]",
    valid_children: "+div[div|p|h2|h3|h4|figure|ul|ol|table|blockquote]",
    noneditable_class: "wp-dyn",
    convert_urls: false,
    entity_encoding: "raw",
    xss_sanitization: true, // strip event handlers / javascript: URLs from pasted or imported markup
    image_caption: true,
    link_default_target: "_blank",
    automatic_uploads: true,
    images_upload_handler: async (blobInfo) => (await uploadFile(new File([blobInfo.blob()], blobInfo.filename()))).url,
    file_picker_types: "file image",
    file_picker_callback: async (callback, value, meta) => {
      const a = await mediaPicker({ images: meta.filetype === "image" });
      if (a) callback(a.url, { text: a.url.split("/").pop(), alt: "" });
    },
    setup(editor) {
      editor.ui.registry.addButton("insertfile", {
        icon: "document-properties",
        tooltip: "צירוף קובץ (PDF, מסמך)",
        onAction: () =>
          pickFile("*/*", async (file) => {
            toast("מעלה…");
            const r = await uploadFile(file);
            editor.insertContent(`<div class="wp-block-file"><a href="${esc(r.url)}">${esc(r.name)}</a><a href="${esc(r.url)}" class="wp-block-file__button" download>הורד</a></div><p></p>`);
            toast("הקובץ צורף");
          }),
      });
      editor.ui.registry.addButton("postlist", {
        text: "רשימת פוסטים",
        tooltip: "הוספת רשימת פוסטים אוטומטית לפי קטגוריה",
        onAction: async () => {
          const html = await listPickerDialog();
          if (html) editor.insertContent(html);
        },
      });
      editor.on("input change undo redo", onChange);
    },
  });
}

// ---------- media ----------
async function mediaView() {
  let offset = 0;
  const per = 60;
  view.innerHTML = `
    <div class="toolbar"><h1 style="margin:0">ספריית המדיה</h1><span class="muted" id="m-total"></span><span class="spacer"></span><input type="search" id="m-q" placeholder="חיפוש…" style="max-width:260px" /></div>
    <div class="dropzone" id="drop">גררו לכאן קבצים, או <button id="pick">בחרו קבצים</button><div class="hint">תמונות, PDF, מסמכים (עד 60MB). הקבצים נשמרים כמו בוורדפרס, בכתובת /wp-content/uploads/</div></div>
    <div class="media-grid" id="grid"></div>
    <div class="pager"><button id="m-prev">→ הקודם</button><span id="m-page"></span><button id="m-next">הבא ←</button></div>`;
  const load = async () => {
    const r = await api(`/uploads?limit=${per}&offset=${offset}&q=${encodeURIComponent($("#m-q").value)}`);
    $("#m-total").textContent = `${r.total} קבצים`;
    $("#m-page").textContent = r.items.length ? `${offset + 1}–${offset + r.items.length}` : "";
    $("#m-prev").disabled = offset === 0;
    $("#m-next").disabled = r.items.length < per;
    $("#grid").innerHTML = r.items
      .map(
        (a) => `<div class="media-item">
        <a class="thumb" href="${esc(a.url)}" target="_blank">${isImage(a.file) ? `<img src="${esc(a.url)}" loading="lazy" alt="">` : "📄"}</a>
        <div class="name">${esc(a.file)}</div>
        <div class="muted">${fmtDate(a.date)}</div>
        <div class="actions"><button class="mini" data-copy="${esc(a.url)}">העתקת קישור</button><button class="mini danger" data-del="${a.id}">מחיקה</button></div>
      </div>`,
      )
      .join("");
    view.querySelectorAll("[data-copy]").forEach((b) =>
      b.addEventListener("click", async () => {
        await navigator.clipboard.writeText(location.origin + b.dataset.copy);
        toast("הקישור הועתק");
      }),
    );
    view.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("למחוק את הקובץ לצמיתות? קישורים אליו יפסיקו לעבוד.")) return;
        await api(`/uploads?id=${b.dataset.del}`, { method: "DELETE" });
        load();
      }),
    );
  };
  const doUpload = async (list) => {
    for (const file of list) {
      toast(`מעלה ${file.name}…`);
      await uploadFile(file);
    }
    toast("ההעלאה הסתיימה");
    offset = 0;
    load();
  };
  $("#pick").addEventListener("click", () => pickFile("*/*", doUpload, true));
  const drop = $("#drop");
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    doUpload([...e.dataTransfer.files]).catch((err) => toast(err.message, true));
  });
  $("#m-q").addEventListener("input", () => {
    clearTimeout(load._t);
    load._t = setTimeout(() => {
      offset = 0;
      load();
    }, 300);
  });
  $("#m-prev").addEventListener("click", () => {
    offset = Math.max(0, offset - per);
    load();
  });
  $("#m-next").addEventListener("click", () => {
    offset += per;
    load();
  });
  load();
}

// ---------- categories ----------
async function categoriesView() {
  await loadMeta(true);
  const items = await api("/items?type=post");
  const count = (slug) => items.filter((i) => i.status === "publish" && i.categories.some((c) => c === slug || c.startsWith(slug + "/"))).length;
  const kids = (p) => META.categories.filter((c) => (c.parent ?? null) === p).sort((a, b) => a.name.localeCompare(b.name, "he"));
  const rows = [];
  const walk = (p, depth) =>
    kids(p).forEach((c) => {
      rows.push(`<tr><td style="padding-right:${12 + depth * 22}px"><input value="${esc(c.name)}" data-id="${c.id}" /></td>
        <td class="nowrap"><a href="/category/${esc(c.slug)}/" target="_blank" dir="ltr">${esc(c.slug)}</a></td><td>${count(c.slug)}</td></tr>`);
      walk(c.slug, depth + 1);
    });
  walk(null, 0);
  view.innerHTML = `
    <div class="toolbar"><h1 style="margin:0">קטגוריות</h1><span class="spacer"></span><button class="primary" id="add">＋ קטגוריה חדשה</button></div>
    <p class="hint">אפשר לשנות שם של קטגוריה (הכתובת נשארת). השינוי נכנס לאתר בפרסום הבא.</p>
    <table class="list"><thead><tr><th>שם</th><th>כתובת</th><th>פוסטים שפורסמו</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  $("#add").addEventListener("click", async () => {
    if (await newCategoryDialog()) {
      toast("הקטגוריה נוספה");
      categoriesView();
    }
  });
  view.querySelectorAll("input[data-id]").forEach((inp) =>
    inp.addEventListener("change", async () => {
      try {
        await api("/categories", { method: "POST", body: { id: Number(inp.dataset.id), name: inp.value } });
        toast("השם עודכן");
        refreshStatus();
      } catch (e) {
        toast(e.message, true);
      }
    }),
  );
}

// ---------- menu ----------
async function menuView() {
  const data = await api("/menu");
  const tree = structuredClone(data.tree);
  const render = () => {
    const row = (m, path) => `<div class="menu-row" data-path="${path}">
      <input name="label" value="${esc(m.label)}" placeholder="שם" />
      <input name="href" value="${esc(m.href)}" placeholder="/כתובת/" />
      <span class="actions"><button class="mini" data-act="up" title="למעלה">▲</button><button class="mini" data-act="down" title="למטה">▼</button><button class="mini danger" data-act="del" title="הסרה">✕</button></span></div>`;
    view.innerHTML = `
      <div class="toolbar"><h1 style="margin:0">התפריט העליון</h1>${data.menu ? `<span class="muted">(תפריט וורדפרס: ${esc(data.menu.name)})</span>` : ""}<span class="spacer"></span><button class="primary" id="save-menu">שמירת התפריט</button></div>
      <p class="hint">כתובות פנימיות מתחילות ב-/ (למשל <span dir="ltr">/about/</span>). קישור לעמוד, לפוסט או לקטגוריה נשמר כקישור וורדפרסי אליהם. השינוי נכנס לאתר בפרסום הבא.</p>
      ${tree
        .map(
          (m, i) => `<div class="menu-item">${row(m, i)}
          <div class="menu-children">${(m.children || []).map((c, j) => row(c, `${i}.${j}`)).join("")}
          <button class="mini" data-add-child="${i}">＋ פריט משנה</button></div></div>`,
        )
        .join("")}
      <button id="add-top">＋ פריט ראשי</button>`;
    const get = (path) => {
      const [i, j] = String(path).split(".").map(Number);
      return j === undefined ? { list: tree, idx: i } : { list: tree[i].children, idx: j };
    };
    view.querySelectorAll(".menu-row").forEach((r) => {
      const { list, idx } = get(r.dataset.path);
      r.querySelectorAll("input").forEach((inp) =>
        inp.addEventListener("input", () => {
          list[idx][inp.name] = inp.value;
          dirty = true;
        }),
      );
      r.querySelectorAll("[data-act]").forEach((b) =>
        b.addEventListener("click", () => {
          const act = b.dataset.act;
          if (act === "del" && confirm("להסיר את הפריט?")) list.splice(idx, 1);
          if (act === "up" && idx > 0) [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
          if (act === "down" && idx < list.length - 1) [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
          dirty = true;
          render();
        }),
      );
    });
    view.querySelectorAll("[data-add-child]").forEach((b) =>
      b.addEventListener("click", () => {
        (tree[b.dataset.addChild].children ||= []).push({ label: "", href: "/" });
        render();
      }),
    );
    $("#add-top").addEventListener("click", () => {
      tree.push({ label: "", href: "/", children: [] });
      render();
    });
    $("#save-menu").addEventListener("click", async () => {
      try {
        const clean = tree.filter((m) => m.label && m.href).map((m) => ({ ...m, children: (m.children || []).filter((c) => c.label && c.href) }));
        await api("/menu", { method: "PUT", body: { tree: clean } });
        dirty = false;
        toast("התפריט נשמר. יופיע באתר אחרי פרסום.");
        refreshStatus();
      } catch (e) {
        toast(e.message, true);
      }
    });
  };
  render();
}

// ---------- import / export ----------
const TYPE_NAMES = { post: "פוסטים", page: "עמודים", attachment: "קבצי מדיה", nav_menu_item: "פריטי תפריט", feedback: "פניות מטופס", custom_css: "CSS", wp_global_styles: "עיצוב", wp_block: "בלוקים משותפים" };
const countsText = (obj) =>
  Object.entries(obj ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${Number(v)} ${esc(TYPE_NAMES[k] ?? k)}`)
    .join(" · ") || "אין";

async function transferView() {
  const [backups, status, mir] = await Promise.all([api("/backups"), api("/status"), api("/uploads-mirror")]);
  const m = status.media;
  const last = mir.running ? mir : mir.last;
  view.innerHTML = `
    <h1>ייבוא וייצוא (וורדפרס)</h1>
    <div class="panel">
      <h3>ייצוא</h3>
      <p>קובץ WXR בפורמט של "כלים ← ייצוא" בוורדפרס: כל הפוסטים והעמודים (כולל טיוטות ופרטיים), קבצי המדיה, קטגוריות, תגיות, תפריטים ומטא-דאטה.
      אפשר לייבא אותו לכל אתר וורדפרס דרך "כלים ← ייבוא ← WordPress". הקבצים עצמם יורדו מהאתר הזה בזמן הייבוא.</p>
      <a class="button primary" href="/api/export">⬇ הורדת קובץ ייצוא</a>
    </div>
    <div class="panel">
      <h3>ייבוא</h3>
      <div class="field"><label>קובץ ייצוא של וורדפרס (XML), או קובץ ZIP עם קובץ XML והקבצים שלו בתיקייה wp-content/uploads/</label><input type="file" id="imp-file" accept=".xml,.zip,application/xml,text/xml,application/zip" /></div>
      <div class="field">
        <label class="checkbox"><input type="radio" name="mode" value="append" checked /> <span><b>הוספה (APPEND)</b> – רק מה שעוד לא קיים באתר מתווסף. שום דבר קיים לא משתנה.</span></label>
        <label class="checkbox"><input type="radio" name="mode" value="replace" /> <span><b>החלפה (REPLACE)</b> – כל התוכן באתר מוחלף בתוכן הקובץ. לפני ההחלפה נשמר גיבוי מלא.</span></label>
      </div>
      <label class="checkbox"><input type="checkbox" id="imp-media" checked /> להוריד את קבצי המדיה מהאתר המקורי</label>
      <div class="actions" style="margin-top:10px"><button class="primary" id="imp-check">בדיקת הקובץ</button></div>
      <div id="imp-result"></div>
    </div>
    <div class="panel">
      <h3>קבצי מדיה</h3>
      <p id="media-state">${m?.running ? `מוריד… ${m.done}/${m.total}` : m?.finishedAt ? `בדיקה אחרונה: ${m.total} קבצים, הורדו ${m.downloaded}, נכשלו ${m.failed.length}` : "בודק שכל קובץ שמופיע בנתונים קיים בשרת, ומוריד חסרים מהאתר המקורי."}</p>
      <div class="actions"><button id="media-sync">בדיקה והורדת קבצים חסרים</button>${m?.failed?.length ? `<button id="media-failed">הצגת כשלונות</button>` : ""}</div>
    </div>
    <div class="panel">
      <h3>העתקת תיקיית הקבצים מהשרת הישן</h3>
      <p>כל הקבצים שהיו בתיקיית ההעלאות של וורדפרס (<span dir="ltr">${esc(mir.source)}/wp-content/uploads/</span>), כולל הגדלים שוורדפרס יצר לכל תמונה, מועתקים לאחסון של האתר הזה.</p>
      <p id="mirror-state">${
        mir.running
          ? `מעתיק… ${mir.done}/${mir.total} (הועתקו ${mir.copied}, ${(mir.bytes / 1e6).toFixed(0)}MB)`
          : last?.finishedAt
            ? `הושלם ${new Date(last.finishedAt).toLocaleString("he-IL")}: ${last.total} קבצים – ${last.present + last.copied} נמצאים באחסון, ${last.failed?.length ?? 0} נכשלו`
            : "עוד לא הופעל."
      }</p>
      <div class="actions"><button id="mirror-run" ${mir.running ? "disabled" : ""}>העתקה / השלמת קבצים חסרים</button>${last?.failed?.length ? `<button id="mirror-failed">הצגת כשלונות</button>` : ""}</div>
    </div>
    <div class="panel">
      <h3>גיבויים אוטומטיים</h3>
      ${backups.length ? `<ul>${backups.map((b) => `<li><a href="/api/backup?key=${encodeURIComponent(b.key)}">${esc(b.key.split("/").pop())}</a> <span class="muted">(${new Date(b.at).toLocaleString("he-IL")}, ${esc(b.by)})</span></li>`).join("")}</ul>` : `<p class="muted">עוד אין. גיבוי נשמר לפני כל ייבוא מסוג החלפה.</p>`}
    </div>`;

  $("#media-sync").addEventListener("click", async () => {
    await api("/media-sync", { method: "POST" });
    toast("הבדיקה התחילה");
    refreshStatus();
    setTimeout(transferView, 1500);
  });
  $("#mirror-run").addEventListener("click", async () => {
    await api("/uploads-mirror", { method: "POST" });
    toast("ההעתקה התחילה");
    refreshStatus();
    setTimeout(transferView, 1500);
  });
  $("#mirror-failed")?.addEventListener("click", () =>
    openDialog(`<h3>קבצים שלא הועתקו</h3><pre class="log">${esc(last.failed.map((f) => `${f.file}  –  ${f.error}`).join("\n"))}</pre><div class="actions"><button data-close>סגירה</button></div>`),
  );
  $("#media-failed")?.addEventListener("click", () =>
    openDialog(`<h3>קבצים שלא הורדו</h3><pre class="log">${esc(m.failed.map((f) => `${f.file}  –  ${f.error}`).join("\n"))}</pre><div class="actions"><button data-close>סגירה</button></div>`),
  );

  $("#imp-check").addEventListener("click", async () => {
    const file = $("#imp-file").files[0];
    if (!file) return toast("בחרו קובץ", true);
    const mode = view.querySelector("input[name=mode]:checked").value;
    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("mode", mode);
    $("#imp-result").innerHTML = `<p class="muted">בודק את הקובץ…</p>`;
    try {
      const { token, plan, title, files } = await api("/import/preview", { method: "POST", body: fd });
      $("#imp-result").innerHTML = `
        <div class="panel" style="margin-top:12px;background:#faf8fb">
          <p><b>${esc(title)}</b> ${plan.source ? `<span class="muted" dir="ltr">(${esc(plan.source)})</span>` : ""}</p>
          ${
            mode === "replace"
              ? `<p>יימחקו: ${countsText(plan.remove)}</p><p>ייובאו: ${countsText(plan.add)} · ${plan.terms} קטגוריות ותגיות</p>
               <p class="badge deleted">כל התוכן הנוכחי יוחלף. גיבוי מלא יישמר קודם.</p>
               <div class="field"><label>להמשך הקלידו: החלפה</label><input id="imp-confirm" /></div>`
              : `<p>יתווספו: ${countsText(plan.add)}${plan.terms ? ` · ${plan.terms} קטגוריות/תגיות חדשות` : ""}</p><p class="muted">כבר קיימים ולא ישתנו: ${countsText(plan.skip)}</p>`
          }
          ${files ? `<p>יועלו ${Number(files)} קבצים מתוך ה-ZIP.</p>` : ""}
          ${plan.foreign ? `<p class="hint">הקובץ מאתר אחר: קישורי המדיה שלו יועברו לאתר הזה והקבצים יורדו מהאתר המקורי.</p>` : ""}
          <div class="actions"><button class="primary" id="imp-run">ביצוע הייבוא</button></div>
        </div>`;
      $("#imp-run").addEventListener("click", async () => {
        if (mode === "replace" && $("#imp-confirm").value.trim() !== "החלפה") return toast('יש להקליד "החלפה" לאישור', true);
        $("#imp-run").disabled = true;
        try {
          const r = await api("/import/run", { method: "POST", body: { token, mode, downloadMedia: $("#imp-media").checked } });
          toast(`הייבוא הסתיים: נוספו ${r.added} פריטים. האתר נבנה מחדש.`);
          META = null;
          refreshStatus();
          transferView();
        } catch (e) {
          toast(e.message, true);
          $("#imp-run").disabled = false;
        }
      });
    } catch (e) {
      $("#imp-result").innerHTML = `<p class="badge deleted">${esc(e.message)}</p>`;
    }
  });
}

// ---------- editors ----------
async function usersView() {
  const { fixed, editors } = await api("/editors");
  view.innerHTML = `
    <h1>עורכים</h1>
    <p class="hint">מי שמופיע כאן יכול להתחבר עם חשבון Google שלו ולערוך את האתר.</p>
    <table class="list"><tbody>
      ${fixed.map((e) => `<tr><td dir="ltr" style="text-align:right">${esc(e)}</td><td class="muted">מנהל קבוע</td><td></td></tr>`).join("")}
      ${editors.map((e) => `<tr><td dir="ltr" style="text-align:right">${esc(e.email)}</td><td class="muted">נוסף ${fmtDate(e.added_at)} ע"י ${esc(e.added_by || "")}</td><td><button class="mini danger" data-del="${esc(e.email)}">הסרה</button></td></tr>`).join("")}
    </tbody></table>
    <div class="toolbar" style="margin-top:14px"><input id="email" type="email" dir="ltr" placeholder="name@gmail.com" style="max-width:320px" /><button class="primary" id="add">הוספת עורך</button></div>`;
  $("#add").addEventListener("click", async () => {
    try {
      await api("/editors", { method: "POST", body: { email: $("#email").value } });
      toast("העורך נוסף");
      usersView();
    } catch (e) {
      toast(e.message, true);
    }
  });
  view.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm(`להסיר את ${b.dataset.del}?`)) return;
      await api(`/editors?email=${encodeURIComponent(b.dataset.del)}`, { method: "DELETE" });
      usersView();
    }),
  );
}

// ---------- boot ----------
api("/me").then((me) => ($("#me").textContent = me.email));
refreshStatus();
route();
