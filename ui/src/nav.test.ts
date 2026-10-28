import { describe, expect, it } from "vitest";
import { clockAfter, maneuverIcon, shortDistance, shortDuration } from "./nav";

describe("navigation arithmetic", () => {
  it("formats distances and durations for a glance", () => {
    expect(shortDistance(843)).toBe("840 m");
    expect(shortDistance(12345)).toBe("12.3 km");
    expect(shortDistance(-5)).toBe("0 m");
    expect(shortDuration(20)).toBe("<1 min");
    expect(shortDuration(38 * 60)).toBe("38 min");
    expect(shortDuration(65 * 60)).toBe("1 h 05 min");
    expect(clockAfter(1800, new Date(2026, 9, 28, 14, 2))).toBe("14:32");
  });

  it("draws an arrow for every maneuver", () => {
    for (const kind of ["straight", "left", "right", "sharp_left", "sharp_right", "u_turn", "arrive"] as const) {
      expect(maneuverIcon(kind)).toContain("<svg");
    }
    expect(maneuverIcon("arrive")).toContain('fill="currentColor"');
    expect(maneuverIcon("left")).not.toContain('fill="currentColor"');
  });
});
