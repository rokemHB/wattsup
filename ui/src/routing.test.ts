import { describe, expect, it } from "vitest";
import { edgeWeights, elevationGain, Router } from "./routing";
import { square } from "./routing.fixture";

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

  it("avoids a road when another way exists and reports the real length", () => {
    const r = new Router(net);
    // Node 0 to node 2: the diagonal (edge 4, 141 m) is shortest; avoiding it goes round two sides (200 m).
    const from = { edge: 0, i: net.edges[0].start };
    const to = { edge: 1, i: net.edges[1].start + 10 };
    expect(r.route(from, to)!.legs[0].edge).toBe(4);
    r.setWeights(edgeWeights(net, { mainRoads: false, avoid: [4] }));
    const p = r.route(from, to)!;
    expect(p.legs.map((l) => l.edge)).toEqual([0, 1]);
    expect(p.length_m).toBeCloseTo(200, 3);
    // The spur is the only way to node 4: avoided or not, it is ridden, and its length stays 100 m.
    r.setWeights(edgeWeights(net, { mainRoads: false, avoid: [5] }));
    const spur = r.route({ edge: 5, i: net.edges[5].start }, { edge: 5, i: net.edges[5].start + 10 })!;
    expect(spur.length_m).toBeCloseTo(100, 3);
    r.setWeights(null);
    expect(r.route(from, to)!.legs[0].edge).toBe(4);
  });

  it("prefers main roads when asked", () => {
    const wide = square();
    // The diagonal is an unclassified lane, the sides are primary: preferring main roads goes round.
    wide.edges[4].kind = 3;
    wide.edges[0].kind = 0;
    wide.edges[1].kind = 0;
    const r = new Router(wide);
    const from = { edge: 0, i: wide.edges[0].start };
    const to = { edge: 1, i: wide.edges[1].start + 10 };
    expect(edgeWeights(wide, { mainRoads: false, avoid: [] })).toBeNull();
    r.setWeights(edgeWeights(wide, { mainRoads: true, avoid: [] }));
    expect(r.route(from, to)!.legs.map((l) => l.edge)).toEqual([0, 1]);
  });

  it("refuses empty routes and the same point twice", () => {
    expect(router.route({ edge: 0, i: 3 }, { edge: 0, i: 3 })).toBeNull();
    expect(router.routeAll([{ edge: 0, i: 3 }])).toBeNull();
    expect(router.routeAll([{ edge: 0, i: 3 }, { edge: 0, i: 3 }])).toBeNull();
  });
});
