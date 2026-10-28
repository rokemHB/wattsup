import { describe, expect, it } from "vitest";
import { elevationGain, Router } from "./routing";
import type { RoadNetwork } from "./world/network";

/**
 * A square of four roads with a diagonal shortcut and a spur:
 *   0 ---- 1
 *   |  \   |
 *   |   \  |
 *   3 ---- 2 ---- 4
 * Edges: 0: 0→1 (100 m), 1: 1→2 (100 m), 2: 2→3 (100 m), 3: 3→0 (100 m), 4: 0→2 (diagonal, ~141 m), 5: 2→4 (spur, 100 m).
 */
function square(): RoadNetwork {
  const nodes = [
    { x: 0, z: 0 },
    { x: 100, z: 0 },
    { x: 100, z: 100 },
    { x: 0, z: 100 },
    { x: 200, z: 100 },
  ];
  const links: [number, number][] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [0, 2],
    [2, 4],
  ];
  const xyz: number[] = [];
  const edges = links.map(([a, b], k) => {
    const start = xyz.length / 3;
    const n = 11;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      xyz.push(nodes[a].x + (nodes[b].x - nodes[a].x) * t, k === 5 ? 10 * t : 0, nodes[a].z + (nodes[b].z - nodes[a].z) * t);
    }
    return { a, b, ref: `R${k}`, name: null, kind: 1, start, count: n, length_m: Math.hypot(nodes[b].x - nodes[a].x, nodes[b].z - nodes[a].z) };
  });
  return {
    name: "square",
    origin: { lat: 0, lon: 0 },
    nodes: nodes.map((n) => ({ ...n, y: 0, signs: null })),
    edges,
    places: [],
    points: xyz.length / 3,
    xyz: new Float32Array(xyz),
  };
}

describe("routing", () => {
  const net = square();
  const router = new Router(net);

  it("takes the shortest way between junctions", () => {
    // Node 3 to node 1: around the square is 200 m either way; via the diagonal is 241 m.
    const p = router.route({ edge: 2, i: net.edges[2].start + 10 }, { edge: 0, i: net.edges[0].start + 10 })!;
    expect(p.length_m).toBeCloseTo(200, 3);
    expect(p.legs.length).toBe(2);
    expect(p.points.length).toBe(21);
  });

  it("starts and ends in the middle of edges", () => {
    // 30 m along edge 0 (toward node 1) to 70 m along edge 1 (toward node 2): stay on the roads, 70 + 70 = 140 m.
    const p = router.route({ edge: 0, i: net.edges[0].start + 3 }, { edge: 1, i: net.edges[1].start + 7 })!;
    expect(p.length_m).toBeCloseTo(140, 3);
    expect(p.legs).toEqual([
      { edge: 0, forward: true, from: 3, to: 10 },
      { edge: 1, forward: true, from: 0, to: 7 },
    ]);
    expect(p.points[0]).toBe(net.edges[0].start + 3);
    expect(p.points[p.points.length - 1]).toBe(net.edges[1].start + 7);
  });

  it("stays on one edge when that is shortest, and rides it backward", () => {
    const p = router.route({ edge: 0, i: net.edges[0].start + 8 }, { edge: 0, i: net.edges[0].start + 2 })!;
    expect(p.length_m).toBeCloseTo(60, 3);
    expect(p.legs).toEqual([{ edge: 0, forward: false, from: 8, to: 2 }]);
    expect(p.points).toEqual([8, 7, 6, 5, 4, 3, 2].map((i) => net.edges[0].start + i));
  });

  it("joins waypoints and merges legs that continue the same edge", () => {
    const e5 = net.edges[5].start;
    const p = router.routeAll([
      { edge: 0, i: net.edges[0].start },
      { edge: 5, i: e5 + 4 },
      { edge: 5, i: e5 + 10 },
    ])!;
    // 0 → 2 by the diagonal (141.4) then 100 m of spur, in one merged spur leg.
    expect(p.length_m).toBeCloseTo(100 * Math.SQRT2 + 100, 2);
    expect(p.legs).toEqual([
      { edge: 4, forward: true, from: 0, to: 10 },
      { edge: 5, forward: true, from: 0, to: 10 },
    ]);
    expect(p.stops).toEqual([0, 14, 20]);
    expect(p.points[p.stops[1]]).toBe(e5 + 4);
    expect(elevationGain(net, p.points).ascent).toBeCloseTo(10, 3);
    expect(elevationGain(net, p.points).descent).toBe(0);
  });

  it("refuses empty routes and the same point twice", () => {
    expect(router.route({ edge: 0, i: 3 }, { edge: 0, i: 3 })).toBeNull();
    expect(router.routeAll([{ edge: 0, i: 3 }])).toBeNull();
    expect(router.routeAll([{ edge: 0, i: 3 }, { edge: 0, i: 3 }])).toBeNull();
  });
});
