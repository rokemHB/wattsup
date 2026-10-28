// Shortest road routes over a network, for planning rides on the map: Dijkstra
// over the junction graph with the start, the destination and any waypoint
// allowed to lie in the middle of an edge. The network is small (about a
// thousand junctions), so a query takes well under a millisecond and the map
// can re-route while a waypoint is dragged.
import type { RoadNetwork } from "./world/network";

/** A point on a road: the edge and the global point index. */
export interface RoadPoint {
  edge: number;
  i: number;
}

/** One edge of a planned route, ridden from local point `from` to `to` (inclusive). Mirrors the Rust `PlannedLeg`. */
export interface PlannedLeg {
  edge: number;
  forward: boolean;
  from: number;
  to: number;
}

export interface PlannedPath {
  legs: PlannedLeg[];
  /** Global point indices in riding order (junction points appear once). */
  points: number[];
  length_m: number;
  /** For a path through several waypoints: the index in `points` where each waypoint sits. */
  stops: number[];
}

/** A binary min-heap of (cost, node) pairs with lazy deletion. */
class Heap {
  private cost: number[] = [];
  private node: number[] = [];
  get size() {
    return this.cost.length;
  }
  private swap(a: number, b: number) {
    const c = this.cost[a];
    this.cost[a] = this.cost[b];
    this.cost[b] = c;
    const n = this.node[a];
    this.node[a] = this.node[b];
    this.node[b] = n;
  }
  push(c: number, n: number) {
    const cost = this.cost;
    let i = cost.length;
    cost.push(c);
    this.node.push(n);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cost[p] <= cost[i]) break;
      this.swap(p, i);
      i = p;
    }
  }
  /** Removes the cheapest entry; `top` and `topNode` must be read first. */
  get top() {
    return this.cost[0];
  }
  get topNode() {
    return this.node[0];
  }
  pop() {
    const cost = this.cost;
    const lc = cost.pop()!;
    const ln = this.node.pop()!;
    if (!cost.length) return;
    cost[0] = lc;
    this.node[0] = ln;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < cost.length && cost[l] < cost[m]) m = l;
      if (r < cost.length && cost[r] < cost[m]) m = r;
      if (m === i) break;
      this.swap(m, i);
      i = m;
    }
  }
}

export class Router {
  /** Distance along the edge from its first point, per global point. */
  readonly cum: Float64Array;
  /** Length of each edge along its points. */
  readonly edgeLength: Float64Array;
  private adjacency: number[][];
  private cache = new Map<string, PlannedPath | null>();

  constructor(readonly net: RoadNetwork) {
    const xyz = net.xyz;
    this.cum = new Float64Array(net.points);
    this.edgeLength = new Float64Array(net.edges.length);
    this.adjacency = net.nodes.map(() => []);
    net.edges.forEach((e, ei) => {
      let d = 0;
      for (let i = e.start + 1; i < e.start + e.count; i++) {
        d += Math.hypot(xyz[i * 3] - xyz[(i - 1) * 3], xyz[i * 3 + 2] - xyz[(i - 1) * 3 + 2]);
        this.cum[i] = d;
      }
      this.edgeLength[ei] = d;
      this.adjacency[e.a].push(ei);
      if (e.b !== e.a) this.adjacency[e.b].push(ei);
    });
  }

