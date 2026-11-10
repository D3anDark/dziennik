#!/bin/sh
# Headless UI test of dist/ against a fixture Synergia API (e2e/mock.py).
# CHROME: a Chromium or chrome-headless-shell binary. SHOTS: keep screenshots in this dir.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
MOCK='' CH=''
trap 'kill $CH $MOCK 2>/dev/null || :; wait $CH 2>/dev/null || :; rm -rf "$tmp"' EXIT
shots=${SHOTS:-$tmp/shots}
mkdir -p "$shots" "$tmp/prof" "$tmp/xdgc" "$tmp/xdgd"
touch "$tmp/xdgc/user-dirs.dirs"

python3 -I "$here/mock.py" "$here/../dist" 18081 >"$tmp/mock.log" 2>&1 & MOCK=$!
env -u DISPLAY -u WAYLAND_DISPLAY XDG_CONFIG_HOME="$tmp/xdgc" XDG_DATA_HOME="$tmp/xdgd" \
  "$CHROME" --headless --remote-debugging-port=19222 --user-data-dir="$tmp/prof" --no-first-run --lang=pl-PL about:blank \
  >"$tmp/chrome.log" 2>&1 & CH=$!
for _ in $(seq 30); do
  curl -sfo /dev/null 127.0.0.1:19222/json/version && curl -sfo /dev/null 127.0.0.1:18081/ && break
  sleep 0.3
done
# A driver that crashes or is cut off prints no FAIL line, so the run also has to reach its last line.
timeout 240 node "$here/drive.mjs" 19222 "$shots" http://127.0.0.1:18081 "$MOCK" >"$tmp/run.log" 2>&1 || :
cat "$tmp/run.log"
! grep -qE '^FAIL|^PROBLEMS' "$tmp/run.log" && grep -qx 'no console errors/exceptions' "$tmp/run.log"
