#!/usr/bin/env python3
"""Builds a real-world route and its terrain from OpenStreetMap and the Copernicus DEM.

Inputs:
  --osm       Overpass JSON (`out geom;`) with the road's ways
  --dem       Copernicus GLO-30 COG GeoTIFF covering the wide area (1 arcsec, pixel-is-point)
  --dem-fine  optional finer GeoTIFF in EPSG:4326 for the route and the near grid, e.g.
              Spain's IGN 5 m model from the IDEE WCS (see README)
  --ortho     also fetch aerial imagery (Spain's PNOA through the IGN WMTS) as
              textures aligned to the terrain grids
Outputs (in the repo):
  crates/core/routes/<id>.json          route for the Rust core (distance, x, y, z every 5 m)
  ui/public/worlds/<id>.json            world metadata (origin, grids, textures)
  ui/public/worlds/<id>-near.bin        float32 heightmap, 10 m spacing, around the route
  ui/public/worlds/<id>-far.bin         float32 heightmap, 150 m spacing, wide area
  ui/public/worlds/<id>/ortho-*.jpg     orthophoto textures (with --ortho)

Local frame: x east, z south (so +x/+z is a right-handed frame with y up), metres,
origin at the route's bounding-box centre. Elevations are metres above sea level.

Data: © OpenStreetMap contributors (ODbL); Copernicus DEM © ESA / Airbus (free use with attribution).
"""
import argparse
import heapq
import io
import json
import math
import struct
import time
import urllib.request
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
    """A GeoTIFF elevation grid in geographic coordinates (EPSG:4326 / 4258)."""

    def __init__(self, path):
        with tifffile.TiffFile(path) as t:
            page = t.pages[0]
            tie = page.tags["ModelTiepointTag"].value
            scale = page.tags["ModelPixelScaleTag"].value
            keys = page.tags["GeoKeyDirectoryTag"].value
            nodata = page.tags.get("GDAL_NODATA")
            self.lon0, self.lat0 = tie[3], tie[4]
            self.dlon, self.dlat = scale[0], scale[1]
            # GTRasterTypeGeoKey (1025): 1 = PixelIsArea (tie point is the pixel corner), 2 = PixelIsPoint.
            raster_type = next((keys[i + 3] for i in range(4, len(keys), 4) if keys[i] == 1025), 1)
            if raster_type == 1:
                self.lon0 += self.dlon / 2
                self.lat0 -= self.dlat / 2
            self.data = page.asarray().astype(np.float32)
            if nodata is not None:
                self.data[self.data == float(nodata.value)] = np.nan
        self.rows, self.cols = self.data.shape

    def sample_many(self, lats, lons):
        """Bilinear elevation for arrays of coordinates; NaN outside the grid."""
        lats = np.asarray(lats, dtype=np.float64)
        lons = np.asarray(lons, dtype=np.float64)
        r = (self.lat0 - lats) / self.dlat
        c = (lons - self.lon0) / self.dlon
        r0 = np.floor(r).astype(np.int64)
        c0 = np.floor(c).astype(np.int64)
        inside = (r0 >= 0) & (c0 >= 0) & (r0 + 1 < self.rows) & (c0 + 1 < self.cols)
        r0c = np.clip(r0, 0, self.rows - 2)
        c0c = np.clip(c0, 0, self.cols - 2)
        fr = r - r0
        fc = c - c0
        d = self.data
        v = (d[r0c, c0c] * (1 - fr) + d[r0c + 1, c0c] * fr) * (1 - fc) + (d[r0c, c0c + 1] * (1 - fr) + d[r0c + 1, c0c + 1] * fr) * fc
        return np.where(inside, v, np.nan)

    def sample(self, lat, lon):
        return float(self.sample_many([lat], [lon])[0])

    def covers(self, lat, lon):
        return not math.isnan(self.sample(lat, lon))

    def grid(self, lat_min, lat_max, lon_min, lon_max, spacing_m, lat_ref, fallback=None):
        """Heightmap rows from north to south, columns west to east, at `spacing_m`.

        Cells outside this grid come from `fallback` (another Dem), else 0."""
        dlat = spacing_m / EARTH_LAT_M
        dlon = spacing_m / (EARTH_LON_M * math.cos(math.radians(lat_ref)))
        lats = np.arange(lat_max, lat_min - 1e-12, -dlat)
        lons = np.arange(lon_min, lon_max + 1e-12, dlon)
        glat, glon = np.meshgrid(lats, lons, indexing="ij")
        out = self.sample_many(glat.ravel(), glon.ravel())
        if fallback is not None:
            missing = np.isnan(out)
            if missing.any():
                out[missing] = fallback.sample_many(glat.ravel()[missing], glon.ravel()[missing])
        out = np.nan_to_num(out, nan=0.0).astype(np.float32).reshape(glat.shape)
        return lats, lons, out


