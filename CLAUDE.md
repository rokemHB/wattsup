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
  results yourself"). Since 2026-10-29 evening Robin wants the game run on a
  hidden monitor and closed when done: `hyprctl output create headless`, start
  the dev app, then move its window there with
  `hyprctl dispatch 'hl.dsp.window.move({ workspace = "<the headless output's
  workspace>", follow = false, window = "address:0x…" })'` and capture with
  `grim -g` on the window's geometry; `hyprctl output remove HEADLESS-N` after.
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
`wattsup.map` (the map screen object, private fields reachable), `wattsup.api`,
`wattsup.screen()` and `wattsup.world()` (the `World`; wrap `renderer.render` to
place the camera for close-ups of the rider) in scope: the only way to click, hover and drag on the
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

`tools/build_mid.py` (also run by `build_network.py`) writes `<id>-mid.bin`: a 45 m
int16 height grid over the roads' region (`mid` in the world json, loaded as
`NetworkWorldData.mid`). `TileManager.updateMid` streams mid-distance blocks
from it, one per WMTS zoom-13 tile with zoom-14 imagery, within `MID_RADIUS_M`
(7.5 km); `resink` lowers the far layer under mid blocks and tiles, and mid
blocks under tiles, recomputed from base heights whenever a layer changes.

At ride time terrain tiles (IGN WCS elevation + PNOA WMTS imagery) stream in
through `fetch_cached` (sha256 disk cache under the app cache dir,
`~/.cache/app.wattsup.desktop/tiles` on Linux; hosts allow-listed in
`src-tauri/src/tiles.rs`). The map screen's "Download all terrain" fetches the
whole region (~175 MB). The IGN servers answer 502 now and then: fetchers retry.

## Performance (measured 2026-10-28 on the Intel UHD 620 laptop)

The frame is partly GPU fill-bound and partly draw-call-bound: on WebKit's
JavaScriptCore every draw call costs ~30 µs of CPU in `renderer.render`
(measured 2026-10-29: 221 calls = 7.5 ms), so count calls (`World.perfStats`
prints them and a CPU split). Sign posts were the usual culprit in towns;
each post is now one mesh with one canvas texture (`signs.ts`), and
`TileManager.update` still hides posts beyond `SIGN_RADIUS_M`. Never put
`PointLight`s in streamed content: each adds a loop to every lit pixel and a
change in the light count recompiles every shader (tunnel lamps are baked
into vertex colours instead). The far and mid layers skip triangles wholly
under a finer layer (`resink`, draw range on the same index buffer). An empty scene runs at the 60 Hz cap fullscreen, so
the window itself is not the limit. CSS `backdrop-filter` on the ride HUD
cost ~2 ms (removed; the menus keep theirs). The
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

Measuring a change (learned 2026-10-29): the frame sits on the 60 Hz cap at
the adapted render scale, so force the scale up (`renderer.setPixelRatio(1.5)`
with `adaptResolution` stubbed) until the GPU is saturated, freeze the rider
(`world.update = () => {}`, `speed = 0`) so every variant draws the same
frame, and wait until all tiles are built: a measurement taken while tiles
still build once made the PBR terrain look 10 ms dearer than Lambert; frozen,
they cost the same. Tone mapping is `NeutralToneMapping` (ACES turned the
island grey-beige); asphalt `#9a9894` times its texture is ~10 % reflectance.

GPU time per pass (learned 2026-10-30): WebKitGTK exposes no WebGL timer
queries, so stop the game loop (`world.running = false`) and time
`renderer.render` bracketed by `gl.finish()`, ten renders per sample
(`performance.now()` has 1 ms resolution in WebKit); a part's cost is the total
minus the total with that part hidden. That is not capped by the display.
Draw order is the big lever: opaque objects go front to back
(`renderer.setOpaqueSort` in `world.ts`; three's default sorts by material
first, which drew the sea and the far layer before the tiles and shaded every
pixel twice), layers lying a few centimetres on top of each other draw top
first (`LAYER_ORDER` in `scene.ts`: markings, asphalt, shoulder, corridor),
the sea after all land and the sky last (`skyBox`: three's background cube
shader, depth-tested at the far plane). Measured on five spots at render scale
1.5 this took frames from 18-28 ms to 9-14 ms of GPU time (same camera,
same frame; `tools/dev/gpu-bench.sh` reruns it). Shader cost per
material: extract the programs' GLSL from the page (`gl.getShaderSource`) and
compile each alone in a surfaceless EGL context with `INTEL_DEBUG=fs`
(`MESA_SHADER_CACHE_DISABLE=true`, or cached shaders print nothing); dumps
from the app itself interleave, because shaders compile on parallel threads.
The sun comes from the solar ephemeris (`sun.ts`) for a fixed moment
(`SUN_TIME` in `world.ts`, noon CEST on 20 May): south-east at 60°, near where
it was for the aerial photos; it used to stand in the north-north-east.

