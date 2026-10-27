#!/bin/bash
# Restart the dev app at a spot and screenshot its window on the laptop screen (Hyprland + grim).
#
#   tools/dev/shot.sh <start_m> <camera> <out.png>
#   SCREEN=island ISLAND_AT=39.7650,2.7100[,back] SETTLE=40 tools/dev/shot.sh 0 chase soller.png
#
# Env: SCREEN (start|menu|rider|settings|workout|map|map-download|ride|island|workout-ride),
#      ISLAND_AT=lat,lon[,back], SETTLE seconds before the capture (default 28),
#      WATTSUP_DEV_LOG (default /tmp/wattsup-dev.log, also where console.warn lines land).
# Take more frames afterwards with:
#   G=$(hyprctl clients -j | jq -r '.[] | select(.title=="WattsUp") | "\(.at[0]),\(.at[1]) \(.size[0])x\(.size[1])"'); grim -g "$G" next.png
set -u
START=$1; CAM=$2; OUT=$3
LOG=${WATTSUP_DEV_LOG:-/tmp/wattsup-dev.log}
cd "$(dirname "$0")/../.."
# Kill patterns must not appear verbatim in the caller's command line, or pkill kills that shell too.
pkill -f 'target/debug/wattsup' 2>/dev/null; pkill -f 'node_modules/.bin/tauri' 2>/dev/null; pkill -f 'node_modules/.bin/vite' 2>/dev/null; pkill -f 'node_modules/vite/bin' 2>/dev/null; sleep 2
WATTSUP_SIM_ONLY=1 WATTSUP_AUTO_SIM=1 WATTSUP_START_M=$START WATTSUP_CAMERA=$CAM WATTSUP_SCREEN=${SCREEN:-} WATTSUP_ISLAND_AT=${ISLAND_AT:-} setsid nohup npm run tauri dev > "$LOG" 2>&1 < /dev/null &
for i in $(seq 1 240); do
  if hyprctl clients -j 2>/dev/null | grep -qi '"title": "WattsUp"'; then break; fi
  if grep -qE '^error(\[|:)' "$LOG"; then echo BUILD-ERROR; grep -E '^error' -A 6 "$LOG" | head -30; exit 1; fi
  sleep 1
done
sleep "${SETTLE:-28}"
G=$(hyprctl clients -j | jq -r '.[] | select(.title=="WattsUp") | "\(.at[0]),\(.at[1]) \(.size[0])x\(.size[1])"')
grim -g "$G" "$OUT" && echo "shot $OUT at $START ($CAM) geometry $G"
