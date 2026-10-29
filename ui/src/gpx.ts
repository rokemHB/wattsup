// GPX tracks on the planner: reading the file, and turning its track into the
// few waypoints that make the router follow it (the track itself is never
// ridden: the ride runs on the network's roads).
import type { RoadSpot } from "./map";
import type { Router } from "./routing";
import type { NetworkIndex } from "./world/network";

export interface Track {
  name: string | null;
  /** lat, lon pairs in order. */
  points: [number, number][];
}

/** The track (or route, or at least the waypoints) of a GPX file. Throws when there is none. */
export function parseGpx(text: string): Track {
  const points: [number, number][] = [];
  const tags = /<(trkpt|rtept|wpt)\b([^>]*)>/g;
  let kind = "";
  for (const m of text.matchAll(tags)) {
    // Track points first, route points failing that, lone waypoints as the last resort.
    if (kind && m[1] !== kind) {
      if (kind === "trkpt" || (kind === "rtept" && m[1] === "wpt")) continue;
      points.length = 0;
    }
    kind = m[1];
    const lat = parseFloat(/\blat="([^"]+)"/.exec(m[2])?.[1] ?? "");
    const lon = parseFloat(/\blon="([^"]+)"/.exec(m[2])?.[1] ?? "");
    if (Number.isFinite(lat) && Number.isFinite(lon)) points.push([lat, lon]);
  }
  if (points.length < 2) throw new Error("no track in this file");
  const name = /<name>([^<]*)<\/name>/.exec(text)?.[1].trim() || null;
  return { name, points };
}

export interface MatchOptions {
  /** The track is thinned to one point every so many metres. */
  step: number;
  /** The route may leave the track by this much before a waypoint pulls it back. */
  tolerance: number;
  /** A road this far from a track point counts as where the track went. */
  snap: number;
  maxWaypoints: number;
}

const DEFAULTS: MatchOptions = { step: 25, tolerance: 60, snap: 150, maxWaypoints: 40 };

/**
 * Waypoints whose route follows the track: the track's first and last road
 * points, then, until the route stays within the tolerance of the track,
 * the track point the route strays from most. Null when the track does not
 * reach the roads or no road joins its ends.
 */
export function matchTrack(index: NetworkIndex, router: Router, xz: [number, number][], options: Partial<MatchOptions> = {}): RoadSpot[] | null {
  const o = { ...DEFAULTS, ...options };
  // Thin the track.
  const track: [number, number][] = [];
  for (const p of xz) {
    const last = track[track.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= o.step) track.push(p);
  }
  if (xz.length && track[track.length - 1] !== xz[xz.length - 1]) track.push(xz[xz.length - 1]);
  const snapped = track.map(([x, z]) => {
    const n = index.nearest(x, z, o.snap);
    return n.i >= 0 && n.d <= o.snap ? ({ x: index.net.xyz[n.i * 3], z: index.net.xyz[n.i * 3 + 2], edge: n.edge, i: n.i } satisfies RoadSpot) : null;
  });
  const first = snapped.findIndex((s) => !!s);
  let last = -1;
  for (let k = snapped.length - 1; k >= 0; k--) {
    if (snapped[k]) {
      last = k;
      break;
    }
  }
  if (first < 0 || last <= first) return null;
  const anchors: { t: number; spot: RoadSpot }[] = [
    { t: first, spot: snapped[first]! },
    { t: last, spot: snapped[last]! },
  ];
  const tried = new Set<number>([first, last]);
  const xyz = index.net.xyz;
  const cell = Math.max(50, o.tolerance);
  let lastAdded = -1;
  for (let round = 0; round < o.maxWaypoints * 2; round++) {
    const path = router.routeAll(anchors.map((a) => a.spot));
    if (!path) {
      if (anchors.length <= 2) return null;
      // The last anchor made the route impossible: drop it (it stays tried).
      anchors.splice(anchors.findIndex((a) => a.t === lastAdded), 1);
      continue;
    }
    // How far each track point is from the route: route points bucketed on a grid.
    const grid = new Map<number, number[]>();
    const key = (cx: number, cz: number) => (cx + 1e5) * 1e6 + (cz + 1e5);
    for (const i of path.points) {
      const k = key(Math.floor(xyz[i * 3] / cell), Math.floor(xyz[i * 3 + 2] / cell));
      const list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    }
    let worst = { t: -1, d: o.tolerance };
    for (let t = first; t <= last; t++) {
      if (tried.has(t) || !snapped[t]) continue;
      const [x, z] = track[t];
      const cx = Math.floor(x / cell);
      const cz = Math.floor(z / cell);
      // Rings outward until a route point turns up and nothing in a farther ring can beat it.
      let d = Infinity;
      for (let ring = 0; ring < 64 && d > (ring - 1) * cell; ring++) {
        for (let i = -ring; i <= ring; i++) {
          for (let k = -ring; k <= ring; k++) {
            if (Math.max(Math.abs(i), Math.abs(k)) !== ring) continue;
            const list = grid.get(key(cx + i, cz + k));
            if (!list) continue;
            for (const p of list) d = Math.min(d, Math.hypot(xyz[p * 3] - x, xyz[p * 3 + 2] - z));
          }
        }
      }
      if (d > worst.d) worst = { t, d };
    }
    if (worst.t < 0 || anchors.length >= o.maxWaypoints) break;
    tried.add(worst.t);
    const spot = snapped[worst.t]!;
    if (anchors.some((a) => a.spot.i === spot.i)) continue;
    let at = 0;
    while (at < anchors.length && anchors[at].t < worst.t) at++;
    anchors.splice(at, 0, { t: worst.t, spot });
    lastAdded = worst.t;
  }
  // Anchors the route no longer needs (the same route results without them) go again.
  let length = router.routeAll(anchors.map((a) => a.spot))?.length_m ?? 0;
  for (let k = anchors.length - 2; k >= 1; k--) {
    const without = anchors.filter((_, i) => i !== k);
    const l = router.routeAll(without.map((a) => a.spot))?.length_m;
    if (l !== undefined && Math.abs(l - length) < 1) {
      anchors.splice(k, 1);
      length = l;
    }
  }
  return anchors.map((a) => a.spot);
}
