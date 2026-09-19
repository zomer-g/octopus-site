"""Scrape octopus.org.il (WordPress) into raw JSON records.

Sources: Yoast sitemaps (post/page). For each URL, the rendered HTML is saved
to archive/html/ and a parsed record to archive/items/<id>.json.
Re-running skips URLs that already have a record.
"""
import json, re, sys, time, hashlib, html as htmllib
from pathlib import Path
from urllib.parse import unquote, urlparse
import requests
from bs4 import BeautifulSoup

BASE = "https://octopus.org.il"
ROOT = Path(__file__).resolve().parent.parent / "archive"
HTML_DIR, ITEM_DIR = ROOT / "html", ROOT / "items"
for d in (HTML_DIR, ITEM_DIR):
    d.mkdir(parents=True, exist_ok=True)

S = requests.Session()
S.headers["User-Agent"] = "Mozilla/5.0 (octopus archive migration)"


def get(url, **kw):
    for attempt in range(4):
        try:
            r = S.get(url, timeout=60, **kw)
            if r.status_code in (429, 503):
                time.sleep(10 * (attempt + 1)); continue
            return r
        except requests.RequestException as e:
            print("  retry", url, e); time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"failed {url}")


def sitemap(kind):
    x = get(f"{BASE}/{kind}-sitemap.xml").text
    return re.findall(r"<loc>([^<]+)</loc>", x)


def taxo(soup, rel):
    out = []
    for a in soup.select(f'a[rel~="{rel}"]'):
        if rel == "tag" and "category" in a.get("rel", []):
            continue
        href = a.get("href", "")
        m = re.search(r"/(category|tag)/(.+?)/?$", urlparse(href).path)
        item = {"name": a.get_text(strip=True), "slug": unquote(m.group(2)) if m else ""}
        if item not in out:
            out.append(item)
    return out


def parse(url, kind, h):
    soup = BeautifulSoup(h, "lxml")
    art = soup.find("article") or soup
    main = art.select_one(".card-single-article") or art
    body_cls = " ".join(soup.body.get("class", [])) if soup.body else ""
    m = re.search(r"(?:postid|page-id)-(\d+)", body_cls)
    wp_id = int(m.group(1)) if m else None
    title_el = main.find(["h1"]) or soup.find("h1")
    content = main.select_one(".entry-content")
    pub = main.select_one("time.entry-date.published") or art.select_one("time.published")
    upd = main.select_one("time.updated")
    meta = lambda p: (soup.find("meta", attrs={"property": p}) or {}).get("content")
    desc = (soup.find("meta", attrs={"name": "description"}) or {}).get("content")
    # related-post cards also live inside <article>; only read the main card
    feat = main.select_one(":scope > figure img, :scope > .card_media img, .post-thumbnail img")
    cats = taxo(main.select_one(".fairy-metas") or main, "category") if kind == "post" else []
    tags = taxo(main.select_one(".entry-meta-footer") or main, "tag") if kind == "post" else []
    path = unquote(urlparse(url).path)
    return {
        "id": wp_id,
        "type": kind,
        "url": url,
        "path": path,
        "title": htmllib.unescape(title_el.get_text(" ", strip=True)) if title_el else "",
        "date": pub["datetime"] if pub else meta("article:published_time"),
        "modified": upd["datetime"] if upd else meta("article:modified_time"),
        "description": desc or meta("og:description"),
        "og_image": meta("og:image"),
        "featured_image": (feat.get("data-orig-file") or feat.get("src")) if feat else None,
        "categories": cats,
        "tags": tags,
        "content_html": content.decode_contents() if content else None,
        "content_missing": content is None,
    }


def main():
    delay = float(sys.argv[1]) if len(sys.argv) > 1 else 1.5
    urls = [(u, "page") for u in sitemap("page")] + [(u, "post") for u in sitemap("post")]
    json.dump(urls, open(ROOT / "urls.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(len(urls), "urls")
    for i, (u, kind) in enumerate(urls, 1):
        key = hashlib.sha1(u.encode()).hexdigest()[:12]
        hf = HTML_DIR / f"{key}.html"
        done = ITEM_DIR / f"{key}.json"
        if done.exists():
            continue
        if hf.exists():
            h = hf.read_text(encoding="utf-8")
        else:
            r = get(u)
            if r.status_code != 200:
                print(f"[{i}] {r.status_code} {unquote(u)}"); continue
            h = r.text
            hf.write_text(h, encoding="utf-8")
            time.sleep(delay)
        rec = parse(u, kind, h)
        rec["key"] = key
        done.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"[{i}/{len(urls)}] {kind} {rec['title'][:60]}", flush=True)


if __name__ == "__main__":
    main()
