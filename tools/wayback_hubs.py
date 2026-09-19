"""Recover the post lists that the removed Newspack "homepage articles" block
used to render on hub pages, using Wayback Machine snapshots.

Output: archive/hubs.json  {page_path: {snapshot, sections: [{heading, posts: [path...]}]}}
"""
import json, re, time, sys
from pathlib import Path
from urllib.parse import unquote, urlparse
import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent / "archive"
OUT = ROOT / "hubs.json"
S = requests.Session()
S.headers["User-Agent"] = "Mozilla/5.0 (octopus archive migration)"


def get(url, timeout=90):
    for a in range(4):
        try:
            r = S.get(url, timeout=timeout)
            if r.status_code == 200:
                return r
            if r.status_code in (404,):
                return None
        except requests.RequestException:
            pass
        time.sleep(5 * (a + 1))
    return None


def snapshots(path):
    r = get(f"https://web.archive.org/cdx/search/cdx?url=octopus.org.il{path}&output=json"
            f"&filter=statuscode:200&fl=timestamp&collapse=timestamp:6&from=2021&to=20230520")
    if not r:
        return []
    rows = r.json()[1:]
    return [x[0] for x in rows][::-1]  # newest first


def post_path(href):
    p = unquote(urlparse(href).path)
    p = re.sub(r"^/web/\d+[a-z_]*/https?://octopus\.org\.il", "", p)
    return p if re.match(r"^/\d{4}/\d{2}/\d{2}/", p) else None


def sections(h):
    s = BeautifulSoup(h, "lxml")
    c = s.select_one(".entry-content")
    if not c:
        return []
    out, heading = [], None
    for el in c.find_all(recursive=False):
        if el.name in ("h1", "h2", "h3", "h4"):
            heading = el.get_text(" ", strip=True)
        blocks = [el] if "wpnbha" in (el.get("class") or []) else el.select(".wpnbha")
        for b in blocks:
            posts = []
            for art in b.select("article"):
                a = art.select_one(".entry-title a") or art.select_one("a[href]")
                p = post_path(a["href"]) if a else None
                if p and p not in posts:
                    posts.append(p)
            out.append({"heading": heading, "block_class": " ".join(b.get("class", [])), "posts": posts})
    return out


def main():
    pages = json.load(open(ROOT / "urls.json", encoding="utf-8"))
    paths = [unquote(urlparse(u).path) for u, k in pages if k == "page"]
    res = json.load(open(OUT, encoding="utf-8")) if OUT.exists() else {}
    for p in paths:
        if p in res:
            continue
        found = None
        for ts in snapshots(p)[:6]:
            r = get(f"https://web.archive.org/web/{ts}id_/https://octopus.org.il{p}")
            time.sleep(1)
            if not r:
                continue
            secs = sections(r.text)
            if secs:
                found = {"snapshot": ts, "sections": secs}
                break
        res[p] = found
        print(p, "->", found and (found["snapshot"], [(s["heading"], len(s["posts"])) for s in found["sections"]]), flush=True)
        json.dump(res, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