## Vegetation

`ui/src/world/trees.ts` paints a foliage atlas once (pine, holm oak, cypress,
bush, a bark patch) and builds one geometry per kind: a trunk, three crossed
cards and a top card with every normal pointing up (the material keeps it up
on back faces too, see `onBeforeCompile`). `vegetation()` in `scene.ts`
instances them per tile with near-white tints and a `customDepthMaterial`
so shadows follow the cut-out. Geometry, atlas and materials are shared and
marked `userData.shared`, which `TileManager.unload` leaves alone.

Island tiles get real trees from `ui/public/worlds/mallorca-trees.bin.gz`
(`tools/build_trees.py`, see README): `forest.ts` builds them per 400 m cell
in `TileManager.plantForest`, one instanced mesh per kind (pine above 7 m,
round crown below) plus infill near the rider, two-card models beyond 320 m,
nothing beyond 1 km, shadows within 260 m; scattered pines and oaks are then
left out of `vegetation()` (`trees = false`). Foliage tints are multiplied by
`CANOPY_SHADE` (a canopy reflects 8-10 %; matched to photos of the Ma-10).
Tile unload calls `dispose()` on instanced meshes: their instance buffers are
not freed otherwise.

## Route planner (map screen)

`ui/src/map.ts` is the map screen (view, click menu, waypoints, side panel,
saved plans in localStorage `wattsup.plans`); `ui/src/routing.ts` is the
Dijkstra router over the junction graph with mid-edge starts, ends and
waypoints (tests in `routing.test.ts`). A planned ride goes to the engine as
`PlannedLeg`s (`start_planned_ride`); `Navigator::planned` validates that they
join and the ride finishes at the last leg's end. The panel's time comes from
`plan_time` (`Engine::plan_time_s`, the HUD's FTP model), asked 300 ms after
the route last changed. "Destination here" on an empty plan sets
`destinationFirst`: the one waypoint is B until the start is placed. Performance rules there:
everything per frame is prebuilt (roads and route pieces as `Path2D`, every
network point's map pixel in `pointPx`), a waypoint drag re-routes at most
once per animation frame, `NetworkIndex.nearest` searches in rings and stops
early. Measured: a route of 10k points costs ~1 ms to compute, ~1.5 ms to
draw. Preferences (`RoutePreferences`: "Prefer main roads", avoided edges
from the click menu) become per-edge cost weights (`edgeWeights`,
`Router.setWeights`); lengths reported stay real. They are stored in the
saved plan (`mainRoads`, `avoid` as mid-edge points) and handed to `main.ts`
with the ride so a re-route after a wrong turn keeps them. "Import GPX…"
(`ui/src/gpx.ts`): `parseGpx` reads trkpt/rtept/wpt, `matchTrack` turns the
track into waypoints (first and last road points, then the track point the
route strays from most until all is within 60 m, then prunes needless ones).

## Trainer mode

`ui/src/trainer.ts` is the ERG-only screen (menu → Trainer, `WATTSUP_SCREEN=
trainer` or `--trainer`): quick block or a saved/preset workout, started on
the flat route with no world (`show("trainer")` disposes the world; the menu
rebuilds it). The session has `set_workout_bias` (+/− watts on every step)
and `skip_workout_step`; the snapshot's `WorkoutSnapshot.bias_w` shows it.
"Free ERG" is a target with no workout (`set_mode erg` + `set_erg_target`;
`TrainerScreen.free`). "Small window" opens a second Tauri window (label
`compact`, `index.html?compact`, fixed 440×320, always on top; permissions in
`src-tauri/capabilities/default.json`) and hides the main one until it closes:
a fixed size is what Hyprland floats at map time, a live resize of a tiled
window does nothing. The small window runs the same UI in `compactWindow`
mode (trainer screen only, no world, no scan); `save_ride` dedups by start
time so both windows can end and store the same ride. Keep the live view
cheap: no canvas but the interval bar, redrawn once a second.

## Navigation and ride records

`Navigator::turn_around` cuts the legs at the rider's nearest road point and
rides the same edge back (a free ride from there); `choose` with an edge other
than the planned one, and `turn_around`, call `leave_plan` (planned=false, the
route name falls back to the road ref). `EngineSnapshot.navigation` carries
`planned`, `remaining_m`, `remaining_climb_m` and the next planned `Maneuver`
(any distance; `junction` stays the 500 m prompt), `eta_s` (the remaining
profile at the rider's average power, or `ETA_FTP_SHARE` × FTP from
`set_ftp` before a minute; a `SpeedTable` per whole-percent grade) and
`leg_end` (where the rider's current leg, or the turn they chose ahead, ends:
`Navigator::committed`). The HUD panel is in `hud.ts` (`updateNavigation`),
the arrows in `ui/src/nav.ts`. When `navigation.planned` flips, `main.ts`
routes from `leg_end` to the plan's destination with the TS `Router` and
hands the legs to `replan_ride` (`Navigator::replan` keeps the ride going:
distance and stats stay); only when that fails does `plannedRide` end with
the notice.

The session accumulates `RideStats` and one-second `RideSample`s (`account()`
in `session.rs`, reset with the ride); `Engine::ride_report()` hands them out
and `wattsup_engine::rides::RideStore` files them as `<app data dir>/rides/
ride-<unix ms>.json` plus `index.json` (rebuilt from the files if lost). The UI
stores a ride through `api.saveRide()` when it ends or is replaced
(`storeRide()` in `main.ts`: 500 m and a minute of moving at least); the Rides
screen is `ui/src/rides.ts`. Samples carry `xz` (route position); `export_ride`
writes `wattsup_engine::tcx::to_tcx` into the Downloads folder, positions from
`Network::builtin(world).origin` in the UI's flat frame (same constants as
`Frame` in `streaming.ts`).

## Gotchas

- `node_modules` must never be symlinked into a git worktree of this repo.
- localStorage keys: `wattsup.devices` (the real device last used per role;
  `scan(true)` in `debug.ts` connects them after a scan), `wattsup.route`
  and `wattsup.camera` (restored at startup unless `--route`/`--camera` is
  given; `StartupInfo.route_given`), `wattsup.plans`, `wattsup.workouts`,
  `wattsup.ftp`, `wattsup.virtualGearing`, `wattsup.pixelRatio`.
- Overpass is often at capacity; use the Geofabrik PBF path.
- The WCS caps one request at ~0.1°; chunks are 0.05° (pipeline) and
  0.02°×0.025° (ride-time tiles).
- `Navigator` leg indices are local to the edge; `nearest()` returns local too.
- A standing bike waits for the first pedal stroke (`pedalling()` in `session.rs`:
  cadence ≥ 20 rpm, or ≥ 20 W when the trainer sends no cadence). Without it the
  bike rolled off every downhill start by itself, trainer or not.
- Roundabouts: `build_network.py` fits a circle to every OSM `junction=roundabout`
  ring (radius 6-80 m), snaps its nodes onto it and samples its pieces as arcs, at
  least 48 points round, heights a straight ramp between the junctions; each piece
  carries `ring: [x, z, r]`. The renderer draws ring pieces with edge lines only (the
  outer one broken at each entry), stops the lines of roads coming in at the ring,
  and gives rings of 8 m and more a kerbed island coloured from the photo
  (`roundaboutIsland` in `scene.ts`). Network points are therefore not evenly 5 m
  apart: measure along the road, never by a point count (`heading_span` in
  `network.rs`: three points on a ring were its tangent and a free ride circled for
  ever); rides are resampled evenly (`Route::from_polyline`).
- Terrain grid is 10 m: anything finer near the road comes from the corridor
  strip (`corridorMesh`) and, in tunnels, from the tube.

## Rider weight and routes

The Rider screen's weight (`Profile.weightKg`, localStorage `wattsup.profile`)
goes to `set_rider_mass` → `RideSession::set_rider_mass` (the rider's mass in
`RiderParams`; the trainer's own 75 kg assumption in `TrainerProfile` stays
separate, which is right: the trainer converts force to a grade with its
mass, the physics uses the rider's). Built-in single routes: `sa-calobra`,
`malaga-colmenar` ("Málaga → Riogordo": 5 km flat made-up warm-up through
the city, the A-7000 over the Puerto del León, summit 951 m at km 25.1,
A-7204 down to Riogordo at 412 m, 43.2 km), `lakeside`, `flat`; data for
the Málaga one lives in `~/wattsup-data/malaga/` (OSM json for the A-7000
and A-7204 merged as `malaga_riogordo.json`, Copernicus tile, six
overlapping IGN chunks A–F). `build_route.py` options added for it: several
`--dem-fine` files (`DemStack`; chunks must overlap, the WCS leaves a
one-pixel seam otherwise), `--from`/`--to`/`--via` (nearest road nodes),
`--merge` (collapse split carriageways), `--lead-in`/`--lead-in-bearing`
(a straight flat stretch appended AFTER the road is splined: splining
through the junction curled 450 m loops; the ground within 250 m is
levelled to it), `--urban` (stretches with houses → `urban` in the world
json → `WorldData.urban` → `buildings()` in `ui/src/world/buildings.ts`:
painted facades, four merged meshes). Ciudad Jardín's dual carriageways
and roundabouts are only partly tagged A-7000: start nodes there make
Dijkstra loop around blocks; the clean start is the lowest A-7000 endpoint
at 36.7337,-4.4158 with only A-7000/A-7204 ways as input.

## Hardware (unverified assumptions, see HARDWARE_TESTING.md)

Wahoo KICKR CORE 2 with Zwift Cog, Zwift Click v2 (keyboard shifting stays as
fallback), a Bluetooth HR strap. Virtual gearing uses FTMS SIM mode with a
computed grade; ERG mode for workouts.
