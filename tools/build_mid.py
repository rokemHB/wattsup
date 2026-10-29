#!/usr/bin/env python3
"""
Middle terrain layer for a network world: a height grid at a few tens of
metres over the roads' extent (plus a margin), between the streamed 10 m
tiles and the island-wide 150 m far layer. The app builds mid-distance blocks
from it at ride time, textured with imagery it fetches, so mountains two to
eight kilometres off have their true shape before (and beyond) the tiles.

  .venv/bin/python tools/build_mid.py --id mallorca --dem dem_n39_e002.tif dem_n39_e003.tif [--spacing 45] [--margin 4000]

Reads crates/core/worlds/<id>/network.json for the extent and
ui/public/worlds/<id>.json for the origin; writes ui/public/worlds/<id>-mid.bin
(int16 metres, row-major from the north-west corner) and adds "mid" to the
world's json. `build_network.py` does the same at the end of its run.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_route import EARTH_LAT_M, EARTH_LON_M, Dem  # noqa: E402


def write_mid(repo, world_id, dem_paths, spacing=45.0, margin=4000.0):
    """Writes the mid grid and returns its metadata (also written into the world's json)."""
    net = json.loads((repo / "crates/core/worlds" / world_id / "network.json").read_text())
    meta_path = repo / "ui/public/worlds" / f"{world_id}.json"
    meta = json.loads(meta_path.read_text())
    lat_ref = meta["origin"]["lat"]
    lon_ref = meta["origin"]["lon"]
    kx = EARTH_LON_M * math.cos(math.radians(lat_ref))
    xs = [n["x"] for n in net["nodes"]]
    zs = [n["z"] for n in net["nodes"]]
    x0 = math.floor((min(xs) - margin) / spacing) * spacing
    x1 = math.ceil((max(xs) + margin) / spacing) * spacing
    z0 = math.floor((min(zs) - margin) / spacing) * spacing
    z1 = math.ceil((max(zs) + margin) / spacing) * spacing
    cols = int(round((x1 - x0) / spacing)) + 1
    rows = int(round((z1 - z0) / spacing)) + 1
    gx, gz = np.meshgrid(x0 + np.arange(cols) * spacing, z0 + np.arange(rows) * spacing)
    lats = lat_ref - gz / EARTH_LAT_M
    lons = lon_ref + gx / kx
    heights = np.full(lats.size, np.nan)
    for d in dem_paths:
        v = Dem(d).sample_many(lats.ravel(), lons.ravel())
        heights = np.where(np.isnan(heights), v, heights)
    heights = np.nan_to_num(heights, nan=0.0).reshape(rows, cols)
    out = repo / "ui/public/worlds" / f"{world_id}-mid.bin"
    out.write_bytes(np.clip(np.round(heights), -32768, 32767).astype("<i2").tobytes())
    mid = {"file": f"/worlds/{world_id}-mid.bin", "cols": cols, "rows": rows, "x0": round(float(x0), 1), "z0": round(float(z0), 1), "spacing": spacing, "format": "int16"}
    meta["mid"] = mid
    meta_path.write_text(json.dumps(meta, indent=1))
    print(f"mid: {cols}x{rows} at {spacing} m, {out.stat().st_size / 1e6:.1f} MB, heights {heights.min():.0f}..{heights.max():.0f} m")
    return mid


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--id", required=True)
    ap.add_argument("--dem", nargs="+", required=True, help="Copernicus GLO-30 tiles")
    ap.add_argument("--spacing", type=float, default=45.0)
    ap.add_argument("--margin", type=float, default=4000.0, help="metres beyond the roads' extent")
    args = ap.parse_args()
    write_mid(Path(__file__).resolve().parents[1], args.id, args.dem, args.spacing, args.margin)


if __name__ == "__main__":
    main()
