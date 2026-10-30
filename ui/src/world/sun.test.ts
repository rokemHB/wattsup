import { describe, expect, it } from "vitest";
import { sunPosition, sunVector } from "./sun";

// Expected values from the closed form at solar noon (elevation = 90 − latitude + declination)
// and from the shape of the day: east in the morning, due south at noon.
describe("sunPosition", () => {
  it("matches NOAA for Sóller on the summer solstice at local noon", () => {
    // 2026-06-21 13:30 CEST = 11:30 UTC, Sóller 39.766 N 2.715 E.
    const p = sunPosition(39.766, 2.715, new Date(Date.UTC(2026, 5, 21, 11, 30)));
    // Solar noon there is ~11:51 UTC: the sun is just east of south, ~73° up.
    expect(p.elevation).toBeGreaterThan(72);
    expect(p.elevation).toBeLessThan(74);
    expect(p.azimuth).toBeGreaterThan(160);
    expect(p.azimuth).toBeLessThan(175);
  });

  it("puts the winter sun low in the south", () => {
    const p = sunPosition(39.766, 2.715, new Date(Date.UTC(2026, 11, 21, 11, 50)));
    // 90 − 39.77 − 23.44 = 26.8° at solar noon.
    expect(p.elevation).toBeGreaterThan(26);
    expect(p.elevation).toBeLessThan(27.5);
    expect(Math.abs(p.azimuth - 180)).toBeLessThan(3);
  });

  it("rises in the east in the morning", () => {
    const p = sunPosition(39.766, 2.715, new Date(Date.UTC(2026, 4, 20, 7, 0)));
    expect(p.azimuth).toBeGreaterThan(80);
    expect(p.azimuth).toBeLessThan(110);
  });
});

describe("sunVector", () => {
  it("points south (+z) and up for a noon sun", () => {
    const [x, y, z] = sunVector({ elevation: 45, azimuth: 180 });
    expect(Math.abs(x)).toBeLessThan(1e-9);
    expect(y).toBeCloseTo(Math.SQRT1_2);
    expect(z).toBeCloseTo(Math.SQRT1_2);
  });
  it("points east (+x) at azimuth 90", () => {
    const [x, , z] = sunVector({ elevation: 0, azimuth: 90 });
    expect(x).toBeCloseTo(1);
    expect(Math.abs(z)).toBeLessThan(1e-9);
  });
});
