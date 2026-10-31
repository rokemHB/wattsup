#!/usr/bin/env python3
"""Builds a road network for riding anywhere in a region: every road from an
Overpass extract as a graph with 10 m sampled geometry and elevation, sign
destinations at junctions from OSM tags and nearby towns, plus the static
far layer (coarse terrain and imagery of the whole island) and the map image.

Inputs:
  --osm        Overpass JSON (`out geom;`) with highway ways and place nodes
  --dem-dir    directory of 5 m GeoTIFF chunks (fetch_dem.py), EPSG:4326
  --dem        Copernicus GLO-30 tiles for the far layer (one or more)
Outputs:
  crates/core/worlds/<id>/network.json   graph: nodes, edges (ref, name, point range, length, signs)
  crates/core/worlds/<id>/network.bin    float32 x,y,z per point
  ui/public/worlds/<id>.json             world metadata (origin, far grid, tile scheme)
  ui/public/worlds/<id>-far.bin          far heightmap
  ui/public/worlds/<id>/ortho-far-0-0.jpg, map.jpg, detail-*.jpg

Data: © OpenStreetMap contributors (ODbL); IGN España MDT05 and PNOA (CC BY 4.0); Copernicus DEM © ESA.
"""
import argparse
import collections
import heapq
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_route import EARTH_LAT_M, EARTH_LON_M, Dem, DemStack, Ortho, mercator_tile  # noqa: E402

SPACING = 5.0
# Roundabouts drawn as circles: smaller ones are mini-roundabouts painted on a junction, larger ones not roundabouts.
ROUNDABOUT_MIN_R = 6.0
ROUNDABOUT_MAX_R = 80.0
MAX_GRADE = 0.14
ROAD_KINDS = {"primary": 0, "secondary": 1, "tertiary": 2, "unclassified": 3, "primary_link": 1, "secondary_link": 2, "tertiary_link": 3}


class DemChunks:
    """The 5 m model as many chunk files, opened on demand."""

    STEP = 0.05

    def __init__(self, directory):
        self.files = {}
        for f in Path(directory).glob("dem5_*.tif"):
            _, lat, lon = f.stem.split("_")
            self.files[(round(float(lat), 2), round(float(lon), 2))] = f
        if not self.files:
            raise SystemExit(f"no dem5_*.tif chunks in {directory}")
        # The chunk lattice starts wherever fetch_dem.py started, not at multiples of the step.
        self.lat_base = min(k[0] for k in self.files)
        self.lon_base = min(k[1] for k in self.files)
        self.open = {}

    def key(self, lat, lon):
        i = math.floor((lat - self.lat_base) / self.STEP + 1e-9)
        j = math.floor((lon - self.lon_base) / self.STEP + 1e-9)
        return (round(self.lat_base + i * self.STEP, 2), round(self.lon_base + j * self.STEP, 2))

    def chunk(self, lat, lon):
        key = self.key(lat, lon)
        if key not in self.open:
            f = self.files.get(key)
            self.open[key] = Dem(f) if f else None
        return self.open[key]

    def sample_many(self, lats, lons):
        out = np.full(len(lats), np.nan)
        groups = collections.defaultdict(list)
        for i, (lat, lon) in enumerate(zip(lats, lons)):
            groups[self.key(lat, lon)].append(i)
        for key, idx in groups.items():
            dem = self.chunk(key[0] + 0.001, key[1] + 0.001)
            if dem is None:
                continue
            arr = np.array(idx)
            v = dem.sample_many(np.asarray(lats)[arr], np.asarray(lons)[arr])
            # Chunk edges: a sample right at the border may fall outside this chunk's pixels.
            miss = np.isnan(v)
            if miss.any():
                for j in arr[miss]:
                    for dlat, dlon in ((0.0, 0.0), (-0.01, 0), (0.01, 0), (0, -0.01), (0, 0.01)):
                        d2 = self.chunk(lats[j] + dlat, lons[j] + dlon)
                        if d2 is not None:
                            w = d2.sample(lats[j], lons[j])
                            if not math.isnan(w):
                                out[j] = w
                                break
            out[arr[~miss]] = v[~miss]
        return out


def smooth(values, half):
    if half <= 0 or len(values) < 3:
        return values
    k = 2 * half + 1
    padded = np.pad(values, half, mode="edge")
    return np.convolve(padded, np.ones(k) / k, mode="valid")


