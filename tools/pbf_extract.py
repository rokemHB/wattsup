#!/usr/bin/env python3
"""Extracts roads and places from an OSM PBF file (e.g. a Geofabrik extract)
into the same JSON shape Overpass returns with `out geom;`, for
build_network.py. Useful when Overpass is at capacity.

  python tools/pbf_extract.py islas-baleares-latest.osm.pbf out.json --bbox 39.50,2.33,39.99,3.25
"""
import argparse
import json

import osmium

ROADS = {"primary", "secondary", "tertiary", "unclassified", "primary_link", "secondary_link", "tertiary_link"}
PLACES = {"city", "town", "village", "hamlet"}


class Handler(osmium.SimpleHandler):
    def __init__(self, bbox):
        super().__init__()
        self.lat0, self.lon0, self.lat1, self.lon1 = bbox
        self.elements = []

    def inside(self, lat, lon):
        return self.lat0 <= lat <= self.lat1 and self.lon0 <= lon <= self.lon1

    def node(self, n):
        if n.tags.get("place") in PLACES and n.location.valid() and self.inside(n.location.lat, n.location.lon):
            self.elements.append({"type": "node", "id": n.id, "lat": n.location.lat, "lon": n.location.lon, "tags": dict(n.tags)})

    def way(self, w):
        if w.tags.get("highway") not in ROADS:
            return
        geom = []
        ids = []
        for n in w.nodes:
            if not n.location.valid():
                return
            geom.append({"lat": n.location.lat, "lon": n.location.lon})
            ids.append(n.ref)
        if not any(self.inside(g["lat"], g["lon"]) for g in geom):
            return
        self.elements.append({"type": "way", "id": w.id, "nodes": ids, "geometry": geom, "tags": dict(w.tags)})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pbf")
    ap.add_argument("out")
    ap.add_argument("--bbox", required=True, help="lat_min,lon_min,lat_max,lon_max")
    args = ap.parse_args()
    bbox = tuple(map(float, args.bbox.split(",")))
    h = Handler(bbox)
    h.apply_file(args.pbf, locations=True)
    json.dump({"elements": h.elements}, open(args.out, "w"))
    ways = sum(1 for e in h.elements if e["type"] == "way")
    print(f"{ways} ways, {len(h.elements) - ways} places")


if __name__ == "__main__":
    main()
