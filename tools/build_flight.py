#!/usr/bin/env python3
"""The electric plane's flight along the Ma-10, both ways, as built-in routes.

The Ma-10 from the island network (the shortest run of Ma-10 edges from Andratx to
Pollença), led in from the sea off Port d'Andratx and out over the bay of Pollença,
smoothed into long sweeps instead of its hairpins, yet never more than MAX_OFF_ROAD_M
from the road, so the road stays in view below the plane all the way. Sampled every
5 m in the island's frame; each point's height is the plane's altitude: the highest
ground within CLEAR_RADIUS_M (Copernicus 30 m) plus CLEARANCE_M, smoothed, and never
climbing or sinking more steeply than MAX_GRADE (by raising, never lowering, so the
clearance holds). The engine flies a route marked "flight" as level (the trainer feels
a flat road) and three times as fast as a bike; the renderer draws the plane at the
altitude.

    .venv/bin/python tools/build_flight.py --network crates/core/worlds/mallorca/network.json \\
        --dem ~/wattsup-data/dem_n39_e002.tif ~/wattsup-data/dem_n39_e003.tif
"""
import argparse
import heapq
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_network import resample  # noqa: E402
from build_route import EARTH_LAT_M, EARTH_LON_M, DemStack  # noqa: E402

ROAD = "Ma-10"
# From the harbour at Port d'Andratx to the one at Port de Pollença: the Ma-10 and, at the
# ends, the roads that take it down to the sea (Ma-1020, Ma-2200), so a road is always below.
FROM = (39.5440, 2.3850)
TO = (39.9050, 3.0850)
SEA_START = (39.5395, 2.3790)  # just out over the harbour
SEA_END = (39.9070, 3.0960)  # just out over the bay of Pollença
SPACING_M = 5.0
MAX_OFF_ROAD_M = 150.0
SMOOTH_HALF_M = 600.0
SMOOTH_PASSES = 30
CLEAR_RADIUS_M = 150.0
CLEARANCE_M = 80.0
MAX_GRADE = 0.09
ALT_SMOOTH_M = 1200.0


