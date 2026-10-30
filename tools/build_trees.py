#!/usr/bin/env python3
"""Trees of a world (the island's road network, or a single route) from a 1 m canopy height model.

Source: Meta / World Resources Institute "High Resolution Canopy Height Maps"
(Tolan et al. 2024, CC BY 4.0), 1.19 m pixels in EPSG:3857, one uint8 metre per
pixel, tiles by zoom-9 quadkey on AWS Open Data:

    https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/<quadkey>.tif

Method: the canopy surface is smoothed a little (Gaussian, sigma 1 px) and every
local maximum of at least MIN_TREE_M within a window that grows with height
(crown width from Popescu & Wynne 2004, pines: CW = 3.10 + 0.0090 h^2 m) is a tree
top. Only ground within reach of the roads (where terrain tiles can load) is kept.

Output `<out>` (gzip-compressed): little-endian
    u32 cols, u32 rows, f32 x0, f32 z0, f32 cell      (cells of `cell` metres, local frame)
    u32 offsets[cols*rows + 1]                        (tree index where each cell starts)
    per tree one u32: x (bits 0-11) and z (bits 12-23) in 0.1 m from the cell's corner,
    height in 0.1 m (bits 24-31, at most 25.5 m)
The renderer picks the model from the height (round crowns below 7 m: olive, carob,
holm oak; pines above).

    python tools/build_trees.py --network crates/core/worlds/mallorca/network.json \\
        --chm ~/wattsup-data/canopy/chm_*.tif --out ui/public/worlds/mallorca-trees.bin
    python tools/build_trees.py --route crates/core/routes/sa-calobra.json \\
        --world ui/public/worlds/sa-calobra.json --chm ... --out ui/public/worlds/sa-calobra-trees.bin
"""
import argparse
import gzip
import json
import math
import struct
import sys

import numpy as np
import rasterio
from rasterio.windows import Window
from scipy import ndimage

EARTH_LAT_M = 110574.0
EARTH_LON_M = 111320.0
R_MERC = 6378137.0
MIN_TREE_M = 3
CELL_M = 400.0
# Ground farther than this from every road never gets a terrain tile (load radius 2 km + half a tile).
REACH_M = 3200.0
BAND = 2048
PAD = 16


