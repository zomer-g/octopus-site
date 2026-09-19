"""Map every file under the old WordPress site's /wp-content/uploads/ using its
Apache directory listing. Writes archive/uploads-manifest.json:
  [{"path": "2021/01/x.png", "size": 12345, "modified": "2021-01-05 10:22"}, ...]
Sizes come from a HEAD request per file (the listing only shows rounded sizes).
"""
import json, re, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import unquote, urljoin, quote
import requests

BASE = "https://octopus.org.il/wp-content/uploads/"
OUT = Path(__file__).resolve().parent.parent / "archive/uploads-manifest.json"
S = requests.Session()
S.headers["User-Agent"] = "Mozilla/5.0 (octopus archive migration)"
ROW = re.compile(r'<a href="([^"?][^"]*)">[^<]*</a>\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+(\S+)')


def listing(url):
    for attempt in range(4):
        try:
            r = S.get(url, timeout=60)
            if r.status_code == 200:
                return r.text
            if r.status_code == 404:
                return ""
        except requests.RequestException:
            pass
        time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"failed {url}")


def crawl(url, rel=""):
    files = []
    for href, modified, size in ROW.findall(listing(url)):
        if href.startswith("/") or href.startswith(".."):
            continue
        name = unquote(href)
        if href.endswith("/"):
            files += crawl(urljoin(url, href), rel + name)
        else:
            files.append({"path": rel + name, "modified": modified, "listed_size": size})
    return files


def head_size(f):
    url = BASE + quote(f["path"])
    for attempt in range(3):
        try:
            r = S.head(url, timeout=60, allow_redirects=True)
            f["size"] = int(r.headers.get("content-length", 0)) if r.status_code == 200 else None
            f["status"] = r.status_code
            return f
        except requests.RequestException:
            time.sleep(2)
    f["size"], f["status"] = None, 0
    return f


if __name__ == "__main__":
    files = crawl(BASE)
    print(len(files), "files listed", flush=True)
    with ThreadPoolExecutor(8) as ex:
        files = list(ex.map(head_size, files))
    files.sort(key=lambda f: f["path"])
    for f in files:
        f.pop("listed_size", None)
    OUT.write_text(json.dumps(files, ensure_ascii=False, indent=0), encoding="utf-8")
    total = sum(f["size"] or 0 for f in files)
    print(f"{len(files)} files, {total / 1e6:.0f} MB, not-200: {sum(1 for f in files if f['status'] != 200)}")
