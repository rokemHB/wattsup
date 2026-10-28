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

`WATTSUP_DEV_JS='<javascript>'` runs a script in the UI once it is up, with
`wattsup.map` (the map screen object, private fields reachable), `wattsup.api`
and `wattsup.screen()` in scope: the only way to click, hover and drag on the
map from a script here (no mouse automation on this machine). Dispatch
`MouseEvent`s on `map.canvas` (mousedown) and `window` (mousemove, mouseup)
with `clientX/Y` from `canvas.getBoundingClientRect()`; log with
`console.warn`. With `SCREEN=map`, `ISLAND_AT="lat,lon;lat,lon"` plans a
route through those points at startup.

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

## Performance (measured 2026-10-28 on the Intel UHD 620 laptop)

The frame is GPU fill-bound: time scales with pixels, not draw calls. The
renderer adapts the pixel ratio (0.7–1.5) every 4 s with hysteresis; each
change resizes the canvas and flashes once, so keep changes rare. What
costs per pixel: anisotropic filtering (now 2 on photos, 4 on asphalt),
MSAA, the detail shader, shadows, and a scene-wide environment map (removed:
hemisphere light instead, the sky map only on chrome and water). The sky is
baked once into a cube map. Tile builds yield to the frame every 5 ms.
`World.perfStats` logs frame statistics every 10 s at info level; to read them
in the dev log temporarily change that `console.info` to `console.warn`
(Vite forwards warn, not info). Beware: with no `SCREEN=ride`/`island` the app
idles in a menu at 15 fps and the statistics then measure nothing useful;
with `AUTO_SIM=0` the connection banner animates and skews them too.

## Route planner (map screen)

`ui/src/map.ts` is the map screen (view, click menu, waypoints, side panel,
saved plans in localStorage `wattsup.plans`); `ui/src/routing.ts` is the
Dijkstra router over the junction graph with mid-edge starts, ends and
waypoints (tests in `routing.test.ts`). A planned ride goes to the engine as
`PlannedLeg`s (`start_planned_ride`); `Navigator::planned` validates that they
join and the ride finishes at the last leg's end. Performance rules there:
everything per frame is prebuilt (roads and route pieces as `Path2D`, every
network point's map pixel in `pointPx`), a waypoint drag re-routes at most
once per animation frame, `NetworkIndex.nearest` searches in rings and stops
early. Measured: a route of 10k points costs ~1 ms to compute, ~1.5 ms to
draw.

## Navigation and ride records

`Navigator::turn_around` cuts the legs at the rider's nearest road point and
rides the same edge back (a free ride from there); `choose` with an edge other
than the planned one, and `turn_around`, call `leave_plan` (planned=false, the
route name falls back to the road ref). `EngineSnapshot.navigation` carries
`planned`, `remaining_m`, `remaining_climb_m` and the next planned `Maneuver`
(any distance; `junction` stays the 500 m prompt). The HUD panel is in
`hud.ts` (`updateNavigation`), the arrows in `ui/src/nav.ts`; `main.ts` turns
`plannedRide` off and shows the notice when `navigation.planned` flips.

The session accumulates `RideStats` and one-second `RideSample`s (`account()`
in `session.rs`, reset with the ride); `Engine::ride_report()` hands them out
and `wattsup_engine::rides::RideStore` files them as `<app data dir>/rides/
ride-<unix ms>.json` plus `index.json` (rebuilt from the files if lost). The UI
stores a ride through `api.saveRide()` when it ends or is replaced
(`storeRide()` in `main.ts`: 500 m and a minute of moving at least); the Rides
screen is `ui/src/rides.ts`.

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
