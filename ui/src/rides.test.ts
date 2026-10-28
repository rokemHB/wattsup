import { describe, expect, it } from "vitest";
import { totals, weeklyDistance, weekStart } from "./rides";
import type { RideSummary } from "./types";

const ride = (startedAt: Date, km: number): RideSummary => ({
  id: `ride-${startedAt.getTime()}`,
  started_at_ms: startedAt.getTime(),
  route: "x",
  world: null,
  workout: null,
  finished: true,
  elapsed_s: 3600,
  stats: {
    moving_s: 3500,
    distance_m: km * 1000,
    ascent_m: 100,
    descent_m: 90,
    avg_power_w: 200,
    max_power_w: 400,
    normalized_power_w: 210,
    avg_heart_rate_bpm: null,
    max_heart_rate_bpm: 0,
    avg_cadence_rpm: 88,
    avg_speed_kmh: 30,
    energy_kj: 720,
  },
});

describe("ride statistics", () => {
  it("starts weeks on Monday", () => {
    expect(weekStart(new Date(2026, 9, 28, 15)).getDay()).toBe(1); // a Wednesday
    expect(weekStart(new Date(2026, 9, 28, 15)).getDate()).toBe(26);
    expect(weekStart(new Date(2026, 9, 26, 0, 30)).getDate()).toBe(26); // Monday stays
    expect(weekStart(new Date(2026, 10, 1)).getDate()).toBe(26); // a Sunday
  });

  it("adds rides up and files them into weeks", () => {
    const now = new Date(2026, 9, 28, 15);
    const rides = [ride(new Date(2026, 9, 27), 40), ride(new Date(2026, 9, 20), 25), ride(new Date(2026, 5, 1), 99)];
    const t = totals(rides);
    expect(t.rides).toBe(3);
    expect(t.distance_m).toBe(164000);
    expect(t.moving_s).toBe(10500);
    const weeks = weeklyDistance(rides, 4, now);
    expect(weeks.map((w) => w.km)).toEqual([0, 0, 25, 40]);
    expect(weeks[3].start.getDate()).toBe(26);
  });
});
