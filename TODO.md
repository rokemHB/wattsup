# To do

Open items, roughly in the order they are worth doing.

- [x] README for the repository with in-game screenshots.
- [ ] Bike geometry more like an aero road bike: deep-section wheels, dropped seat stays, a sloping top tube, integrated bar and stem, a kammtail down tube.
- [x] Dropped Bluetooth connections during a ride hold the ride (clock, distance, workout) and show a banner until the trainer is back. Still to verify on real hardware.
- [x] Riders without a Zwift Cog: the drivetrain setting turns virtual gearing off and hides the gear tile and auto-shift; cadence shows a dash unless the trainer reports it.
- [ ] Trees and bushes as real models instead of primitives; place them from the aerial photo as now.
- [ ] Parapet floats where the road bridges itself at the Nus de sa Corbata.
- [ ] Rider model: face, better jersey, a proper helmet.
- [ ] Settings: remember the chosen route and camera, a "forget device" action.
- [ ] Island performance: 27 to 35 fps on an Intel UHD 620; build tiles in a worker, fewer draw calls per tile (merge road strips), lower pixel ratio floor.
- [ ] Ride recording to FIT or TCX for Strava.
- [ ] Multiplayer over a WebSocket server (engine snapshots in, other riders out).
- [ ] More of Mallorca: the pipeline works for any road; next candidates Puig Major, Coll de Sóller, Formentor.

## Ideas

- Workout mountains: define a workout as ERG intervals (watts × minutes) and let the game build a custom mountain whose grades correspond to those watts, so the intervals are ridden as climbs and recoveries as flats or descents. Open questions: ERG holds the watts regardless of the hill, so either the hill is scenery over ERG (the trainer does the work, the mountain shows the plan) or the hill *is* the workout in SIM mode with grades chosen so the target watts come at the rider's chosen cadence and gear. Interval length maps to climb length through the rider's expected speed at that power.
- [ ] Island: hide lower hairpin legs behind terrain (a 10 m grid exposes road ribbons on cliffs); build tiles in idle slices instead of blocking a frame; the engine should pause while a world loads; signs at dead ends and for the road number straight ahead; the far layer's photo is blurry up close at the tile edge.
- [ ] Background music: a few royalty-free tracks (or generated ambient), volume in Settings, off by default while a workout's audio cues play.
