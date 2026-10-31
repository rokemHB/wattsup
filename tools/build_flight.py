#!/usr/bin/env python3
"""The electric plane's flight over the Serra de Tramuntana, both ways, as built-in routes.

A smooth path through waypoints along the range (Port d'Andratx to Cap de Formentor),
in the island network's frame, sampled every 5 m. Each point's height is the plane's
altitude: the highest ground within CLEAR_RADIUS_M (Copernicus 30 m) plus CLEARANCE_M,
smoothed, and never climbing or sinking more steeply than MAX_GRADE (by raising, never
lowering, so the clearance holds). The engine flies a route marked "flight" as level
(the trainer feels a flat road) and three times as fast as a bike; the renderer draws
the plane at the altitude.

    .venv/bin/python tools/build_flight.py --network crates/core/worlds/mallorca/network.json \\
        --dem ~/wattsup-data/dem_n39_e002.tif ~/wattsup-data/dem_n39_e003.tif
"""
import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_network import resample  # noqa: E402
from build_route import EARTH_LAT_M, EARTH_LON_M, DemStack  # noqa: E402

WAYPOINTS = [
    ("Port d'Andratx", 39.5440, 2.3850),
    ("Coll de sa Gramola", 39.5860, 2.4200),
    ("Galatzó", 39.6300, 2.4700),
    ("Puigpunyent", 39.6300, 2.5300),
    ("Esporles", 39.6680, 2.5780),
    ("Valldemossa", 39.7110, 2.6220),
    ("Deià", 39.7520, 2.6400),
    ("Port de Sóller", 39.7970, 2.6930),
    ("Sóller", 39.7680, 2.7150),
    ("Biniaraix", 39.7750, 2.7550),
    ("Cúber", 39.7850, 2.8000),
    ("Gorg Blau", 39.8040, 2.8260),
    ("Torrent de Pareis", 39.8450, 2.8100),
    ("Lluc", 39.8220, 2.8850),
    ("Tomir", 39.8400, 2.9400),
    ("Pollença", 39.8770, 3.0160),
    ("Port de Pollença", 39.9050, 3.0850),
    ("Formentor", 39.9300, 3.1350),
    ("Cap de Formentor", 39.9570, 3.2050),
]
SPACING_M = 5.0
CLEAR_RADIUS_M = 350.0
CLEARANCE_M = 170.0
MAX_GRADE = 0.09
SMOOTH_M = 1500.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--network", required=True)
    ap.add_argument("--dem", nargs="+", required=True)
    ap.add_argument("--out-dir", default=str(Path(__file__).resolve().parent.parent / "crates/core/routes"))
    a = ap.parse_args()

    origin = json.load(open(a.network))["origin"]
    lat0, lon0 = origin["lat"], origin["lon"]
    kx = EARTH_LON_M * math.cos(math.radians(lat0))
    xz = np.array([[(lon - lon0) * kx, -(lat - lat0) * EARTH_LAT_M] for _, lat, lon in WAYPOINTS])
    pts = resample(xz, SPACING_M)
    dem = DemStack(a.dem)

    # The highest ground near each point: the point and three rings of twelve around it.
    lats = lat0 - pts[:, 1] / EARTH_LAT_M
    lons = lon0 + pts[:, 0] / kx
    ground = np.nan_to_num(dem.sample_many(lats, lons), nan=0.0)
    for ring in (CLEAR_RADIUS_M / 3, 2 * CLEAR_RADIUS_M / 3, CLEAR_RADIUS_M):
        for k in range(12):
            t = 2 * math.pi * k / 12
            h = dem.sample_many(lats - ring * math.sin(t) / EARTH_LAT_M, lons + ring * math.cos(t) / kx)
            ground = np.maximum(ground, np.nan_to_num(h, nan=0.0))
    alt = np.maximum(ground, 0.0) + CLEARANCE_M

    # Smooth: a running maximum then a moving average over SMOOTH_M, so the plane rides
    # long swells, not every crag; the maximum first keeps it above them.
    n = max(1, int(SMOOTH_M / SPACING_M / 2))
    padded = np.pad(alt, n, mode="edge")
    runmax = np.array([padded[i : i + 2 * n + 1].max() for i in range(len(alt))])
    kernel = np.ones(2 * n + 1) / (2 * n + 1)
    alt = np.convolve(np.pad(runmax, n, mode="edge"), kernel, mode="valid")
    # Grade limit, raising only: forward and backward passes.
    step = MAX_GRADE * SPACING_M
    for i in range(1, len(alt)):
        alt[i] = max(alt[i], alt[i - 1] - step)
    for i in range(len(alt) - 2, -1, -1):
        alt[i] = max(alt[i], alt[i + 1] - step)

    def route(name, p, y):
        d = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(p[:, 0]), np.diff(p[:, 1])))])
        return {
            "name": name,
            "points": [{"distance_m": round(float(di), 2), "x": round(float(x), 2), "y": round(float(h), 2), "z": round(float(z), 2)} for di, (x, z), h in zip(d, p, y)],
            "closed": False,
            "world": "mallorca",
            "flight": True,
        }

    out = Path(a.out_dir)
    there = route("Flight: Andratx → Formentor", pts, alt)
    back = route("Flight: Formentor → Andratx", pts[::-1], alt[::-1])
    for rid, r in (("tramuntana-flight", there), ("tramuntana-flight-back", back)):
        (out / f"{rid}.json").write_text(json.dumps(r, separators=(",", ":")))
        print(f"{rid}: {r['points'][-1]['distance_m'] / 1000:.1f} km, altitude {alt.min():.0f}-{alt.max():.0f} m")


if __name__ == "__main__":
    main()
