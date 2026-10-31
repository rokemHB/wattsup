#!/usr/bin/env python3
"""Marks a single route's tunnels and bridges in its world json, from the OSM ways it was built from.

Every route point is matched to the nearest OSM way segment that runs the same way (the
direction matters where the road passes over its own tunnel: there both are equally
near in plan); runs of points on ways tagged tunnel=yes become `"tunnels": [[from_m,
to_m], ...]` in metres along the route, which the renderer draws as a tube with the
ground left whole above (the A-7000 above Málaga loops through two tunnels under
itself), and runs on bridge=yes/viaduct ways `"bridges"`, drawn as a deck with the
ground under it left to the road below (Sa Calobra's knot crosses over itself).

    python tools/route_tunnels.py --route crates/core/routes/malaga-colmenar.json \\
        --world ui/public/worlds/malaga-colmenar.json --osm ~/wattsup-data/malaga/malaga_riogordo.json
"""
import argparse
import json
import math
import re

EARTH_LAT_M = 110574.0
EARTH_LON_M = 111320.0
# A route point belongs to a way this close (the route is splined through the way's nodes).
MATCH_M = 12.0
# Each run reaches half a point spacing past its first and last point: a 14 m underpass is
# two or three points at the 5 m spacing.
PAD_M = 2.5


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--route", required=True)
    ap.add_argument("--world", required=True)
    ap.add_argument("--osm", required=True)
    a = ap.parse_args()

    pts = json.load(open(a.route))["points"]
    origin = json.load(open(a.world))["origin"]
    lat0, lon0 = origin["lat"], origin["lon"]
    kx = EARTH_LON_M * math.cos(math.radians(lat0))
    osm = json.load(open(a.osm))
    els = osm["elements"] if isinstance(osm, dict) else osm
    nodes = {e["id"]: e for e in els if e.get("type") == "node"}
    segs = []  # (ax, az, bx, bz, tunnel)
    for e in els:
        if e.get("type") != "way":
            continue
        geom = e.get("geometry") or [nodes[n] for n in e.get("nodes", []) if n in nodes]
        xz = [((g["lon"] - lon0) * kx, -(g["lat"] - lat0) * EARTH_LAT_M) for g in geom]
        tags = e.get("tags", {})
        kind = "tunnel" if tags.get("tunnel") in ("yes", "building_passage") else "bridge" if tags.get("bridge") in ("yes", "viaduct") else None
        segs += [(p[0], p[1], q[0], q[1], kind) for p, q in zip(xz, xz[1:])]
    # Only segments near the route (the source may be a whole region's extract).
    x0 = min(p["x"] for p in pts) - 50
    x1 = max(p["x"] for p in pts) + 50
    z0 = min(p["z"] for p in pts) - 50
    z1 = max(p["z"] for p in pts) + 50
    segs = [s for s in segs if x0 <= max(s[0], s[2]) and min(s[0], s[2]) <= x1 and z0 <= max(s[1], s[3]) and min(s[1], s[3]) <= z1]

    def matched(i):
        p = pts[i]
        a_, b_ = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
        dx, dz = b_["x"] - a_["x"], b_["z"] - a_["z"]
        dl = math.hypot(dx, dz) or 1
        best = (MATCH_M, None)
        for ax, az, bx, bz, kind in segs:
            sx, sz = bx - ax, bz - az
            sl = math.hypot(sx, sz)
            if sl < 1e-6 or abs(sx * dx + sz * dz) / (sl * dl) < 0.7:
                continue
            t = max(0.0, min(1.0, ((p["x"] - ax) * sx + (p["z"] - az) * sz) / (sl * sl)))
            d = math.hypot(p["x"] - (ax + sx * t), p["z"] - (az + sz * t))
            if d < best[0]:
                best = (d, kind)
        return best[1]

    kinds = [matched(i) for i in range(len(pts))]
    text = open(a.world).read()
    for kind, key in (("tunnel", "tunnels"), ("bridge", "bridges")):
        runs = []
        i = 0
        while i < len(pts):
            if kinds[i] != kind:
                i += 1
                continue
            j = i
            while j + 1 < len(pts) and kinds[j + 1] == kind:
                j += 1
            runs.append([round(max(0.0, pts[i]["distance_m"] - PAD_M), 1), round(pts[j]["distance_m"] + PAD_M, 1)])
            i = j + 1
        print(f"{key}:", runs)
        entry = json.dumps(runs)
        if re.search(rf'\n "{key}": .*', text):
            text = re.sub(rf'\n "{key}": .*?(,?)\n', lambda m: f'\n "{key}": {entry}{m.group(1)}\n', text, count=1)
        else:
            text = re.sub(r"\n}\s*$", f',\n "{key}": {entry}\n}}\n', text, count=1)
    json.loads(text)
    open(a.world, "w").write(text)


if __name__ == "__main__":
    main()
