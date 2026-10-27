import { describe, expect, it } from "vitest";
import type { Route, RoutePoint } from "../types";
import { RouteSampler } from "./route";

function square(): Route {
  // A 400 m square ridden counter-clockwise, 10 m samples, 5 m climb on the first side.
  const pts: RoutePoint[] = [];
  let d = 0;
  const push = (x: number, z: number, y: number) => pts.push({ distance_m: d, x, y, z }) && (d += 10);
  for (let i = 0; i < 10; i++) push(i * 10, 0, i * 0.5);
  for (let i = 0; i < 10; i++) push(100, i * 10, 5);
  for (let i = 0; i < 10; i++) push(100 - i * 10, 100, 5);
  for (let i = 0; i < 10; i++) push(0, 100 - i * 10, 5 - i * 0.5);
  push(0, 0, 0);
  return { name: "square", points: pts, closed: true };
}

describe("RouteSampler", () => {
  const s = new RouteSampler(square());

  it("knows its length and wraps laps", () => {
    expect(s.length).toBe(400);
    expect(s.wrap(450)).toBe(50);
    expect(s.wrap(-10)).toBe(390);
  });

  it("interpolates position and heading", () => {
    const p = s.pose(25);
    expect(p.x).toBeCloseTo(25);
    expect(p.z).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(1.25);
    expect(p.dx).toBeCloseTo(1, 1);
    expect(p.grade).toBeCloseTo(5);
    const side = s.pose(150);
    expect(side.x).toBeCloseTo(100);
    expect(side.z).toBeCloseTo(50);
    expect(side.dz).toBeCloseTo(1, 1);
    expect(side.grade).toBeCloseTo(0);
  });

  it("builds a normalised profile", () => {
    const prof = s.profile(5);
    expect(prof).toHaveLength(5);
    expect(Math.min(...prof)).toBeCloseTo(0);
    expect(Math.max(...prof)).toBeCloseTo(1);
  });
});
