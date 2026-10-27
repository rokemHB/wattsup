#!/usr/bin/env python3
"""Builds a real-world route and its terrain from OpenStreetMap and the Copernicus DEM.

Inputs:
  --osm     Overpass JSON (`out geom;`) with the road's ways
  --dem     Copernicus GLO-30 COG GeoTIFF covering the area (1 arcsec, pixel-is-point)
Outputs (in the repo):
  crates/core/routes/<id>.json      route for the Rust core (distance, x, y, z every 5 m)
  ui/public/worlds/<id>.json        world metadata (origin, grids)
  ui/public/worlds/<id>-near.bin    float32 heightmap, 15 m spacing, around the route
  ui/public/worlds/<id>-far.bin     float32 heightmap, 150 m spacing, wide area

Local frame: x east, z south (so +x/+z is a right-handed frame with y up), metres,
origin at the route's bounding-box centre. Elevations are metres above sea level.

Data: © OpenStreetMap contributors (ODbL); Copernicus DEM © ESA / Airbus (free use with attribution).
"""
import argparse
import heapq
import json
import math
import struct
from pathlib import Path

import numpy as np
import tifffile

SPACING = 5.0
EARTH_LAT_M = 110574.0
EARTH_LON_M = 111320.0


def haversine(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


class Dem:
    def __init__(self, path):
        with tifffile.TiffFile(path) as t:
            page = t.pages[0]
            tie = page.tags["ModelTiepointTag"].value
            scale = page.tags["ModelPixelScaleTag"].value
            self.lon0, self.lat0 = tie[3], tie[4]
            self.dlon, self.dlat = scale[0], scale[1]
            self.data = page.asarray().astype(np.float32)
        self.rows, self.cols = self.data.shape

    def sample(self, lat, lon):
        """Bilinear elevation; pixel centres sit on the grid (pixel-is-point)."""
        r = (self.lat0 - lat) / self.dlat
        c = (lon - self.lon0) / self.dlon
        r0, c0 = int(math.floor(r)), int(math.floor(c))
        if r0 < 0 or c0 < 0 or r0 + 1 >= self.rows or c0 + 1 >= self.cols:
            return float("nan")
        fr, fc = r - r0, c - c0
        d = self.data
        return float((d[r0, c0] * (1 - fr) + d[r0 + 1, c0] * fr) * (1 - fc) + (d[r0, c0 + 1] * (1 - fr) + d[r0 + 1, c0 + 1] * fr) * fc)

    def grid(self, lat_min, lat_max, lon_min, lon_max, spacing_m, lat_ref):
        """Heightmap rows from north to south, columns west to east, at `spacing_m`."""
        dlat = spacing_m / EARTH_LAT_M
        dlon = spacing_m / (EARTH_LON_M * math.cos(math.radians(lat_ref)))
        lats = np.arange(lat_max, lat_min - 1e-12, -dlat)
        lons = np.arange(lon_min, lon_max + 1e-12, dlon)
        out = np.empty((len(lats), len(lons)), dtype=np.float32)
        for i, lat in enumerate(lats):
            for j, lon in enumerate(lons):
                v = self.sample(lat, lon)
                out[i, j] = 0.0 if math.isnan(v) else v
        return lats, lons, out


def chain_ways(elements, dem, start_lowest=True, cut_at_top=False):
    """Shortest path through the ways from the lowest endpoint to the highest."""
    nodes = {}
    adj = {}
    for e in elements:
        if e["type"] != "way":
            continue
        ids = e["nodes"]
        geom = e["geometry"]
        for nid, g in zip(ids, geom):
            nodes[nid] = (g["lat"], g["lon"])
        for a, b in zip(ids, ids[1:]):
            w = haversine(nodes[a], nodes[b])
            adj.setdefault(a, []).append((b, w))
            adj.setdefault(b, []).append((a, w))
    ends = [n for n, nb in adj.items() if len(nb) == 1]
    elev = {n: dem.sample(*nodes[n]) for n in ends}
    lo = min(ends, key=lambda n: elev[n])
    hi = max(ends, key=lambda n: elev[n])
    start, goal = (lo, hi) if start_lowest else (hi, lo)
    dist = {start: 0.0}
    prev = {}
    heap = [(0.0, start)]
    while heap:
        d, n = heapq.heappop(heap)
        if n == goal:
            break
        if d > dist.get(n, math.inf):
            continue
        for m, w in adj[n]:
            nd = d + w
            if nd < dist.get(m, math.inf):
                dist[m] = nd
                prev[m] = n
                heapq.heappush(heap, (nd, m))
    path = [goal]
    while path[-1] != start:
        path.append(prev[path[-1]])
    path.reverse()
    if cut_at_top:
        # A climb ends at its summit, not where the road number ends.
        heights = [dem.sample(*nodes[n]) for n in path]
        path = path[: heights.index(max(heights)) + 1]
    return [nodes[n] for n in path], elev[start], dem.sample(*nodes[path[-1]])


def catmull_rom(p0, p1, p2, p3, t):
    t2, t3 = t * t, t * t * t
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)


def resample(xz, spacing):
    """Smooth polyline through the points, sampled every `spacing` metres by arc length."""
    pts = np.array(xz)
    n = len(pts)
    dense = []
    for i in range(n - 1):
        p0 = pts[max(i - 1, 0)]
        p1, p2 = pts[i], pts[i + 1]
        p3 = pts[min(i + 2, n - 1)]
        seg = np.linalg.norm(p2 - p1)
        steps = max(2, int(seg / 1.0))
        for k in range(steps):
            t = k / steps
            dense.append(catmull_rom(p0, p1, p2, p3, t))
    dense.append(pts[-1])
    out = [dense[0]]
    travelled = 0.0
    nxt = spacing
    for a, b in zip(dense, dense[1:]):
        seg = float(np.linalg.norm(b - a))
        while seg > 0 and travelled + seg >= nxt:
            t = (nxt - travelled) / seg
            out.append(a + (b - a) * t)
            nxt += spacing
        travelled += seg
    return np.array(out)


