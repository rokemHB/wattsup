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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_route import EARTH_LAT_M, EARTH_LON_M, Dem, Ortho, mercator_tile  # noqa: E402

SPACING = 10.0
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


def resample(xz, spacing):
    """Points every `spacing` metres along a polyline (linear), keeping the end."""
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--osm", required=True)
    ap.add_argument("--dem-dir", required=True)
    ap.add_argument("--dem", nargs="+", required=True, help="Copernicus tiles for the far layer")
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--repo", default=str(Path(__file__).resolve().parent.parent))
    ap.add_argument("--far", default="39.25,40.0,2.3,3.5", help="lat_min,lat_max,lon_min,lon_max of the far layer")
    ap.add_argument("--far-spacing", type=float, default=150.0)
    ap.add_argument("--ortho", action="store_true")
    ap.add_argument("--cache", default=str(Path.home() / ".cache/wattsup/tiles"))
    args = ap.parse_args()
    repo = Path(args.repo)

    osm = json.load(open(args.osm))
    ways = [e for e in osm["elements"] if e["type"] == "way" and e["tags"].get("highway") in ROAD_KINDS]
    places = [e for e in osm["elements"] if e["type"] == "node" and "place" in e.get("tags", {})]
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
    key = lambda t: (t.get("ref"), t.get("name"), t.get("highway"))
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

    # Geometry and elevation per edge.
    dem = DemChunks(args.dem_dir)
    points = []
    edges_out = []
    missing = 0
    for nodes, tags in merged:
        xz = np.array([to_xz(*coords[n]) for n in nodes])
        if len(xz) < 2:
            continue
        pts = resample(xz, SPACING)
        ll = np.array([to_latlon(x, z) for x, z in pts])
        y = dem.sample_many(ll[:, 0], ll[:, 1])
        if np.isnan(y).any():
            missing += int(np.isnan(y).sum())
            y = np.where(np.isnan(y), np.nanmean(y) if not np.isnan(y).all() else 0.0, y)
        y = smooth(y, 3)
        # Cap the grade: a 5 m surface model is off on stacked hairpins.
        step = np.clip(np.diff(y), -0.2 * SPACING, 0.2 * SPACING)
        y = np.concatenate([[y[0]], y[0] + np.cumsum(step)])
        if len(y) > 1:
            y += np.linspace(0, float(smooth(dem.sample_many(ll[-1:, 0], ll[-1:, 1]), 0)[0] - y[-1]) if False else 0, len(y))
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
        while heap and len(found) < want:
            d, n = heapq.heappop(heap)
            if d > dist.get(n, math.inf) or d > limit_m:
                continue
            for pi in node_places.get(n, []):
                if pi not in seen and (not found or place_list[pi]["kind"] != "hamlet"):
                    seen.add(pi)
                    found.append(pi)
            for m, w, ei in adj[n]:
                if n == start_node and ei == via_edge:
                    continue
                nd = d + w
                if nd < dist.get(m, math.inf):
                    dist[m] = nd
                    heapq.heappush(heap, (nd, m))
        return [place_list[pi]["name"] for pi in found[:want]]

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
                dests = destinations(m, ei)
            signs.append({"edge": ei, "ref": e["ref"] or e["destination_ref"], "to": dests})
        n["signs"] = signs

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
    print("world metadata written")


if __name__ == "__main__":
    main()