class DemStack(Dem):
    """Several DEM files read as one: the first that has a value at a point wins."""

    def __init__(self, paths):  # noqa: D107 — no single file to open
        self.dems = [Dem(p) for p in paths]

    def sample_many(self, lats, lons):
        out = np.full(np.shape(lats), np.nan)
        for d in self.dems:
            v = d.sample_many(lats, lons)
            out = np.where(np.isnan(out), v, out)
        return out


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
    if any(math.isnan(v) for v in elev.values()):
        raise SystemExit("the DEM does not cover all road endpoints")
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


WMTS = (
    "https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetTile&version=1.0.0&layer=OI.OrthoimageCoverage"
    "&style=default&format=image/jpeg&tilematrixset=GoogleMapsCompatible&tilematrix={z}&tilerow={y}&tilecol={x}"
)
TILE = 256


def mercator_tile(lat, lon, z):
    """Fractional Web Mercator tile coordinates."""
    n = 2**z
    x = (lon + 180.0) / 360.0 * n
    phi = math.radians(lat)
    y = (1.0 - math.log(math.tan(phi) + 1.0 / math.cos(phi)) / math.pi) / 2.0 * n
    return x, y


class Ortho:
    """Aerial imagery from a Web Mercator tile service, cut to geographic boxes."""

    def __init__(self, cache):
        self.cache = Path(cache)
        self.cache.mkdir(parents=True, exist_ok=True)

    def tile(self, z, x, y):
        from PIL import Image

        f = self.cache / f"{z}_{x}_{y}.jpg"
        if not f.exists():
            req = urllib.request.Request(WMTS.format(z=z, x=x, y=y), headers={"User-Agent": "WattsUp route builder"})
            for attempt in range(10):
                try:
                    with urllib.request.urlopen(req, timeout=60) as r:
                        f.write_bytes(r.read())
                    break
                except Exception:  # noqa: BLE001  (the IGN tile server answers 502 now and then)
                    if attempt == 9:
                        raise
                    time.sleep(min(30.0, 1.5 * 2**attempt))
            time.sleep(0.05)
        return Image.open(f).convert("RGB")

    def image(self, lat_min, lat_max, lon_min, lon_max, z, size):
        """A `size`x`size` image of the box, north up, lat/lon-aligned (locally indistinguishable from Mercator)."""
        from PIL import Image

        x0, y0 = mercator_tile(lat_max, lon_min, z)
        x1, y1 = mercator_tile(lat_min, lon_max, z)
        tx0, ty0, tx1, ty1 = int(math.floor(x0)), int(math.floor(y0)), int(math.floor(x1)), int(math.floor(y1))
        mosaic = Image.new("RGB", ((tx1 - tx0 + 1) * TILE, (ty1 - ty0 + 1) * TILE))
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                mosaic.paste(self.tile(z, tx, ty), ((tx - tx0) * TILE, (ty - ty0) * TILE))
        box = ((x0 - tx0) * TILE, (y0 - ty0) * TILE, (x1 - tx0) * TILE, (y1 - ty0) * TILE)
        return mosaic.transform((size, size), Image.Transform.EXTENT, box, Image.Resampling.BILINEAR)


