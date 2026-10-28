# To do

Open items, roughly in the order they are worth doing.

- [x] README for the repository with in-game screenshots.
- [ ] Bike geometry more like an aero road bike: deep-section wheels, dropped seat stays, a sloping top tube, integrated bar and stem, a kammtail down tube.
- [x] Dropped Bluetooth connections during a ride hold the ride (clock, distance, workout) and show a banner until the trainer is back. Still to verify on real hardware.
- [x] Riders without a Zwift Cog: the drivetrain setting turns virtual gearing off and hides the gear tile and auto-shift; cadence shows a dash unless the trainer reports it.
- [ ] Trees and bushes as real models instead of primitives; place them from the aerial photo as now.
- [ ] Parapet floats where the road bridges itself at the Nus de sa Corbata.
- [ ] Rider model: face, better jersey, a proper helmet.
- [ ] Rider model: the saddle clips into the rider's backside (seen on the island, chase camera); move the pelvis up or the saddle down and check the chase and side cameras.
- [ ] HUD: the junction prompt sits in the middle of the view and hides the road; move it to the top right, under the tiles, and make it smaller (smaller arrows and text, two options side by side still readable from the bike). The navigation panel can stay left but should not overlap the road ahead either.
- [ ] Bike through curves: it slides sideways at times instead of following the road; the pose from the route sampler and the rider's smoothed distance should turn the bike along the tangent (yaw from the route heading, lean into the curve), check hairpins at 8620 on Sa Calobra and the Sóller junction.
- [ ] Settings: remember the chosen route and camera, a "forget device" action.
- [ ] Island performance: 27 to 35 fps on an Intel UHD 620; build tiles in a worker, fewer draw calls per tile (merge road strips), lower pixel ratio floor.
- [x] Ride records: totals and one-second samples stored per ride, the Rides screen with weekly totals and graphs.
- [x] Trainer mode: ERG workouts and quick blocks with no 3D world, +/− watts, skip, a small always-on-top window, for training beside a video.
- [ ] Trainer mode: a Hyprland window rule (or a separate small window) so "Small window" floats by itself; optional free-ERG without a workout (set watts, no clock).
- [ ] Strava, like Zwift does it: keep x,z in the ride samples (lat/lon from the world origin at export time), write a TCX with power/HR/cadence (Garmin extension), an "Export TCX" button on the Rides screen; then the Strava API: Robin registers an API app (client id + secret, single-athlete mode is enough), OAuth once via the browser with a localhost redirect, refresh token in the app data folder, upload as VirtualRide with the trainer flag and "WattsUp" as creator, poll the upload status. Check whether real-road coordinates match real segments; fall back to no positions if they do.
- [x] Turn around while riding (U); manual turns on a planned route end the plan; navigation panel with the next turn, distance and climbing left, time left and arrival.
- [ ] Navigation: re-route back onto the plan after a wrong turn instead of ending it; the time left from the rider's FTP before a minute of riding.
- [ ] Multiplayer, later. The plan: a relay server crate (tokio + WebSockets, message types in core so client and server share them, JSON first), clients send their own state a few times a second (world, edge, distance, speed, power, cadence, HR, name, jersey) and get the others in their world back; physics stays on each client; the engine gets a multiplayer module and puts the others into the snapshot; the UI draws them instanced with names and slides them along the road between updates; drafting in core once neighbours are known. Hosting on a rented VPS behind Caddy (Robin does not want ports open at home; the NAS stays closed). Nothing in the current design blocks it: keep the physics in core deterministic and rider state expressible as edge + distance.
- [x] The Tramuntana as a road network: Ma-10 and the known climbs, tunnels, map with a start picker, turns, signs, terrain download.
- [x] Route planner on the map (komoot-like): start, destination, waypoints, auto-routing, drag the line to reroute, saved routes in the menu.
- [ ] Planner: a destination before the start ("Destination here" on an empty plan), routing preferences (avoid a road, prefer main roads), an estimated ride time from the rider's FTP, GPX import.
- [ ] Island, known rough edges: a flat pale strip section shows at some hairpins (Ma-2100 near Orient, 0.6 km from 39.7390,2.7190); the tube pokes a little past the headwall at portals; from the drone camera a slot is visible in the ground over tunnels; the map picture still has a lighter band where the imagery zoom changes over the sea.
- [ ] Island: the far layer (150 m) is coarse where tiles have not loaded; a 30 m middle layer for the Tramuntana would hide that.
- [ ] More roads can be added to the whitelist in `~/wattsup-data/refs.txt` (see README, "The island").

## Ideas

- Workout mountains: define a workout as ERG intervals (watts × minutes) and let the game build a custom mountain whose grades correspond to those watts, so the intervals are ridden as climbs and recoveries as flats or descents. Open questions: ERG holds the watts regardless of the hill, so either the hill is scenery over ERG (the trainer does the work, the mountain shows the plan) or the hill *is* the workout in SIM mode with grades chosen so the target watts come at the rider's chosen cadence and gear. Interval length maps to climb length through the rider's expected speed at that power.
- [ ] Island: hide lower hairpin legs behind terrain (a 10 m grid exposes road ribbons on cliffs); build tiles in idle slices instead of blocking a frame; the engine should pause while a world loads; signs at dead ends and for the road number straight ahead; the far layer's photo is blurry up close at the tile edge.
- [ ] Background music: a few royalty-free tracks (or generated ambient), volume in Settings, off by default while a workout's audio cues play.