def smooth(values, half_window):
    k = 2 * half_window + 1
    padded = np.pad(values, half_window, mode="edge")
    return np.convolve(padded, np.ones(k) / k, mode="valid")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--osm", required=True)
    ap.add_argument("--dem", required=True)
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--repo", default=str(Path(__file__).resolve().parent.parent))
    ap.add_argument("--near-margin", type=float, default=2500.0, help="metres around the route in the near heightmap")
    ap.add_argument("--near-spacing", type=float, default=15.0)
    ap.add_argument("--far-size", type=float, default=36000.0)
    ap.add_argument("--far-spacing", type=float, default=150.0)
    ap.add_argument("--cut-at-top", action="store_true", help="end the route at its highest point (a climb)")
    ap.add_argument("--smooth", type=int, default=12, help="elevation smoothing half-window in 5 m samples")
    ap.add_argument("--max-grade", type=float, default=14.0, help="cap on the grade in percent")
    ap.add_argument("--min-grade", type=float, default=-14.0, help="cap on descents in percent (use e.g. -6 for a pure climb)")
    args = ap.parse_args()

    dem = Dem(args.dem)
    osm = json.load(open(args.osm))
    latlon, e_start, e_end = chain_ways(osm["elements"], dem, cut_at_top=args.cut_at_top)
    print(f"path: {len(latlon)} nodes, {e_start:.0f} m -> {e_end:.0f} m")

    lat_ref = (max(p[0] for p in latlon) + min(p[0] for p in latlon)) / 2
    lon_ref = (max(p[1] for p in latlon) + min(p[1] for p in latlon)) / 2
    kx = EARTH_LON_M * math.cos(math.radians(lat_ref))
    to_xz = lambda lat, lon: (float((lon - lon_ref) * kx), float(-(lat - lat_ref) * EARTH_LAT_M))
    to_latlon = lambda x, z: (lat_ref - z / EARTH_LAT_M, lon_ref + x / kx)

    xz = resample([to_xz(*p) for p in latlon], SPACING)
    raw = np.array([dem.sample(*to_latlon(x, z)) for x, z in xz])
    # The DEM is a surface model on 30 m cells: on a cliff road with stacked
    # hairpins it is off by tens of metres. Smooth, cap the grade, then
    # re-integrate so the profile stays plausible and ends at the right height.
    y = smooth(raw, args.smooth)
    step = np.clip(np.diff(y), args.min_grade / 100 * SPACING, args.max_grade / 100 * SPACING)
    y = np.concatenate([[y[0]], y[0] + np.cumsum(step)])
    y += np.linspace(0, smooth(raw, args.smooth)[-1] - y[-1], len(y))
    points = [{"distance_m": i * SPACING, "x": round(float(x), 2), "y": round(float(h), 2), "z": round(float(z), 2)} for i, ((x, z), h) in enumerate(zip(xz, y))]
    length = points[-1]["distance_m"]
    gain = float(np.sum(np.clip(np.diff(y), 0, None)))
    grades = np.diff(y) / SPACING * 100
    g100 = np.convolve(grades, np.ones(20) / 20, mode="valid")
    print(f"route: {length/1000:.2f} km, {y[0]:.0f} -> {y[-1]:.0f} m, gain {gain:.0f} m, avg {100*(y[-1]-y[0])/length:.1f} %, max 100 m grade {g100.max():.1f} %, min {g100.min():.1f} %")

    repo = Path(args.repo)
    route = {"name": args.name, "points": points, "closed": False, "world": args.id}
    (repo / "crates/core/routes" / f"{args.id}.json").write_text(json.dumps(route, separators=(",", ":")))

    def heightmap(center_x, center_z, half_w, half_h, spacing, suffix):
        lat_max, lon_min = to_latlon(center_x - half_w, center_z - half_h)
        lat_min, lon_max = to_latlon(center_x + half_w, center_z + half_h)
        lats, lons, grid = dem.grid(lat_min, lat_max, lon_min, lon_max, spacing, lat_ref)
        x0, z0 = to_xz(lats[0], lons[0])
        (repo / "ui/public/worlds" / f"{args.id}-{suffix}.bin").write_bytes(struct.pack(f"<{grid.size}f", *grid.flatten().tolist()))
        print(f"{suffix}: {grid.shape[1]}x{grid.shape[0]} at {spacing} m, {grid.min():.0f}..{grid.max():.0f} m")
        return {"file": f"/worlds/{args.id}-{suffix}.bin", "cols": int(grid.shape[1]), "rows": int(grid.shape[0]), "x0": round(x0, 1), "z0": round(z0, 1), "spacing": spacing}

    xs, zs = xz[:, 0], xz[:, 1]
    cx, cz = float((xs.max() + xs.min()) / 2), float((zs.max() + zs.min()) / 2)
    near = heightmap(cx, cz, (xs.max() - xs.min()) / 2 + args.near_margin, (zs.max() - zs.min()) / 2 + args.near_margin, args.near_spacing, "near")
    far = heightmap(cx, cz, args.far_size / 2, args.far_size / 2, args.far_spacing, "far")
    meta = {
        "id": args.id,
        "name": args.name,
        "origin": {"lat": lat_ref, "lon": lon_ref},
        "near": near,
        "far": far,
        "attribution": "Road data © OpenStreetMap contributors (ODbL). Elevation: Copernicus DEM GLO-30 © ESA.",
    }
    (repo / "ui/public/worlds" / f"{args.id}.json").write_text(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
