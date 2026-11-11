#!/bin/sh
# Smoke test of the demo build (npm run demo) served under a subpath, as GitHub Pages serves a project site.
# CHROME: a Chromium or chrome-headless-shell binary. SHOTS: keep screenshots in this dir.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
SRV='' CH=''
trap 'kill $CH $SRV 2>/dev/null || :; wait $CH 2>/dev/null || :; rm -rf "$tmp"' EXIT
shots=${SHOTS:-$tmp/shots}
mkdir -p "$shots" "$tmp/site" "$tmp/prof" "$tmp/xdgc" "$tmp/xdgd"
touch "$tmp/xdgc/user-dirs.dirs"
ln -s "$here/../dist-demo" "$tmp/site/dziennik"
python3 -m http.server -b 127.0.0.1 -d "$tmp/site" 18082 >"$tmp/srv.log" 2>&1 & SRV=$!
env -u DISPLAY -u WAYLAND_DISPLAY XDG_CONFIG_HOME="$tmp/xdgc" XDG_DATA_HOME="$tmp/xdgd" \
  "$CHROME" --headless --remote-debugging-port=19223 --user-data-dir="$tmp/prof" --no-first-run --lang=pl-PL about:blank \
  >"$tmp/chrome.log" 2>&1 & CH=$!
for _ in $(seq 30); do
  curl -sfo /dev/null 127.0.0.1:19223/json/version && curl -sfo /dev/null 127.0.0.1:18082/dziennik/ && break
  sleep 0.3
done
timeout 120 node "$here/demo.mjs" 19223 "$shots" http://127.0.0.1:18082/dziennik >"$tmp/run.log" 2>&1 || :
cat "$tmp/run.log"
! grep -q '^FAIL' "$tmp/run.log" && grep -q '^PASS no console errors' "$tmp/run.log"
