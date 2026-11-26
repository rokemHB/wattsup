# Changelog

What changed in each release of WattsUp. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the version numbers
[Semantic Versioning](https://semver.org/): while WattsUp is 0.x, a minor version (0.2) brings
new features and a patch version (0.1.1) only fixes.

## [Unreleased]

## [0.1.0] - 2026-11-27

The first public release: rideable, early, and built for a Zwift Cog and Click without a
subscription.

### Riding

- Real climbs: roads from OpenStreetMap, gradients from Spain's 5 m terrain survey (IGN MDT05),
  aerial photos and trees where real trees stand.
- Sa Calobra (10.2 km at 6.7 %), Málaga → Riogordo over the Puerto del León (43 km, 1130 m),
  and the whole Serra de Tramuntana on Mallorca as a road network (420 km), with turns at signed
  junctions and U-turns.
- A route planner on the map, like komoot: start, destination, waypoints, drag to reroute,
  "Prefer main roads", avoided roads, GPX import, saved routes, the ride time at your FTP.
- An electric plane for a 100 km flight from Port d'Andratx to Cap de Formentor.

### Training

- Virtual gearing for the Zwift Cog: 24 gears shifted with a Zwift Click, Click v2, Play or
  Ride, or the keyboard; the trainer's resistance follows the gear and the hill. Can be turned
  off for riders without a Cog.
- Trainer mode with ERG workouts, quick blocks and Free ERG, +/− watts and skip, and a small
  always-on-top window for training in front of a video.
- An FTP ramp test that sets your FTP.

### Records

- Every ride saved with one-second samples; a Rides screen with weekly totals and graphs.
- TCX export for Strava and other platforms.

### Hardware

- Bluetooth FTMS trainers (built on a Wahoo KICKR CORE 2), heart-rate straps, Zwift Click v2
  with both pucks; the devices last used connect by themselves.

### App

- Installers for Windows, macOS (Apple Silicon and Intel) and Linux (AppImage, .deb, .rpm).
- The main menu says when a newer version is out (one request to GitHub at startup; Settings
  turns it off).

[Unreleased]: https://github.com/rokemHB/wattsup/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rokemHB/wattsup/releases/tag/v0.1.0
