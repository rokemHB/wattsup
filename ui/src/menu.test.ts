import { describe, expect, it } from "vitest";
import { weekSummary } from "./menu";
import type { RideSummary } from "./types";

const ride = (daysAgo: number, km: number, hours: number, now: number): RideSummary =>
  ({ id: "r", started_at_ms: now - daysAgo * 86_400_000, route: "", world: null, workout: null, finished: true, elapsed_s: hours * 3600, stats: { distance_m: km * 1000 } }) as unknown as RideSummary;

describe("weekSummary", () => {
  it("counts the last seven days only", () => {
    const now = Date.UTC(2026, 10, 9);
    const w = weekSummary([ride(1, 40, 1.5, now), ride(6.5, 60, 2, now), ride(8, 100, 4, now)], now);
    expect(w).toEqual({ rides: 2, km: 100, hours: 3.5 });
  });
});