def road_polyline(net, xyz, to_xz):
    """The Ma-10's points from harbour to harbour: Dijkstra over the network with every other
    road twenty times as dear (roundabouts and links in the towns carry no ref; they bridge)."""
    on = lambda e: bool(e["ref"]) and ROAD in [r.strip() for r in e["ref"].split(";")]  # noqa: E731
    adj = {}
    for i in range(len(net["edges"])):
        e = net["edges"][i]
        adj.setdefault(e["a"], []).append((e["b"], i))
        adj.setdefault(e["b"], []).append((e["a"], i))
    nodes = net["nodes"]

    def nearest_node(latlon):
        x, z = to_xz(*latlon)
        return min(adj, key=lambda n: (nodes[n]["x"] - x) ** 2 + (nodes[n]["z"] - z) ** 2)

    start, goal = nearest_node(FROM), nearest_node(TO)
    dist = {start: 0.0}
    prev = {}
    heap = [(0.0, start)]
    while heap:
        d, n = heapq.heappop(heap)
        if n == goal:
            break
        if d > dist.get(n, math.inf):
            continue
        for m, ei in adj[n]:
            nd = d + net["edges"][ei]["length_m"] * (1.0 if on(net["edges"][ei]) else 20.0)
            if nd < dist.get(m, math.inf):
                dist[m] = nd
                prev[m] = (n, ei)
                heapq.heappush(heap, (nd, m))
    if goal not in prev:
        sys.exit(f"no road from Port d'Andratx to Port de Pollença")
    chain = []
    n = goal
    while n != start:
        p, ei = prev[n]
        chain.append((p, n, ei))
        n = p
    pts = []
    for a, b, ei in reversed(chain):
        e = net["edges"][ei]
        seg = xyz[e["start"] : e["start"] + e["count"], [0, 2]]
        if net["edges"][ei]["a"] != a:
            seg = seg[::-1]
        pts.extend(seg if not pts else seg[1:])
    print(f"{ROAD}: {len(chain)} edges, {dist[goal] / 1000:.1f} km", file=sys.stderr)
    return np.array(pts, dtype=np.float64)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--network", required=True)
    ap.add_argument("--dem", nargs="+", required=True)
    ap.add_argument("--out-dir", default=str(Path(__file__).resolve().parent.parent / "crates/core/routes"))
    a = ap.parse_args()

    net = json.load(open(a.network))
    xyz = np.fromfile(a.network.replace(".json", ".bin"), dtype="<f4").reshape(-1, 3)
    lat0, lon0 = net["origin"]["lat"], net["origin"]["lon"]
    kx = EARTH_LON_M * math.cos(math.radians(lat0))
    to_xz = lambda lat, lon: ((lon - lon0) * kx, -(lat - lat0) * EARTH_LAT_M)  # noqa: E731

    road = road_polyline(net, xyz, to_xz)
    tree = cKDTree(road)
    # Sea, road, sea: the lead-in and -out run straight to the road's ends, then everything is evened out.
    raw = np.vstack([np.array([to_xz(*SEA_START)]), road, np.array([to_xz(*SEA_END)])])
    path = resample(raw, 20.0)
    on_road = tree.query(path)[0] < 30.0
    # Smooth into long sweeps, pulled back each pass to within MAX_OFF_ROAD_M of the road
    # (except over the sea, before and after it). The ends stay put.
    n = int(SMOOTH_HALF_M / 20.0)
    for _ in range(SMOOTH_PASSES):
        padded = np.pad(path, ((n, n), (0, 0)), mode="edge")
        kernel = np.ones(2 * n + 1) / (2 * n + 1)
        smooth = np.column_stack([np.convolve(padded[:, k], kernel, mode="valid") for k in range(2)])
        smooth[0], smooth[-1] = path[0], path[-1]
        d, i = tree.query(smooth)
        far = (d > MAX_OFF_ROAD_M) & on_road
        pull = road[i[far]]
        smooth[far] = pull + (smooth[far] - pull) * (MAX_OFF_ROAD_M / d[far])[:, None]
        path = smooth
    pts = resample(path, SPACING_M)
    off = tree.query(pts)[0]
    print(f"path {len(pts) * SPACING_M / 1000:.1f} km, at most {off[off < 400].max():.0f} m off the road ({(off >= 400).sum() * SPACING_M:.0f} m over the sea at the ends)", file=sys.stderr)

    dem = DemStack(a.dem)
    lats = lat0 - pts[:, 1] / EARTH_LAT_M
    lons = lon0 + pts[:, 0] / kx
    ground = np.nan_to_num(dem.sample_many(lats, lons), nan=0.0)
    for ring in (CLEAR_RADIUS_M / 2, CLEAR_RADIUS_M):
        for k in range(12):
            t = 2 * math.pi * k / 12
            h = dem.sample_many(lats - ring * math.sin(t) / EARTH_LAT_M, lons + ring * math.cos(t) / kx)
            ground = np.maximum(ground, np.nan_to_num(h, nan=0.0))
    alt = np.maximum(ground, 0.0) + CLEARANCE_M
    # Smooth: a running maximum, then a moving average, so the plane rides swells, not every crag.
    m = max(1, int(ALT_SMOOTH_M / SPACING_M / 2))
    padded = np.pad(alt, m, mode="edge")
    runmax = np.array([padded[i : i + 2 * m + 1].max() for i in range(len(alt))])
    alt = np.convolve(np.pad(runmax, m, mode="edge"), np.ones(2 * m + 1) / (2 * m + 1), mode="valid")
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
    there = route("Flight along the Ma-10: Andratx → Pollença", pts, alt)
    back = route("Flight along the Ma-10: Pollença → Andratx", pts[::-1], alt[::-1])
    for rid, r in (("tramuntana-flight", there), ("tramuntana-flight-back", back)):
        (out / f"{rid}.json").write_text(json.dumps(r, separators=(",", ":")))
        print(f"{rid}: {r['points'][-1]['distance_m'] / 1000:.1f} km, altitude {alt.min():.0f}-{alt.max():.0f} m")


if __name__ == "__main__":
    main()