def detail_textures(near, ortho, ortho_dir, args, lats_for=None):
    """Close-up detail textures from the imagery itself: a patch of bare rock
    and a patch of scrub near the route, fetched at the highest zoom (about
    10 cm per pixel) so the renderer can tile real surface over the photo."""
    import numpy as np
    from PIL import Image

    o = near["ortho"]
    best_rock, best_scrub = None, None
    block_px = 48
    for br, row in enumerate(o["files"]):
        for bc, f in enumerate(row):
            img = np.asarray(Image.open(ortho_dir.parent.parent / f.lstrip("/")).convert("RGB"), dtype=np.float32) / 255
            size = img.shape[0]
            for py in range(0, size - block_px, block_px):
                for px in range(0, size - block_px, block_px):
                    patch = img[py : py + block_px, px : px + block_px]
                    mean = patch.mean(axis=(0, 1))
                    green = mean[1] - max(mean[0], mean[2])
                    std = float(patch.std())
                    bright = float(mean.mean())
                    rock = bright - 2.5 * std - 6 * max(green, 0)
                    scrub = green * 4 + 0.3 * std - abs(bright - 0.3)
                    loc = (br, bc, py + block_px / 2, px + block_px / 2, size)
                    if bright > 0.35 and (best_rock is None or rock > best_rock[0]):
                        best_rock = (rock, loc)
                    if best_scrub is None or scrub > best_scrub[0]:
                        best_scrub = (scrub, loc)

    def fetch(loc, name):
        br, bc, py, px, size = loc
        r0, r1 = o["rowEdges"][br], o["rowEdges"][br + 1]
        c0, c1 = o["colEdges"][bc], o["colEdges"][bc + 1]
        # Block pixel -> grid vertex -> world -> lat/lon.
        gx = near["x0"] + (c0 + (c1 - c0) * px / size) * near["spacing"]
        gz = near["z0"] + (r0 + (r1 - r0) * py / size) * near["spacing"]
        lat, lon = lats_for(gx, gz)
        half_lat = 55 / EARTH_LAT_M
        half_lon = 55 / (EARTH_LON_M * math.cos(math.radians(lat)))
        img = ortho.image(lat - half_lat, lat + half_lat, lon - half_lon, lon + half_lon, args.ortho_zoom + 3, 1024)
        img.save(ortho_dir / name, quality=85, optimize=True)
        print(f"  {name}: 110 m patch at {lat:.5f}, {lon:.5f}")
        return f"/worlds/{args.id}/{name}"

    return {"rock": fetch(best_rock[1], "detail-rock.jpg"), "scrub": fetch(best_scrub[1], "detail-scrub.jpg"), "metres": 110}


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


def bridge_crossings(xz, y, min_gap=20, max_dist_m=12.0, span=9):
    """Where the road crosses over itself, carry the higher section straight across.

    A terrain model shows the ground under a bridge, so the upper road dips
    toward the lower one there. Samples of the higher section within `span`
    samples of a crossing are replaced by a line between the ends of that
    stretch. Returns the new elevations and the crossings found."""
    y = y.copy()
    n = len(y)
    crossings = []
    i = 0
    while i < n:
        hit = None
        for j in range(i + min_gap, n):
            if abs(xz[i][0] - xz[j][0]) + abs(xz[i][1] - xz[j][1]) > 2 * max_dist_m:
                continue
            if np.hypot(xz[i][0] - xz[j][0], xz[i][1] - xz[j][1]) < max_dist_m:
                hit = j
                break
        if hit is None:
            i += 1
            continue
        upper = i if y[i] > y[hit] else hit
        a, b = max(upper - span, 0), min(upper + span, n - 1)
        y[a : b + 1] = np.linspace(y[a], y[b], b - a + 1)
        crossings.append((i, hit, float(abs(y[i] - y[hit]))))
        i += span
    return y, crossings


