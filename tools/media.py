"""Download every wp-content/uploads file referenced by scraped items into
public/wp-content/uploads (same paths, so rewritten links stay /wp-content/...)."""
import json, glob, re, time
from pathlib import Path
from urllib.parse import unquote, quote
import requests

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "public"
S = requests.Session()
S.headers["User-Agent"] = "Mozilla/5.0 (octopus archive migration)"
PAT = re.compile(r"(?:(?:https?:)?//(?:i[0-3]\.wp\.com/)?(?:www\.)?octopus\.org\.il|(?<=[\"'=]))(/wp-content/uploads/[^\"'\s?)<>#,]+)")


def referenced():
    out = set()
    for f in glob.glob(str(ROOT / "archive/items/*.json")):
        r = json.load(open(f, encoding="utf-8"))
        blob = " ".join(str(r.get(k) or "") for k in ("content_html", "featured_image", "og_image"))
        out.update(unquote(m) for m in PAT.findall(blob))
    return sorted(out)


def main():
    paths = referenced()
    print(len(paths), "files")
    failed = []
    for i, p in enumerate(paths, 1):
        target = DEST / p.lstrip("/")
        if target.exists() and target.stat().st_size > 0:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        url = "https://octopus.org.il" + quote(p)
        try:
            r = S.get(url, timeout=120)
        except requests.RequestException as e:
            failed.append((p, str(e))); continue
        if r.status_code != 200:
            failed.append((p, r.status_code)); print(f"[{i}] {r.status_code} {p}"); continue
        target.write_bytes(r.content)
        print(f"[{i}/{len(paths)}] {len(r.content)//1024}KB {p}", flush=True)
        time.sleep(0.3)
    json.dump(failed, open(ROOT / "archive/media_failed.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("failed:", len(failed))


if __name__ == "__main__":
    main()