def crown_width(h):
    return 3.10 + 0.0090 * h * h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--network", help="network json (its points in the .bin beside it)")
    ap.add_argument("--route", help="a single route's json (crates/core/routes), with --world for its origin")
    ap.add_argument("--world", help="the route's world json (ui/public/worlds)")
    ap.add_argument("--chm", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--reach", type=float, default=REACH_M)
    a = ap.parse_args()

    if a.network:
        net = json.load(open(a.network))
        xyz = np.fromfile(a.network.replace(".json", ".bin"), dtype="<f4").reshape(-1, 3)
        origin = net["origin"]
    elif a.route and a.world:
        xyz = np.array([[p["x"], p["y"], p["z"]] for p in json.load(open(a.route))["points"]], np.float32)
        origin = json.load(open(a.world))["origin"]
    else:
        sys.exit("--network, or --route with --world")
    lat0, lon0 = origin["lat"], origin["lon"]
    kx = EARTH_LON_M * math.cos(math.radians(lat0))

    # Cells within reach of a road point.
    x0 = math.floor((xyz[:, 0].min() - a.reach) / CELL_M) * CELL_M
    z0 = math.floor((xyz[:, 2].min() - a.reach) / CELL_M) * CELL_M
    cols = int(math.ceil((xyz[:, 0].max() + a.reach - x0) / CELL_M))
    rows = int(math.ceil((xyz[:, 2].max() + a.reach - z0) / CELL_M))
    near = np.zeros((rows, cols), bool)
    ci = ((xyz[::4, 0] - x0) // CELL_M).astype(int)
    cr = ((xyz[::4, 2] - z0) // CELL_M).astype(int)
    near[cr, ci] = True
    k = int(math.ceil(a.reach / CELL_M))
    yy, xx = np.mgrid[-k : k + 1, -k : k + 1]
    near = ndimage.binary_dilation(near, structure=(xx * xx + yy * yy) <= k * k)
    print(f"grid {cols}x{rows} cells of {CELL_M:.0f} m, {near.sum()} within reach", file=sys.stderr)

    per_cell = [[] for _ in range(rows * cols)]
    total = 0
    for path in a.chm:
        ds = rasterio.open(path)
        t = ds.transform
        for r0 in range(0, ds.height, BAND):
            ra = max(0, r0 - PAD)
            rb = min(ds.height, r0 + BAND + PAD)
            # Which pixel columns of this band can hold cells within reach? Check the band's lat span first.
            my_top = t.f + ra * t.e
            my_bot = t.f + rb * t.e
            lat_top = math.degrees(2 * math.atan(math.exp(my_top / R_MERC)) - math.pi / 2)
            lat_bot = math.degrees(2 * math.atan(math.exp(my_bot / R_MERC)) - math.pi / 2)
            z_top = -(lat_top - lat0) * EARTH_LAT_M
            z_bot = -(lat_bot - lat0) * EARTH_LAT_M
            rr0 = max(0, int((z_top - z0) // CELL_M))
            rr1 = min(rows - 1, int((z_bot - z0) // CELL_M))
            if rr1 < 0 or rr0 > rows - 1 or not near[rr0 : rr1 + 1].any():
                continue
            colmask = near[rr0 : rr1 + 1].any(axis=0)
            cx = np.nonzero(colmask)[0]
            # Local x range -> lon -> mercator x -> pixel columns.
            lon_a = lon0 + (x0 + cx.min() * CELL_M) / kx
            lon_b = lon0 + (x0 + (cx.max() + 1) * CELL_M) / kx
            ca = max(0, int((math.radians(lon_a) * R_MERC - t.c) / t.a) - PAD)
            cb = min(ds.width, int((math.radians(lon_b) * R_MERC - t.c) / t.a) + PAD)
            if cb <= ca:
                continue
            chm = ds.read(1, window=Window(ca, ra, cb - ca, rb - ra)).astype(np.float32)
            smooth = ndimage.gaussian_filter(chm, 1.0)
            # Variable window: test maxima at three window sizes and keep each where it fits the height.
            tops = np.zeros(chm.shape, bool)
            px = abs(t.a)
            for lo, hi in ((MIN_TREE_M, 8), (8, 14), (14, 255)):
                w = max(3, int(round(crown_width((lo + hi) / 2 if hi < 255 else 18) * 0.6 / px)) | 1)
                m = (smooth == ndimage.maximum_filter(smooth, size=w)) & (smooth >= lo) & (smooth < hi)
                tops |= m
            # Drop the padding.
            tops[: r0 - ra, :] = False
            tops[rb - ra - (rb - min(ds.height, r0 + BAND)) :, :] = False
            iy, ix = np.nonzero(tops)
            if not len(iy):
                continue
            h = chm[iy, ix]
            mx = t.c + (ca + ix + 0.5) * t.a
            my = t.f + (ra + iy + 0.5) * t.e
            lon = np.degrees(mx / R_MERC)
            lat = np.degrees(2 * np.arctan(np.exp(my / R_MERC)) - np.pi / 2)
            x = (lon - lon0) * kx
            z = -(lat - lat0) * EARTH_LAT_M
            c = ((x - x0) // CELL_M).astype(int)
            r = ((z - z0) // CELL_M).astype(int)
            ok = (c >= 0) & (c < cols) & (r >= 0) & (r < rows)
            ok[ok] &= near[r[ok], c[ok]]
            for xi, zi, hi, ri, cj in zip(x[ok], z[ok], h[ok], r[ok], c[ok]):
                per_cell[ri * cols + cj].append((xi, zi, hi))
            total += int(ok.sum())
            print(f"{path.split('/')[-1]} rows {r0}..{r0 + BAND}: {int(ok.sum())} trees, {total} so far", file=sys.stderr)

    # Pack. Cells may get trees from two source tiles at a seam: drop near duplicates per cell.
    offsets = [0]
    recs = bytearray()
    for idx, trees in enumerate(per_cell):
        if trees:
            arr = np.array(trees, np.float32)
            arr = arr[np.lexsort((arr[:, 1], arr[:, 0]))]
            cx0 = x0 + (idx % cols) * CELL_M
            cz0 = z0 + (idx // cols) * CELL_M
            ux = np.clip(np.round((arr[:, 0] - cx0) * 10), 0, 4095).astype(np.uint32)
            uz = np.clip(np.round((arr[:, 1] - cz0) * 10), 0, 4095).astype(np.uint32)
            hh = np.clip(np.round(arr[:, 2] * 10), 0, 255).astype(np.uint32)
            recs += (ux | (uz << 12) | (hh << 24)).astype("<u4").tobytes()
            offsets.append(offsets[-1] + len(arr))
        else:
            offsets.append(offsets[-1])
    with gzip.open(a.out, "wb", compresslevel=9) as f:
        f.write(struct.pack("<IIfff", cols, rows, x0, z0, CELL_M))
        f.write(np.array(offsets, "<u4").tobytes())
        f.write(recs)
    print(f"{offsets[-1]} trees, {len(recs) / 1e6:.1f} MB of records -> {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