def smooth(values, half_window):
    k = 2 * half_window + 1
    padded = np.pad(values, half_window, mode="edge")
    return np.convolve(padded, np.ones(k) / k, mode="valid")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--osm", required=True)
    ap.add_argument("--dem", required=True)
    ap.add_argument("--dem-fine", nargs="*", help="5 m GeoTIFFs (several when the route spans more than one WCS request)")
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--repo", default=str(Path(__file__).resolve().parent.parent))
    ap.add_argument("--near-margin", type=float, default=2500.0, help="metres around the route in the near heightmap")
    ap.add_argument("--near-spacing", type=float, default=10.0)
    ap.add_argument("--band-margin", type=float, default=300.0, help="metres around the route in the fine band")
    ap.add_argument("--band-spacing", type=float, default=5.0)
    ap.add_argument("--far-size", type=float, default=36000.0)
    ap.add_argument("--far-spacing", type=float, default=150.0)
    ap.add_argument("--ortho", action="store_true", help="fetch PNOA aerial imagery as terrain textures (Spain)")
    ap.add_argument("--ortho-zoom", type=int, default=16, help="Web Mercator zoom for the near textures (16 is about 1.8 m/px)")
    ap.add_argument("--ortho-blocks", type=int, default=4, help="split the near grid into N x N textured blocks")
    ap.add_argument("--cache", default=str(Path.home() / ".cache/wattsup/tiles"), help="tile cache directory")
    ap.add_argument("--cut-at-top", action="store_true", help="end the route at its highest point (a climb)")
    ap.add_argument("--smooth", type=int, default=12, help="elevation smoothing half-window in 5 m samples")
    ap.add_argument("--max-grade", type=float, default=14.0, help="cap on the grade in percent")
    ap.add_argument("--min-grade", type=float, default=-14.0, help="cap on descents in percent (use e.g. -6 for a pure climb)")
    ap.add_argument("--edge-offset", type=float, default=2.5, help="metres toward the outside of bends to sample elevation at")
    args = ap.parse_args()

    dem = Dem(args.dem)
    fine = DemStack(args.dem_fine) if args.dem_fine else dem
    osm = json.load(open(args.osm))
    latlon, e_start, e_end = chain_ways(osm["elements"], fine, cut_at_top=args.cut_at_top)
    print(f"path: {len(latlon)} nodes, {e_start:.0f} m -> {e_end:.0f} m")

    lat_ref = (max(p[0] for p in latlon) + min(p[0] for p in latlon)) / 2
    lon_ref = (max(p[1] for p in latlon) + min(p[1] for p in latlon)) / 2
    kx = EARTH_LON_M * math.cos(math.radians(lat_ref))
    to_xz = lambda lat, lon: (float((lon - lon_ref) * kx), float(-(lat - lat_ref) * EARTH_LAT_M))
    to_latlon = lambda x, z: (lat_ref - z / EARTH_LAT_M, lon_ref + x / kx)

    xz = resample([to_xz(*p) for p in latlon], SPACING)
    # Sample the elevation a little toward the outside of each bend: at a
    # hairpin the inside of the road is within one DEM cell of the other leg.
    d = np.gradient(xz, axis=0)
    d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
    turn = np.gradient(d[:, 0]) * d[:, 1] - np.gradient(d[:, 1]) * d[:, 0]
    turn = np.convolve(np.pad(turn, 6, mode="edge"), np.ones(13) / 13, mode="valid")
    normal = np.stack([-d[:, 1], d[:, 0]], axis=1)
    outside = -np.sign(turn)[:, None] * normal * args.edge_offset
    xz_sample = xz + outside * (np.abs(turn)[:, None] > 0.002)
    ll = np.array([to_latlon(x, z) for x, z in xz_sample])
    raw = fine.sample_many(ll[:, 0], ll[:, 1])
    if np.isnan(raw).any():
        raise SystemExit("the fine DEM does not cover the whole route")
    # The DEM is a surface model on 30 m cells: on a cliff road with stacked
    # hairpins it is off by tens of metres. Smooth, cap the grade, then
    # re-integrate so the profile stays plausible and ends at the right height.
    y = smooth(raw, args.smooth)
    step = np.clip(np.diff(y), args.min_grade / 100 * SPACING, args.max_grade / 100 * SPACING)
    y = np.concatenate([[y[0]], y[0] + np.cumsum(step)])
    y += np.linspace(0, smooth(raw, args.smooth)[-1] - y[-1], len(y))
    y, crossings = bridge_crossings(xz, y)
    for i, j, gap in crossings:
        print(f"bridge: {i * SPACING:.0f} m crosses {j * SPACING:.0f} m, {gap:.1f} m apart")
    points = [{"distance_m": i * SPACING, "x": round(float(x), 2), "y": round(float(h), 2), "z": round(float(z), 2)} for i, ((x, z), h) in enumerate(zip(xz, y))]
    length = points[-1]["distance_m"]
    gain = float(np.sum(np.clip(np.diff(y), 0, None)))
    grades = np.diff(y) / SPACING * 100
    g100 = np.convolve(grades, np.ones(20) / 20, mode="valid")
    print(f"route: {length/1000:.2f} km, {y[0]:.0f} -> {y[-1]:.0f} m, gain {gain:.0f} m, avg {100*(y[-1]-y[0])/length:.1f} %, max 100 m grade {g100.max():.1f} %, min {g100.min():.1f} %")

    repo = Path(args.repo)
    route = {"name": args.name, "points": points, "closed": False, "world": args.id}
    (repo / "crates/core/routes" / f"{args.id}.json").write_text(json.dumps(route, separators=(",", ":")))

    ortho = Ortho(args.cache) if args.ortho else None
    ortho_dir = repo / "ui/public/worlds" / args.id
    if ortho:
        ortho_dir.mkdir(parents=True, exist_ok=True)

    def heightmap(center_x, center_z, half_w, half_h, spacing, suffix, source, blocks, zoom, size):
        lat_max, lon_min = to_latlon(center_x - half_w, center_z - half_h)
        lat_min, lon_max = to_latlon(center_x + half_w, center_z + half_h)
        lats, lons, grid = source.grid(lat_min, lat_max, lon_min, lon_max, spacing, lat_ref, fallback=dem)
        x0, z0 = to_xz(lats[0], lons[0])
        (repo / "ui/public/worlds" / f"{args.id}-{suffix}.bin").write_bytes(struct.pack(f"<{grid.size}f", *grid.flatten().tolist()))
        rows, cols = grid.shape
        print(f"{suffix}: {cols}x{rows} at {spacing} m, {grid.min():.0f}..{grid.max():.0f} m")
        meta = {"file": f"/worlds/{args.id}-{suffix}.bin", "cols": int(cols), "rows": int(rows), "x0": round(x0, 1), "z0": round(z0, 1), "spacing": spacing}
        if ortho:
            # Textures per block of the grid, each covering the vertex ranges between the edges.
            row_edges = [round(k * (rows - 1) / blocks) for k in range(blocks + 1)]
            col_edges = [round(k * (cols - 1) / blocks) for k in range(blocks + 1)]
            files = []
            for br in range(blocks):
                files.append([])
                for bc in range(blocks):
                    r0, r1 = row_edges[br], row_edges[br + 1]
                    c0, c1 = col_edges[bc], col_edges[bc + 1]
                    img = ortho.image(float(lats[r1]), float(lats[r0]), float(lons[c0]), float(lons[c1]), zoom, size)
                    name = f"ortho-{suffix}-{br}-{bc}.jpg"
                    img.save(ortho_dir / name, quality=82, optimize=True)
                    files[-1].append(f"/worlds/{args.id}/{name}")
                    print(f"  {name}: {size}px over {(c1 - c0) * spacing:.0f} m")
            meta["ortho"] = {"rowEdges": row_edges, "colEdges": col_edges, "size": size, "files": files}
        return meta

    xs, zs = xz[:, 0], xz[:, 1]
    cx, cz = float((xs.max() + xs.min()) / 2), float((zs.max() + zs.min()) / 2)
    near = heightmap(cx, cz, (xs.max() - xs.min()) / 2 + args.near_margin, (zs.max() - zs.min()) / 2 + args.near_margin, args.near_spacing, "near", fine, args.ortho_blocks, args.ortho_zoom, 1024)
    far = heightmap(cx, cz, args.far_size / 2, args.far_size / 2, args.far_spacing, "far", dem, 1, args.ortho_zoom - 4, 2048)
    # A fine band right around the road, at the source resolution, for the road corridor.
    saved_ortho, ortho = ortho, None
    band = heightmap(cx, cz, (xs.max() - xs.min()) / 2 + args.band_margin, (zs.max() - zs.min()) / 2 + args.band_margin, args.band_spacing, "band", fine, 1, 0, 0)
    ortho = saved_ortho
    details = detail_textures(near, ortho, ortho_dir, args, lats_for=to_latlon) if ortho else None
    meta = {
        "id": args.id,
        "details": details,
        "name": args.name,
        "origin": {"lat": lat_ref, "lon": lon_ref},
        "near": near,
        "far": far,
        "band": band,
        "attribution": "Road data © OpenStreetMap contributors (ODbL). Elevation: "
        + ("IGN España MDT05 (CC BY 4.0) and " if args.dem_fine else "")
        + "Copernicus DEM GLO-30 © ESA."
        + (" Aerial imagery: PNOA © IGN España (CC BY 4.0)." if args.ortho else ""),
    }
    (repo / "ui/public/worlds" / f"{args.id}.json").write_text(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
