# WattsUp — notes for agents

WattsUp is Robin's gamified indoor cycling app (Zwift-like, no subscription): a
Rust workspace (`crates/core` pure logic, `crates/devices` BLE + simulator,
`crates/engine` orchestrator, `crates/cli`), a Tauri v2 shell (`src-tauri`) and
a Vite/TypeScript + Three.js front end (`ui/`). README.md explains the product
and the data pipelines; TODO.md is the backlog; HARDWARE_TESTING.md the checks
that still need the real trainer.

## Rules Robin has set

- Feature work goes on a branch; Robin merges and decides. Never force-push.
- Before **every** commit run all five, in order, and fix what they report:
  `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace`, `./node_modules/.bin/tsc --noEmit`, `npx vitest run`.
  (Use the repo's `tsc`, not `npx tsc`, which may fetch a bogus package.)
- Small commits with a message that says why.
- Verify graphics by screenshot before claiming they look right ("check the
  results yourself"). Use only the laptop's main screen (eDP-1); no hidden
  monitors.
- Keep the engine UI-independent (the UI talks to it through Tauri commands and
  the `snapshot` event).

## Running and looking at it

```sh
npm ci && npm run tauri dev                     # real Bluetooth
WATTSUP_SIM_ONLY=1 WATTSUP_AUTO_SIM=1 npm run tauri dev   # simulated trainer, no BLE
```
Env for jumping straight to a spot: `WATTSUP_SCREEN=<start|menu|rider|settings|
workout|map|map-download|ride|island|workout-ride>`, `WATTSUP_ISLAND_AT=lat,lon[,back]`
(network ride from there), `WATTSUP_START_M=<m>` and `WATTSUP_CAMERA=<chase|side|
front|drone|orbit>` for single routes. The Tauri CLI swallows flags, so use env.

Close the app when you are done with a piece of work (Robin does not want it
running all the time): `tools/dev/stop.sh`.

`tools/dev/shot.sh <start_m> <camera> <out.png>` restarts the dev app and
screenshots its window (Hyprland `hyprctl` + `grim`); see its header. The
app's `console.warn` lines are forwarded by Vite into the dev log, `console.info`
is not. Rust edits restart the app (it watches `crates/*` and `src-tauri`).
Never put a `pkill -f <pattern>` inline in a command whose own text contains
the pattern: it kills the shell (exit 144); the script keeps them in a file.

Useful review spots: Sa Calobra route at 150 (front camera), 2200, 6900 (knot),
8620 (hairpins); island `ISLAND_AT` 39.7650,2.7100 (Sóller junction),
39.9300,3.1300 (Formentor), 39.8440,2.8010 (Sa Calobra top),
39.792435,2.7754993,back (Monnàber tunnel on the Ma-10).

## Data

Source data lives outside the repo in `~/wattsup-data/`: `tramuntana_osm.json`
(from `baleares.osm.pbf` through `tools/pbf_extract.py`), `dem5/` (190 IGN 5 m
chunks, lattice starting at the bbox origin), `dem_n39_e00[23].tif` (Copernicus
30 m), `tiles/` (pipeline WMTS cache) and `refs.txt` (the road whitelist). A
Python venv with `tools/requirements.txt` + `osmium` + `Pillow` is needed.
The exact build commands are in README.md ("The island", "Single routes").
Outputs are committed: `crates/core/worlds/mallorca/network.{json,bin}`
(include_bytes in `network.rs`) and `ui/public/worlds/`.

At ride time terrain tiles (IGN WCS elevation + PNOA WMTS imagery) stream in
through `fetch_cached` (sha256 disk cache under the app cache dir,
`~/.cache/app.wattsup.desktop/tiles` on Linux; hosts allow-listed in
`src-tauri/src/tiles.rs`). The map screen's "Download all terrain" fetches the
whole region (~175 MB). The IGN servers answer 502 now and then: fetchers retry.

## Gotchas

- `node_modules` must never be symlinked into a git worktree of this repo.
- Overpass is often at capacity; use the Geofabrik PBF path.
- The WCS caps one request at ~0.1°; chunks are 0.05° (pipeline) and
  0.02°×0.025° (ride-time tiles).
- `Navigator` leg indices are local to the edge; `nearest()` returns local too.
- Terrain grid is 10 m: anything finer near the road comes from the corridor
  strip (`corridorMesh`) and, in tunnels, from the tube.

## Hardware (unverified assumptions, see HARDWARE_TESTING.md)

Wahoo KICKR CORE 2 with Zwift Cog, Zwift Click v2 (keyboard shifting stays as
fallback), a Bluetooth HR strap. Virtual gearing uses FTMS SIM mode with a
computed grade; ERG mode for workouts.
