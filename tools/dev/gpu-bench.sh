#!/bin/bash
# GPU time per frame and per part of the scene, at five fixed spots, on a hidden monitor.
#
#   tools/dev/gpu-bench.sh <label> [repo]      # results in /tmp/wattsup-bench/results-<label>.jsonl
#   tools/dev/gpu-bench-table.py /tmp/wattsup-bench/results-a.jsonl /tmp/wattsup-bench/results-b.jsonl 1.5
#
# Each spot: the dev app starts with the simulator off, tools/dev/gpu-bench.js pins the rider
# to the start point, waits until every tile is built, stops the game loop and times
# renderer.render bracketed by gl.finish() (WebKitGTK has no timer queries; ten renders per
# sample because performance.now() has 1 ms resolution there), at render scale 1.0 and 1.5,
# three runs, with each part of the scene hidden in turn. A part's cost is the total minus the
# total without it. Compare two builds by passing another checkout (a second worktree) as
# [repo]: the camera position is logged, so both runs can be checked to show the same frame.
# The window goes to a headless output (created if missing) so the laptop screen stays free.
set -u
LABEL=$1
REPO=${2:-$(cd "$(dirname "$0")/../.." && pwd)}
OUT=${WATTSUP_BENCH_DIR:-/tmp/wattsup-bench}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
LOG=$OUT/dev.log
RESULTS=$OUT/results-$LABEL.jsonl
: > "$RESULTS"
HMON=$(hyprctl monitors -j | jq -r '.[] | select(.name | startswith("HEADLESS")) | .name' | head -1)
if [ -z "$HMON" ]; then
  hyprctl output create headless > /dev/null
  sleep 1
  HMON=$(hyprctl monitors -j | jq -r '.[] | select(.name | startswith("HEADLESS")) | .name' | head -1)
fi
HWS=$(hyprctl monitors -j | jq -r ".[] | select(.name==\"$HMON\") | .activeWorkspace.id")
cd "$REPO" || exit 1
for spec in \
  "soller WATTSUP_SCREEN=island WATTSUP_ISLAND_AT=39.7650,2.7100" \
  "tunnel WATTSUP_SCREEN=island WATTSUP_ISLAND_AT=39.789326,2.7764275" \
  "hairpins WATTSUP_SCREEN=ride WATTSUP_ROUTE=sa-calobra WATTSUP_START_M=8620" \
  "palma WATTSUP_SCREEN=island WATTSUP_ISLAND_AT=39.5816,2.6446" \
  "malaga WATTSUP_SCREEN=ride WATTSUP_ROUTE=malaga-colmenar WATTSUP_START_M=12000"; do
  set -- $spec
  name=$1
  shift
  start_m=0
  for kv in "$@"; do case $kv in WATTSUP_START_M=*) start_m=${kv#WATTSUP_START_M=} ;; esac; done
  js="window.__spot = \"$name\"; window.__startM = $start_m; $(cat "$HERE/gpu-bench.js")"
  "$REPO/tools/dev/stop.sh" > /dev/null
  for i in $(seq 1 40); do hyprctl clients -j | grep -q '"title": "WattsUp"' || break; sleep 0.5; done
  env "$@" WATTSUP_SIM_ONLY=1 WATTSUP_AUTO_SIM=0 WATTSUP_CAMERA=chase WATTSUP_DEV_JS="$js" setsid nohup npm run tauri dev > "$LOG" 2>&1 < /dev/null &
  addr=""
  for i in $(seq 1 600); do
    addr=$(hyprctl clients -j 2>/dev/null | jq -r '.[] | select(.title=="WattsUp") | .address' | head -1)
    [ -n "$addr" ] && break
    if grep -qE '^error(\[|:)' "$LOG"; then echo "build error, see $LOG"; exit 1; fi
    sleep 0.5
  done
  hyprctl dispatch "hl.dsp.window.move({ workspace = \"$HWS\", follow = false, window = \"address:$addr\" })" > /dev/null
  for i in $(seq 1 400); do
    grep -aq "OUT PB-DONE\|OUT PB error" "$LOG" && break
    sleep 1
  done
  grep -a "OUT PB error" "$LOG" | sed 's/.*OUT/OUT/' | head -2
  grep -a "OUT PB {" "$LOG" | sed 's/.*OUT PB //' >> "$RESULTS"
  echo "$name: camera at $(grep -a 'OUT PB-DONE' "$LOG" | sed 's/.*OUT PB-DONE //' | head -1)"
done
"$REPO/tools/dev/stop.sh" > /dev/null
echo "results in $RESULTS"
