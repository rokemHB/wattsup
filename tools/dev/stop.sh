#!/bin/bash
# Stops the dev app, the Tauri CLI and Vite. (The patterns live here so a caller's command line never contains them.)
pkill -f 'target/debug/wattsup' 2>/dev/null; pkill -f 'node_modules/.bin/tauri' 2>/dev/null; pkill -f 'node_modules/.bin/vite' 2>/dev/null; pkill -f 'node_modules/vite/bin' 2>/dev/null
sleep 1
pgrep -af 'debug/wattsup|tauri dev|vite' | grep -v pgrep || echo "WattsUp stopped"
