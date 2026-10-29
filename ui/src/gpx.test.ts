import { describe, expect, it } from "vitest";
import { matchTrack, parseGpx } from "./gpx";
import { square } from "./routing.fixture";
import { Router } from "./routing";
import { NetworkIndex } from "./world/network";

describe("parseGpx", () => {
  it("reads track points, the name, and attributes in either order", () => {
    const t = parseGpx(`<?xml version="1.0"?><gpx><metadata><name>Morning</name></metadata><trk><trkseg>
      <trkpt lat="39.7" lon="2.7"><ele>10</ele></trkpt><trkpt lon="2.71" lat="39.71"/></trkseg></trk></gpx>`);
    expect(t.name).toBe("Morning");
    expect(t.points).toEqual([
      [39.7, 2.7],
      [39.71, 2.71],
    ]);
  });

  it("falls back to route points, then waypoints, and refuses files without a track", () => {
    expect(parseGpx(`<gpx><wpt lat="1" lon="1"/><rte><rtept lat="2" lon="2"/><rtept lat="3" lon="3"/></rte></gpx>`).points).toEqual([
      [2, 2],
      [3, 3],
    ]);
    expect(parseGpx(`<gpx><wpt lat="1" lon="1"/><wpt lat="2" lon="2"/></gpx>`).points.length).toBe(2);
    expect(() => parseGpx("<gpx></gpx>")).toThrow();
  });
});

describe("matchTrack", () => {
  const net = square();
  const index = new NetworkIndex(net);
  const router = new Router(net);

  it("follows a track round the square instead of taking the diagonal", () => {
    // A track from node 0 along the top and right sides to node 2, recorded a few metres off the road.
    const xz: [number, number][] = [];
    for (let x = 0; x <= 100; x += 10) xz.push([x, 3]);
    for (let z = 10; z <= 100; z += 10) xz.push([97, z]);
    const spots = matchTrack(index, router, xz, { step: 5, tolerance: 20, snap: 30, maxWaypoints: 10 })!;
    expect(spots).not.toBeNull();
    const path = router.routeAll(spots)!;
    expect(path.legs.map((l) => l.edge)).toEqual([0, 1]);
    expect(path.length_m).toBeCloseTo(200, 3);
    expect(spots.length).toBeLessThanOrEqual(4);
  });

  it("adds a waypoint wherever the shortest way leaves the track, and no more", () => {
    // Up the left side, back down, then along the bottom: 3 → 0 → 3 → 2. The direct way is the bottom alone.
    const xz: [number, number][] = [];
    for (let z = 100; z >= 0; z -= 10) xz.push([3, z]);
    for (let z = 10; z <= 100; z += 10) xz.push([3, z]);
    for (let x = 10; x <= 100; x += 10) xz.push([x, 97]);
    const spots = matchTrack(index, router, xz, { step: 5, tolerance: 20, snap: 30, maxWaypoints: 10 })!;
    const path = router.routeAll(spots)!;
    expect(path.length_m).toBeCloseTo(300, 1);
    // Node 0 pulls the route up the side; a point on the bottom keeps it off the diagonal on the way to 2.
    expect(spots.length).toBe(4);
  });

  it("gives up on a track far from every road", () => {
    expect(matchTrack(index, router, [[5000, 5000], [5100, 5100]])).toBeNull();
  });
});
