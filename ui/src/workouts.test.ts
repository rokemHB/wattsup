import { describe, expect, it } from "vitest";
import { quickBlock } from "./trainer";
import { averageWatts, describe as describeWorkout, fromPreset, PRESETS, totalSeconds } from "./workouts";

describe("workouts", () => {
  it("builds watts from FTP, rounded to 5", () => {
    const w = fromPreset(PRESETS[0], 213);
    expect(w.steps[0].watts % 5).toBe(0);
    expect(w.steps[1].watts).toBe(190);
    expect(w.steps[0].seconds).toBe(600);
  });
  it("sums and describes", () => {
    const w = { name: "x", steps: [{ watts: 100, seconds: 60 }, { watts: 300, seconds: 60 }] };
    expect(totalSeconds(w)).toBe(120);
    expect(averageWatts(w)).toBe(200);
    expect(describeWorkout(w)).toBe("2 min · 2 steps · avg 200 W");
  });
});

describe("quick block", () => {
  it("wraps the main part in a warm-up and cool-down from FTP", () => {
    const w = quickBlock(30, 180, 5, 5, 250);
    expect(w.name).toBe("30 min at 180 W");
    expect(w.steps.map((s) => [s.watts, s.seconds])).toEqual([
      [140, 300],
      [180, 1800],
      [125, 300],
    ]);
    expect(quickBlock(10, 200, 0, 0, 250).steps).toHaveLength(1);
  });
});
