#!/usr/bin/env bash
# Publish the current commit to the PUBLIC repository, without private data.
# The public repo has its own history, so private files never appear in it.
#   bash tools/publish-public.sh "message"
set -euo pipefail
cd "$(dirname "$0")/.."
REMOTE="${PUBLIC_REMOTE:-https://github.com/zomer-g/octopus-site.git}"
OUT=".public-repo"
# never published: the full WordPress export (drafts, private posts, contact-form
# entries, e-mail addresses, IPs). The public export is used in its place.
PRIVATE=("archive/wxr/octopus-2026-09-19.xml")

if [ -n "$(git status --porcelain)" ]; then echo "commit your changes first" >&2; exit 1; fi
if [ ! -d "$OUT/.git" ]; then
  git init -q -b main "$OUT"
  git -C "$OUT" remote add origin "$REMOTE"
  git -C "$OUT" fetch -q origin main 2>/dev/null && git -C "$OUT" reset -q origin/main || true
fi
find "$OUT" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git archive HEAD | tar -x -C "$OUT"
for f in "${PRIVATE[@]}"; do rm -f "$OUT/$f"; done

# last line of defence: every WXR file in the public tree must hold public data only
for f in "$OUT"/archive/wxr/*.xml; do
  if grep -qE '<wp:post_type><!\[CDATA\[feedback|<wp:author_email><!\[CDATA\[[^]]|<wp:comment_author_IP><!\[CDATA\[[^]]|<wp:status><!\[CDATA\[(draft|private|pending|trash)' "$f"; then
    echo "private data found in $f – aborting" >&2; exit 1
  fi
done

git -C "$OUT" add -A
git -C "$OUT" commit -q -m "${1:-Update from $(git rev-parse --short HEAD)}" || echo "nothing to commit"
git -C "$OUT" push -q origin HEAD:main
echo "published $(git -C "$OUT" rev-parse --short HEAD) to $REMOTE"
