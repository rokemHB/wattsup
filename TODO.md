# To do

Open items, roughly in the order they are worth doing.

- [ ] README for the repository with in-game screenshots (start screen, menu, Sa Calobra from the road, the hairpins from the drone view).
- [ ] Bike geometry more like an aero road bike: deep-section wheels, dropped seat stays, a sloping top tube, integrated bar and stem, a kammtail down tube.
- [ ] Dropped Bluetooth connections during a ride: show it clearly, pause the ride automatically (clock, distance) until the trainer is back, and resume by itself. The device layer already reconnects; the session and the ride screen do not react yet.
- [ ] Trees and bushes as real models instead of primitives; place them from the aerial photo as now.
- [ ] Parapet floats where the road bridges itself at the Nus de sa Corbata.
- [ ] Rider model: face, better jersey, a proper helmet.
- [ ] Settings: remember the chosen route and camera, a "forget device" action.
- [ ] Ride recording to FIT or TCX for Strava.
- [ ] Multiplayer over a WebSocket server (engine snapshots in, other riders out).
- [ ] More of Mallorca: the pipeline works for any road; next candidates Puig Major, Coll de Sóller, Formentor.

## Ideas

- Workout mountains: define a workout as ERG intervals (watts × minutes) and let the game build a custom mountain whose grades correspond to those watts, so the intervals are ridden as climbs and recoveries as flats or descents. Open questions: ERG holds the watts regardless of the hill, so either the hill is scenery over ERG (the trainer does the work, the mountain shows the plan) or the hill *is* the workout in SIM mode with grades chosen so the target watts come at the rider's chosen cadence and gear. Interval length maps to climb length through the rider's expected speed at that power.