def spline(xz, step=1.0):
    """A centripetal Catmull-Rom curve through the mapped points, densified to about `step` metres,
    so a road bends instead of kinking at every mapped node."""
    pts = [p for i, p in enumerate(xz) if i == 0 or np.linalg.norm(p - xz[i - 1]) > 0.5]
    if len(pts) < 3:
        return np.array(pts)
    pts = np.array(pts)
    padded = np.vstack([pts[0] + (pts[0] - pts[1]), pts, pts[-1] + (pts[-1] - pts[-2])])
    out = [pts[0]]
    for i in range(1, len(padded) - 2):
        p0, p1, p2, p3 = padded[i - 1], padded[i], padded[i + 1], padded[i + 2]
        n = max(2, int(np.ceil(np.linalg.norm(p2 - p1) / step)))
        # Centripetal parametrisation: no loops or overshoot on uneven spacing.
        t0 = 0.0
        t1 = t0 + np.linalg.norm(p1 - p0) ** 0.5
        t2 = t1 + np.linalg.norm(p2 - p1) ** 0.5
        t3 = t2 + np.linalg.norm(p3 - p2) ** 0.5
        if t1 == t0 or t2 == t1 or t3 == t2:
            out.append(p2)
            continue
        for k in range(1, n + 1):
            t = t1 + (t2 - t1) * k / n
            a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
            a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
            a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
            b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
            b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
            out.append((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2)
    return np.array(out)


def roundabout_rings(ways, to_xz, to_latlon, coords):
    """Fits a circle to every roundabout (OSM ways tagged junction=roundabout, joined
    end to end into rings) and moves its nodes onto it. Returns {node: (centre, radius)}.

    Each piece of a roundabout between two junctions is its own edge, and splined on its
    own it cut the corners at every entry: a polygon of kinks instead of a ring. Rings
    that are not round (a few long one-way loops are tagged roundabout too) are left alone."""
    pieces = [w for w in ways if w["tags"].get("junction") in ("roundabout", "circular")]
    parent = list(range(len(pieces)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    by_node = {}
    for i, w in enumerate(pieces):
        for n in w["nodes"]:
            if n in by_node:
                parent[find(i)] = find(by_node[n])
            else:
                by_node[n] = i
    groups = collections.defaultdict(set)
    for i, w in enumerate(pieces):
        groups[find(i)].update(w["nodes"])
    rings = {}
    for nodes in groups.values():
        xz = np.array([to_xz(*coords[n]) for n in nodes])
        if len(xz) < 5:
            continue
        # Algebraic least-squares circle: x^2 + z^2 + D x + E z + F = 0.
        A = np.column_stack([xz, np.ones(len(xz))])
        D, E, F = np.linalg.lstsq(A, -(xz ** 2).sum(axis=1), rcond=None)[0]
        centre = np.array([-D / 2, -E / 2])
        r2 = centre @ centre - F
        if r2 <= 0:
            continue
        r = math.sqrt(r2)
        dev = np.abs(np.linalg.norm(xz - centre, axis=1) - r)
        if not (ROUNDABOUT_MIN_R <= r <= ROUNDABOUT_MAX_R) or dev.max() > 0.25 * r:
            continue
        ring = (centre, r)
        for n in nodes:
            d = np.array(to_xz(*coords[n])) - centre
            coords[n] = to_latlon(*(centre + d / np.linalg.norm(d) * r))
            rings[n] = ring
    return rings


def arc(xz, centre, r, spacing):
    """Points every `spacing` metres on the circle from the first to the last of `xz`, the way they go round."""
    ang = np.arctan2(xz[:, 1] - centre[1], xz[:, 0] - centre[0])
    sweep = np.diff(ang)
    sweep = (sweep + np.pi) % (2 * np.pi) - np.pi
    total = float(sweep.sum())
    if abs(total) < 1e-6 and len(xz) > 2:
        total = 2 * np.pi * np.sign(sweep.sum() or 1.0)
    n = max(1, int(round(abs(total) * r / spacing)))
    t = ang[0] + total * np.arange(n + 1) / n
    return np.column_stack([centre[0] + r * np.cos(t), centre[1] + r * np.sin(t)])


def grade_limited(y, step):
    """`y` with no rise or fall of more than `step` a point, staying centred on it; its two
    ends stay where they are.

    Clipped steps used to be summed from the start: where the ground fell faster than the
    cap (the cliff below the Mirador on the Formentor road), and wherever the 5 m model's
    samples on a cliff road jumped more than it, the deficit was carried on along the edge
    and the road floated up to 80 m above the ground for 10 km. Now: the mean of the lowest
    profile within the cap that stays above `y` and the highest that stays below it (each
    within the cap, so their mean is too, and it runs through the middle of the ground's
    bumps), then the ends set back and the steps next to them evened out."""
    y = np.array(y, dtype=float)
    ends = (y[0], y[-1])
    up = y.copy()
    lo = y.copy()
    for i in range(1, len(y)):
        up[i] = min(up[i], up[i - 1] + step)
        lo[i] = max(lo[i], lo[i - 1] - step)
    for i in range(len(y) - 2, -1, -1):
        up[i] = min(up[i], up[i + 1] + step)
        lo[i] = max(lo[i], lo[i + 1] - step)
    # up is the highest profile within the cap below y, lo the lowest above it.
    y = (up + lo) / 2
    y[0], y[-1] = ends

    def settle(seg, fix_first, fix_last):
        # Relaxation near a pinned end: each too-steep step shares out its excess, the pin holds.
        a, b = seg[0], seg[-1]
        for _ in range(20000):
            d = np.diff(seg)
            excess = np.sign(d) * np.maximum(np.abs(d) - step, 0.0)
            if np.abs(excess).max() < 1e-3:
                break
            seg[:-1] += excess * 0.5
            seg[1:] -= excess * 0.5
            if fix_first:
                seg[0] = a
            if fix_last:
                seg[-1] = b
        return seg

    k = min(300, len(y))
    y[:k] = settle(y[:k].copy(), True, False)
    y[-k:] = settle(y[-k:].copy(), False, True)
    return y

def resample(xz, spacing):
    """Points every `spacing` metres along the splined polyline, keeping the end."""
    xz = spline(xz)
    out = [xz[0]]
    travelled = 0.0
    nxt = spacing
    for a, b in zip(xz, xz[1:]):
        seg = float(np.linalg.norm(b - a))
        while seg > 0 and travelled + seg >= nxt:
            t = (nxt - travelled) / seg
            out.append(a + (b - a) * t)
            nxt += spacing
        travelled += seg
    if np.linalg.norm(out[-1] - xz[-1]) > 1.0:
        out.append(xz[-1])
    return np.array(out)


def way_length_m(way):
    g = way["geometry"]
    lat = math.radians(g[0]["lat"])
    return sum(math.hypot((b["lon"] - a["lon"]) * EARTH_LON_M * math.cos(lat), (b["lat"] - a["lat"]) * EARTH_LAT_M) for a, b in zip(g, g[1:]))


SEA_COLOUR = np.array([70, 74, 85])


def harmonise_sea(px):
    """Pulls the photographed sea toward one colour, so the survey's edge does not show as a lighter band.

    The imagery's open sea is a flat grey; where the tiles end, the painted sea
    beyond is a darker blue, and the step between them draws the footprint of the
    survey over the water. Grey-blue pixels of sea brightness are blended to the
    painted colour, keeping a little of their wave texture; shallow turquoise
    water near the beaches is more saturated and stays as it is.
    """
    p = px.astype(np.float32)
    r, g, b = p[..., 0], p[..., 1], p[..., 2]
    sat = p.max(axis=2) - p.min(axis=2)
    value = p.mean(axis=2)
    w = np.clip(1 - (sat - 9) / 9, 0, 1) * np.clip(1 - (np.abs(value - 95) - 15) / 10, 0, 1) * (b >= r - 2)
    grey = np.median(p[w > 0.9], axis=0) if (w > 0.9).any() else SEA_COLOUR
    out = SEA_COLOUR + 0.3 * (p - grey)
    p = p + w[..., None] * (out - p)
    return np.clip(p, 0, 255).astype(np.uint8)


def select_roads(ways, refs):
    """The ways carrying one of `refs`, plus the ref-less roundabouts and short links that connect them.

    Roundabouts and slip roads in OSM usually carry no ref, and two climbs
    often meet through a few metres of a third road; without those pieces a
    whitelisted road breaks at every roundabout."""
    def refs_of(w):
        return {r.strip() for r in (w["tags"].get("ref") or "").split(";") if r.strip()}

    keep = [w for w in ways if refs_of(w) & refs]
    nodes = {n for w in keep for n in w["nodes"]}
    # Roundabouts and short pieces of any road join the whitelisted ones: the
    # few metres of another ref that tie two climbs together in a town.
    candidates = [w for w in ways if w["tags"].get("junction") == "roundabout" or way_length_m(w) < 400]
    for _ in range(3):
        added = False
        for w in candidates:
            if w in keep or not any(n in nodes for n in w["nodes"]):
                continue
            keep.append(w)
            nodes.update(w["nodes"])
            added = True
        if not added:
            break
    # Whitelisted roads that do not touch the main component get joined to it
    # along the shortest run of other roads (a few streets through a town);
    # what cannot be joined within 6 km is dropped.
    parent = {}

    def find(a):
        while parent.get(a, a) != a:
            a = parent[a]
        return a

    def union_ways(ws):
        for w in ws:
            for n in w["nodes"][1:]:
                parent[find(n)] = find(w["nodes"][0])

    union_ways(keep)
    comp_len = collections.Counter()
    for w in keep:
        comp_len[find(w["nodes"][0])] += way_length_m(w)
    main_comp = comp_len.most_common(1)[0][0]
    # Node graph over every road, for the joins.
    adj = collections.defaultdict(list)
    way_of = {}
    for w in ways:
        g = w["geometry"]
        lat = math.radians(g[0]["lat"])
        for a, b, ga, gb in zip(w["nodes"], w["nodes"][1:], g, g[1:]):
            d = math.hypot((gb["lon"] - ga["lon"]) * EARTH_LON_M * math.cos(lat), (gb["lat"] - ga["lat"]) * EARTH_LAT_M)
            adj[a].append((b, d))
            adj[b].append((a, d))
            way_of[(a, b)] = way_of[(b, a)] = w
    kept_ids = {w["id"] for w in keep}
    for comp in [c for c in comp_len if c != main_comp]:
        inside = {n for w in keep if find(w["nodes"][0]) == comp for n in w["nodes"]}
        dist = {n: 0.0 for n in inside}
        prev = {}
        heap = [(0.0, n) for n in inside]
        heapq.heapify(heap)
        hit = None
        while heap:
            d, n = heapq.heappop(heap)
            if d > dist.get(n, math.inf) or d > 6000:
                continue
            if n not in inside and find(n) == find(main_comp):
                hit = n
                break
            for m, w in adj[n]:
                nd = d + w
                if nd < dist.get(m, math.inf):
                    dist[m] = nd
                    prev[m] = n
                    heapq.heappush(heap, (nd, m))
        if hit is None:
            continue
        path = [hit]
        while path[-1] in prev:
            path.append(prev[path[-1]])
        joined = []
        for a, b in zip(path, path[1:]):
            w = way_of[(a, b)]
            if w["id"] not in kept_ids:
                kept_ids.add(w["id"])
                keep.append(w)
                joined.append(w)
        union_ways(joined)
        names = sorted({w["tags"].get("ref") or w["tags"].get("name") or "?" for w in joined})
        print(f"joined a {comp_len[comp] / 1000:.1f} km component through {', '.join(names)} ({dist[hit]:.0f} m)")
    dropped = [w for w in keep if find(w["nodes"][0]) != find(main_comp)]
    if dropped:
        print(f"dropping {len(dropped)} disconnected ways ({sum(way_length_m(w) for w in dropped) / 1000:.1f} km)")
    return [w for w in keep if find(w["nodes"][0]) == find(main_comp)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--osm", required=True)
    ap.add_argument("--dem-dir", required=True)
    ap.add_argument("--dem", nargs="+", required=True, help="Copernicus tiles for the far layer")
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--repo", default=str(Path(__file__).resolve().parent.parent))
    ap.add_argument("--far", default="39.25,40.0,2.3,3.5", help="lat_min,lat_max,lon_min,lon_max of the far layer")
    ap.add_argument("--mid-spacing", type=float, default=45.0, help="metres between samples of the middle layer (build_mid.py); 0 for none")
    ap.add_argument("--far-spacing", type=float, default=150.0)
    ap.add_argument("--ortho", action="store_true")
    ap.add_argument("--cache", default=str(Path.home() / ".cache/wattsup/tiles"))
    ap.add_argument("--refs", help="comma-separated road refs to keep (plus the unnamed links and roundabouts that join them); default: every road")
    args = ap.parse_args()
    repo = Path(args.repo)

    osm = json.load(open(args.osm))
    ways = [e for e in osm["elements"] if e["type"] == "way" and e["tags"].get("highway") in ROAD_KINDS]
    # Long road tunnels (the Sóller tunnel) are closed to bicycles.
    ways = [w for w in ways if not (w["tags"].get("tunnel") == "yes" and way_length_m(w) >= 1000)]
    places = [e for e in osm["elements"] if e["type"] == "node" and "place" in e.get("tags", {})]
    if args.refs:
        ways = select_roads(ways, {r.strip() for r in args.refs.split(",") if r.strip()})
    print(f"{len(ways)} ways, {len(places)} places")

    # Local frame: origin at the centre of the roads' bounding box.
    lats = [g["lat"] for w in ways for g in w["geometry"]]
    lons = [g["lon"] for w in ways for g in w["geometry"]]
    lat_ref = (max(lats) + min(lats)) / 2
    lon_ref = (max(lons) + min(lons)) / 2
    kx = EARTH_LON_M * math.cos(math.radians(lat_ref))
    to_xz = lambda lat, lon: np.array([(lon - lon_ref) * kx, -(lat - lat_ref) * EARTH_LAT_M])
    to_latlon = lambda x, z: (lat_ref - z / EARTH_LAT_M, lon_ref + x / kx)

    # Junctions: OSM nodes used by more than one way, plus way ends.
    use = collections.Counter()
    for w in ways:
        for n in w["nodes"]:
            use[n] += 1
        use[w["nodes"][0]] += 1
        use[w["nodes"][-1]] += 1
    coords = {}
    for w in ways:
        for n, g in zip(w["nodes"], w["geometry"]):
            coords[n] = (g["lat"], g["lon"])
    rings = roundabout_rings(ways, to_xz, to_latlon, coords)
    print(f"{len(set(id(c) for c, _ in rings.values()))} roundabouts drawn as circles")

    # Raw edges: way pieces between junction nodes.
    raw_edges = []
    for w in ways:
        tags = w["tags"]
        piece = [w["nodes"][0]]
        for n in w["nodes"][1:]:
            piece.append(n)
            if use[n] > 1:
                raw_edges.append((piece, tags))
                piece = [n]
        if len(piece) > 1:
            raw_edges.append((piece, tags))

    # Merge chains through degree-2 nodes when the tags agree, so a road is one edge between junctions.
    degree = collections.Counter()
    for piece, _ in raw_edges:
        degree[piece[0]] += 1
        degree[piece[-1]] += 1
    by_end = collections.defaultdict(list)
    for i, (piece, _) in enumerate(raw_edges):
        by_end[piece[0]].append(i)
        by_end[piece[-1]].append(i)
    used = [False] * len(raw_edges)
    merged = []
    key = lambda t: (t.get("ref"), t.get("name"), t.get("highway"), t.get("tunnel") == "yes")
    for i, (piece, tags) in enumerate(raw_edges):
        if used[i]:
            continue
        used[i] = True
        nodes = list(piece)
        # Extend forward and backward through degree-2 nodes with the same road.
        for forward in (True, False):
            while True:
                end = nodes[-1] if forward else nodes[0]
                if degree[end] != 2:
                    break
                nxt = [j for j in by_end[end] if not used[j] and key(raw_edges[j][1]) == key(tags)]
                if not nxt:
                    break
                j = nxt[0]
                used[j] = True
                p = list(raw_edges[j][0])
                if p[0] != end:
                    p.reverse()
                if forward:
                    nodes += p[1:]
                else:
                    nodes = p[:-1] + nodes if p[-1] == end else list(reversed(p))[:-1] + nodes
                if nodes[0] == nodes[-1]:
                    break
        merged.append((nodes, tags))
    print(f"{len(raw_edges)} way pieces -> {len(merged)} edges")

    # Node table.
    node_ids = {}
    nodes_out = []
    for nodes, _ in merged:
        for n in (nodes[0], nodes[-1]):
            if n not in node_ids:
                node_ids[n] = len(nodes_out)
                lat, lon = coords[n]
                x, z = to_xz(lat, lon)
                nodes_out.append({"osm": n, "x": round(float(x), 1), "z": round(float(z), 1), "y": 0.0})

    # Geometry and elevation per edge: the 5 m model sampled every 10 m,
    # smoothed over 60 m with the grade capped; tunnels run straight between
    # their portals. Every junction gets one height, the mean of what its
    # edges see there, and each edge is pinned to its two junction heights so
    # the road never steps where edges meet.
    dem = DemChunks(args.dem_dir)
    coarse_dem = DemStack(args.dem)
    missing = 0
    prepared = []
    node_samples = collections.defaultdict(list)
    for nodes, tags in merged:
        xz = np.array([to_xz(*coords[n]) for n in nodes])
        if len(xz) < 2:
            continue
        ring = rings.get(nodes[0]) if tags.get("junction") in ("roundabout", "circular") else None
        if ring is not None and all(rings.get(n) is ring for n in nodes):
            # At least 48 points round: at 5 m a 9 m ring was an octagon.
            pts = arc(xz, ring[0], ring[1], min(SPACING, 2 * math.pi * ring[1] / 48))
        else:
            ring = None
            pts = resample(xz, SPACING)
        ll = np.array([to_latlon(x, z) for x, z in pts])
        y = dem.sample_many(ll[:, 0], ll[:, 1])
        if np.isnan(y).any():
            # Holes in the 5 m model (on the seams between its chunks): the 30 m model there,
            # shifted to meet the 5 m heights either side. They used to take the edge's mean
            # height, and the road dipped or rose up to 18 m for a few points at every seam.
            miss = np.isnan(y)
            missing += int(miss.sum())
            coarse = coarse_dem.sample_many(ll[:, 0], ll[:, 1])
            if miss.all():
                y = np.nan_to_num(coarse, nan=0.0)
            else:
                idx = np.arange(len(y))
                offset = np.interp(idx, idx[~miss], (y - np.nan_to_num(coarse, nan=0.0))[~miss])
                y = np.where(miss, np.nan_to_num(coarse, nan=0.0) + offset, y)
        tunnel = tags.get("tunnel") == "yes"
        y = smooth(y, 6)
        node_samples[node_ids[nodes[0]]].append(float(y[0]))
        node_samples[node_ids[nodes[-1]]].append(float(y[-1]))
        prepared.append((nodes, tags, pts, y, tunnel, ring))
    node_y = {ni: float(np.mean(v)) for ni, v in node_samples.items()}
    points = []
    edges_out = []
    for nodes, tags, pts, y, tunnel, ring in prepared:
        ya = node_y[node_ids[nodes[0]]]
        yb = node_y[node_ids[nodes[-1]]]
        # Roundabout pieces too: short, and sampled too densely for the 6-point smoothing to even out.
        if tunnel or ring is not None or len(y) < 3:
            y = np.linspace(ya, yb, len(y))
        else:
            # The ends pinned to the junctions first, then the grade evened out between them: a
            # correction spread linearly over the edge afterwards lifted 10 km of the Formentor
            # road 30 m into the air for a fix needed at one end.
            y[0], y[-1] = ya, yb
            y = grade_limited(y, MAX_GRADE * SPACING)
        start = len(points)
        for (x, z), h in zip(pts, y):
            points.append((float(x), float(h), float(z)))
        length = float(np.sum(np.linalg.norm(np.diff(pts, axis=0), axis=1)))
        edges_out.append({
            "a": node_ids[nodes[0]],
            "b": node_ids[nodes[-1]],
            "ref": tags.get("ref"),
            "name": tags.get("name"),
            "kind": ROAD_KINDS[tags.get("highway")],
            "start": start,
            "count": len(pts),
            "length_m": round(length, 1),
            "destination": tags.get("destination"),
            "destination_ref": tags.get("destination:ref"),
            "tunnel": tunnel,
            **({"ring": [round(float(ring[0][0]), 1), round(float(ring[0][1]), 1), round(ring[1], 1)]} if ring is not None else {}),
        })
    # Node heights from their edges.
    for e in edges_out:
        nodes_out[e["a"]]["y"] = round(points[e["start"]][1], 1)
        nodes_out[e["b"]]["y"] = round(points[e["start"] + e["count"] - 1][1], 1)
    print(f"{len(points)} points, {sum(e['length_m'] for e in edges_out) / 1000:.0f} km of road, {missing} points without elevation")

    # Places and sign destinations: for every edge end, the nearest towns reached along the graph.
    place_list = []
    for p in places:
        x, z = to_xz(p["lat"], p["lon"])
        place_list.append({"name": p["tags"].get("name", "?"), "kind": p["tags"]["place"], "x": round(float(x), 1), "z": round(float(z), 1)})
    rank = {"city": 0, "town": 1, "village": 2, "hamlet": 3}
    place_list.sort(key=lambda p: rank.get(p["kind"], 9))
    # Which places sit next to which node (within 700 m).
    node_places = collections.defaultdict(list)
    for pi, p in enumerate(place_list):
        for ni, n in enumerate(nodes_out):
            if math.hypot(n["x"] - p["x"], n["z"] - p["z"]) < 700:
                node_places[ni].append(pi)
    adj = collections.defaultdict(list)
    for ei, e in enumerate(edges_out):
        adj[e["a"]].append((e["b"], e["length_m"], ei))
        adj[e["b"]].append((e["a"], e["length_m"], ei))

    def destinations(start_node, via_edge, limit_m=25000.0, want=2):
        """Nearest towns along the graph from `start_node`, entering through `via_edge` (not back through it)."""
        dist = {start_node: 0.0}
        heap = [(0.0, start_node)]
        found = []
        seen = set()
        dist_at = {}
        while heap and len(found) < want:
            d, n = heapq.heappop(heap)
            if d > dist.get(n, math.inf) or d > limit_m:
                continue
            for pi in node_places.get(n, []):
                if pi not in seen and (not found or place_list[pi]["kind"] != "hamlet"):
                    seen.add(pi)
                    found.append(pi)
                    dist_at[pi] = d
            for m, w, ei in adj[n]:
                if n == start_node and ei == via_edge:
                    continue
                nd = d + w
                if nd < dist.get(m, math.inf):
                    dist[m] = nd
                    heapq.heappush(heap, (nd, m))
        return [(place_list[pi]["name"], dist_at[pi]) for pi in found[:want]]

    for ni, n in enumerate(nodes_out):
        if len(adj[ni]) < 3:
            continue
        signs = []
        for m, _w, ei in adj[ni]:
            e = edges_out[ei]
            dests = []
            if e["destination"]:
                dests = [d.strip() for d in e["destination"].split(";")][:2]
            if not dests:
                dests = [name for name, _d in destinations(m, ei)]
            signs.append({"edge": ei, "ref": e["ref"] or e["destination_ref"], "to": dests})
        n["signs"] = signs

    # Confirmation signs along the road: every 2 km or so on roads with a
    # number, "Sóller 7" for the next towns ahead, one per direction.
    for ei, e in enumerate(edges_out):
        if not e["ref"] or e["length_m"] < 1200 or e["tunnel"]:
            continue
        markers = []
        for toward_b in (True, False):
            end_node = e["b"] if toward_b else e["a"]
            dests = destinations(end_node, ei)
            if not dests:
                continue
            k = 0
            d = 900.0
            while d < e["length_m"] - 600:
                i = int(d / SPACING)
                # Distance to the town: from here to the edge end, then along the graph.
                rest = (e["length_m"] - d) if toward_b else d
                markers.append({"at": i, "toward_b": toward_b, "to": [[name, round((rest + dd) / 1000, 1)] for name, dd in dests[:2]]})
                d += 2300.0
                k += 1
        if markers:
            e["markers"] = markers

    out_core = repo / "crates/core/worlds" / args.id
    out_core.mkdir(parents=True, exist_ok=True)
    (out_core / "network.bin").write_bytes(struct.pack(f"<{len(points) * 3}f", *[c for p in points for c in p]))
    (out_core / "network.json").write_text(json.dumps({
        "name": args.name,
        "origin": {"lat": lat_ref, "lon": lon_ref},
        "nodes": nodes_out,
        "edges": edges_out,
        "places": place_list,
        "points": len(points),
    }, separators=(",", ":")))
    print(f"network: {len(nodes_out)} nodes, {len(edges_out)} edges, {sum(1 for n in nodes_out if 'signs' in n)} junctions with signs")

    # Far layer: the whole island, coarse.
    lat_min, lat_max, lon_min, lon_max = map(float, args.far.split(","))
    dems = [Dem(d) for d in args.dem]
    dlat = args.far_spacing / EARTH_LAT_M
    dlon = args.far_spacing / kx
    flats = np.arange(lat_max, lat_min, -dlat)
    flons = np.arange(lon_min, lon_max, dlon)
    glat, glon = np.meshgrid(flats, flons, indexing="ij")
    far = np.full(glat.size, np.nan)
    for d in dems:
        v = d.sample_many(glat.ravel(), glon.ravel())
        far = np.where(np.isnan(far), v, far)
    far = np.nan_to_num(far, nan=0.0).astype(np.float32).reshape(glat.shape)
    out_ui = repo / "ui/public/worlds"
    (out_ui / f"{args.id}-far.bin").write_bytes(far.tobytes())
    x0, z0 = to_xz(flats[0], flons[0])
    far_meta = {"file": f"/worlds/{args.id}-far.bin", "cols": int(far.shape[1]), "rows": int(far.shape[0]), "x0": round(float(x0), 1), "z0": round(float(z0), 1), "spacing": args.far_spacing}
    print(f"far: {far.shape[1]}x{far.shape[0]} at {args.far_spacing} m")

    world_dir = out_ui / args.id
    world_dir.mkdir(parents=True, exist_ok=True)
    if args.ortho:
        ortho = Ortho(args.cache)
        img = ortho.image(lat_min, lat_max, lon_min, lon_max, 11, 2048)
        img.save(world_dir / "ortho-far-0-0.jpg", quality=82, optimize=True)
        far_meta["ortho"] = {"rowEdges": [0, far.shape[0] - 1], "colEdges": [0, far.shape[1] - 1], "size": 2048, "files": [[f"/worlds/{args.id}/ortho-far-0-0.jpg"]]}
        img = ortho.image(lat_min, lat_max, lon_min, lon_max, 12, 2560)
        # Open sea has no tiles at this zoom and comes out black; paint it the colour of the sea that is there.
        px = np.asarray(img.convert("RGB")).astype(np.int16)
        missing = px.max(axis=2) < 45
        sea = ~missing & (px[..., 2] > px[..., 0] + 8) & (px[..., 2] > 40) & (px[..., 2] < 120)
        if sea.any():
            px[missing] = np.median(px[sea], axis=0).astype(np.int16)
        img = Image.fromarray(harmonise_sea(px.astype(np.uint8)))
        img.save(world_dir / "map.jpg", quality=84, optimize=True)
        print("far ortho and map written")

    meta = {
        "id": args.id,
        "name": args.name,
        "origin": {"lat": lat_ref, "lon": lon_ref},
        "network": True,
        "far": far_meta,
        "map": {"file": f"/worlds/{args.id}/map.jpg", "lat_min": lat_min, "lat_max": lat_max, "lon_min": lon_min, "lon_max": lon_max} if args.ortho else None,
        "tiles": {
            "dlat": 0.02,
            "dlon": 0.025,
            "dem": "https://servicios.idee.es/wcs-inspire/mdt?service=WCS&request=GetCoverage&version=2.0.1&coverageId=Elevacion4258_5&subset=Lat({lat0},{lat1})&subset=Long({lon0},{lon1})&format=image/tiff",
            "ortho": "https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetTile&version=1.0.0&layer=OI.OrthoimageCoverage&style=default&format=image/jpeg&tilematrixset=GoogleMapsCompatible&tilematrix={z}&tilerow={y}&tilecol={x}",
            "orthoZoom": 16,
        },
        "attribution": "Road data © OpenStreetMap contributors (ODbL). Elevation: IGN España MDT05 (CC BY 4.0) and Copernicus DEM GLO-30 © ESA. Aerial imagery: PNOA © IGN España (CC BY 4.0).",
    }
    (out_ui / f"{args.id}.json").write_text(json.dumps(meta, indent=1))
    if args.mid_spacing > 0:
        from build_mid import write_mid

        write_mid(repo, args.id, args.dem, args.mid_spacing)
    print("world metadata written")


if __name__ == "__main__":
    main()
