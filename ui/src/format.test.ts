import { describe, expect, it } from "vitest";
import { describeCommand, distance, duration, num, shiftForKey, stateLabel, isTypingTarget } from "./format";

describe("formatting", () => {
  it("shows a dash for missing readings", () => {
    expect(num(null)).toBe("–");
    expect(num(undefined)).toBe("–");
    expect(num(Number.NaN)).toBe("–");
    expect(num(212.4)).toBe("212");
    expect(num(88.25, 1)).toBe("88.3");
  });

  it("formats time and distance", () => {
    expect(duration(0)).toBe("00:00");
    expect(duration(75.9)).toBe("01:15");
    expect(duration(3723)).toBe("1:02:03");
    expect(distance(850)).toBe("850 m");
    expect(distance(12345)).toBe("12.35 km");
  });
});

describe("trainer commands", () => {
  const sim = { crr: 0.004, cw_kg_per_m: 0, wind_mps: 0 };
  it("describes SIM and ERG", () => {
    expect(describeCommand(null).text).toBe("nothing yet");
    expect(describeCommand({ type: "target_power", watts: 220 })).toEqual({ text: "ERG 220 W", warning: null });
    const flat = describeCommand({ type: "simulation", grade_pct: 1.234, desired_grade_pct: 1.234, clamped: null, ...sim });
    expect(flat).toEqual({ text: "SIM grade +1.23 %", warning: null });
  });

  it("warns when the trainer range is exceeded", () => {
    const steep = describeCommand({ type: "simulation", grade_pct: 20, desired_grade_pct: 31.7, clamped: "high", ...sim });
    expect(steep.warning).toContain("+31.7 %");
    expect(steep.warning).toContain("Shift down");
  });
});

describe("connection state", () => {
  it("labels every state", () => {
    expect(stateLabel({ state: "connected" }).tone).toBe("ok");
    expect(stateLabel({ state: "reconnecting", detail: "link lost" }).label).toBe("reconnecting: link lost");
    expect(stateLabel({ state: "failed", detail: "x" }).tone).toBe("bad");
    expect(stateLabel({ state: "disconnected" }).tone).toBe("off");
  });
});

describe("keyboard shifting", () => {
  it("maps keys to directions", () => {
    expect(shiftForKey("ArrowUp")).toBe("up");
    expect(shiftForKey("]")).toBe("up");
    expect(shiftForKey("ArrowDown")).toBe("down");
    expect(shiftForKey("[")).toBe("down");
    expect(shiftForKey("a")).toBeNull();
  });

  it("ignores keys typed into form fields", () => {
    expect(isTypingTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "DIV" } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
