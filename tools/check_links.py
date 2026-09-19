"""Check every internal href/src in dist/ resolves to a built file."""
import re, sys
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import unquote, urlparse

DIST = Path(__file__).resolve().parent.parent / "dist"
ATTR = re.compile(r'(?:href|src|data)="([^"]+)"')


def exists(path):
    p = DIST / unquote(path).lstrip("/")
    if p.is_file():
        return True
    return (p / "index.html").is_file()


missing = defaultdict(set)
for f in DIST.rglob("*.html"):
    page = "/" + f.relative_to(DIST).as_posix().removesuffix("index.html")
    for url in ATTR.findall(f.read_text(encoding="utf-8")):
        url = url.replace("&amp;", "&")
        u = urlparse(url)
        if u.scheme or url.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue
        if not u.path.startswith("/"):
            continue
        target = u.path + ("?" + u.query if u.query else "")
        if u.query and u.path == "/":
            missing[target].add(page); continue
        if not exists(u.path):
            missing[target].add(page)

print(len(missing), "missing targets")
for t, pages in sorted(missing.items(), key=lambda x: -len(x[1])):
    print(f"{len(pages):3d}  {unquote(t)}   <- {sorted(pages)[0]}")
