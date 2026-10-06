#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
[ -f public/index.html ] || { echo "❌ public/index.html not found - upload the app files into the public folder first."; exit 1; }
command -v firebase >/dev/null || { echo "Installing Firebase tool..."; npm install -g firebase-tools >/dev/null; }
firebase projects:list >/dev/null 2>&1 || firebase login --no-localhost
sed -i -E "s/gc-portal-v[0-9]+/gc-portal-v$(date +%y%m%d%H%M)/" public/sw.js
firebase deploy --only hosting --project tobys-gc-portal
git add -A && git commit -qm "Deploy $(date '+%Y-%m-%d %H:%M')" && git push -q && echo "✔ Saved to GitHub" || true
echo ""; echo "✔ LIVE at https://tobys-gc-portal.web.app"