  /** The shortest road path from one road point to another, or null when none exists or they coincide. */
  route(from: RoadPoint, to: RoadPoint): PlannedPath | null {
    const key = `${from.i}>${to.i}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const path = this.compute(from, to);
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(key, path);
    return path;
  }

  /** The path through all waypoints in order; null when any pair cannot be joined. */
  routeAll(points: RoadPoint[]): PlannedPath | null {
    if (points.length < 2) return null;
    const legs: PlannedLeg[] = [];
    const out: number[] = [points[0].i];
    const stops = [0];
    let length = 0;
    for (let k = 1; k < points.length; k++) {
      if (points[k].i === points[k - 1].i) {
        stops.push(out.length - 1);
        continue;
      }
      const seg = this.route(points[k - 1], points[k]);
      if (!seg) return null;
      for (const l of seg.legs) pushLeg(legs, l);
      for (let p = 1; p < seg.points.length; p++) out.push(seg.points[p]);
      stops.push(out.length - 1);
      length += seg.length_m;
    }
    if (out.length < 2) return null;
    return { legs, points: out, length_m: length, stops };
  }

  private compute(from: RoadPoint, to: RoadPoint): PlannedPath | null {
    const net = this.net;
    const edges = net.edges;
    const ef = edges[from.edge];
    const et = edges[to.edge];
    const fi = from.i - ef.start;
    const ti = to.i - et.start;
    if (from.i === to.i) return null;
    const cum = this.cum;
    // Along the same edge without leaving it.
    let best: PlannedPath | null = null;
    if (from.edge === to.edge) {
      const leg = { edge: from.edge, forward: ti > fi, from: fi, to: ti };
      best = { legs: [leg], points: legPoints(net, leg), length_m: Math.abs(cum[to.i] - cum[from.i]), stops: [] };
    }
    // Through the junctions: Dijkstra from the two ends of the starting edge.
    const n = net.nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const heap = new Heap();
    const seed = (node: number, d: number) => {
      if (d < dist[node]) {
        dist[node] = d;
        heap.push(d, node);
      }
    };
    seed(ef.a, cum[from.i]);
    seed(ef.b, this.edgeLength[from.edge] - cum[from.i]);
    const done = new Uint8Array(n);
    while (heap.size) {
      const d = heap.top;
      const u = heap.topNode;
      heap.pop();
      if (done[u]) continue;
      done[u] = 1;
      if (best && d > best.length_m) break;
      // Both ends of the destination edge settled: nothing cheaper can turn up.
      if (done[et.a] && done[et.b]) break;
      for (const ei of this.adjacency[u]) {
        const e = edges[ei];
        const v = e.a === u ? e.b : e.a;
        const nd = d + this.edgeLength[ei];
        if (nd < dist[v]) {
          dist[v] = nd;
          prev[v] = ei;
          heap.push(nd, v);
        }
      }
    }
    const viaA = dist[et.a] + cum[to.i];
    const viaB = dist[et.b] + (this.edgeLength[to.edge] - cum[to.i]);
    const end = viaA <= viaB ? et.a : et.b;
    const total = Math.min(viaA, viaB);
    if (!Number.isFinite(total) || (best && total >= best.length_m)) return best;
    // Walk back from the arrival node to whichever end of the starting edge was seeded
    // (a seeded end that was later reached more cheaply another way has a predecessor too).
    const chain: number[] = [];
    let node = end;
    const seen = new Set<number>();
    while (prev[node] >= 0 && !seen.has(node)) {
      seen.add(node);
      const ei = prev[node];
      chain.push(ei);
      node = edges[ei].a === node ? edges[ei].b : edges[ei].a;
    }
    chain.reverse();
    const legs: PlannedLeg[] = [];
    // First leg: from the start point to the seeded end of its edge.
    const startEnd = node === ef.a ? 0 : ef.count - 1;
    if (startEnd !== fi) pushLeg(legs, { edge: from.edge, forward: startEnd > fi, from: fi, to: startEnd });
    let at = node;
    for (const ei of chain) {
      const e = edges[ei];
      const forward = e.a === at;
      pushLeg(legs, { edge: ei, forward, from: forward ? 0 : e.count - 1, to: forward ? e.count - 1 : 0 });
      at = forward ? e.b : e.a;
    }
    const endStart = end === et.a ? 0 : et.count - 1;
    if (endStart !== ti) pushLeg(legs, { edge: to.edge, forward: ti > endStart, from: endStart, to: ti });
    if (!legs.length) return best;
    const points: number[] = [];
    for (const l of legs) {
      const pts = legPoints(net, l);
      for (let p = points.length ? 1 : 0; p < pts.length; p++) points.push(pts[p]);
    }
    return { legs, points, length_m: total, stops: [] };
  }
}

/** Appends a leg, merging it into the previous one when it continues the same edge in the same direction. */
function pushLeg(legs: PlannedLeg[], l: PlannedLeg) {
  const last = legs[legs.length - 1];
  if (last && last.edge === l.edge && last.forward === l.forward && last.to === l.from) {
    last.to = l.to;
    return;
  }
  legs.push({ ...l });
}

function legPoints(net: RoadNetwork, l: PlannedLeg): number[] {
  const start = net.edges[l.edge].start;
  const out: number[] = [];
  if (l.forward) for (let i = l.from; i <= l.to; i++) out.push(start + i);
  else for (let i = l.from; i >= l.to; i--) out.push(start + i);
  return out;
}

/** Climbing and descending along a path, from the points' heights. */
export function elevationGain(net: RoadNetwork, points: number[]): { ascent: number; descent: number } {
  let ascent = 0;
  let descent = 0;
  const xyz = net.xyz;
  for (let k = 1; k < points.length; k++) {
    const dy = xyz[points[k] * 3 + 1] - xyz[points[k - 1] * 3 + 1];
    if (dy > 0) ascent += dy;
    else descent -= dy;
  }
  return { ascent, descent };
}
