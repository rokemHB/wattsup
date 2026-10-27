// Pure helpers for the debug screen, kept apart from the DOM so they are unit-tested.
import type { ConnectionState, DeviceKind, ShiftDirection, TrainerCommand } from "./types";

export const KIND_LABEL: Record<DeviceKind, string> = {
  trainer: "Trainer",
  heart_rate: "Heart rate",
  controller: "Controller",
};

/** A number with fixed decimals, or a dash when there is no reading. */
export function num(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "–" : value.toFixed(digits);
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function distance(meters: number): string {
  return meters < 1000 ? `${meters.toFixed(0)} m` : `${(meters / 1000).toFixed(2)} km`;
}

/** What was last sent to the trainer, in words. */
export function describeCommand(cmd: TrainerCommand | null): { text: string; warning: string | null } {
  if (!cmd) return { text: "nothing yet", warning: null };
  if (cmd.type === "target_power") return { text: `ERG ${cmd.watts} W`, warning: null };
  const sign = cmd.grade_pct >= 0 ? "+" : "";
  const text = `SIM grade ${sign}${cmd.grade_pct.toFixed(2)} %`;
  if (!cmd.clamped) return { text, warning: null };
  const wanted = `${cmd.desired_grade_pct >= 0 ? "+" : ""}${cmd.desired_grade_pct.toFixed(1)} %`;
  return {
    text,
    warning:
      cmd.clamped === "high"
        ? `Wanted ${wanted}: at the trainer's maximum. Shift down for this climb.`
        : `Wanted ${wanted}: at the trainer's minimum.`,
  };
}

export function stateLabel(state: ConnectionState): { label: string; tone: "ok" | "busy" | "bad" | "off" } {
  switch (state.state) {
    case "connected":
      return { label: "connected", tone: "ok" };
    case "connecting":
      return { label: "connecting…", tone: "busy" };
    case "reconnecting":
      return { label: `reconnecting: ${state.detail}`, tone: "busy" };
    case "failed":
      return { label: `failed: ${state.detail}`, tone: "bad" };
    case "disconnected":
      return { label: "not connected", tone: "off" };
  }
}

/**
 * Keyboard shifting. Works whatever controller is connected.
 * Arrow up / "]" / "+" / "=" → harder; arrow down / "[" / "-" → easier.
 */
export function shiftForKey(key: string): ShiftDirection | null {
  switch (key) {
    case "ArrowUp":
    case "]":
    case "+":
    case "=":
      return "up";
    case "ArrowDown":
    case "[":
    case "-":
      return "down";
    default:
      return null;
  }
}

/** True when a key press belongs to a form field rather than the ride. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).tagName !== "string") return false;
  const tag = (target as Element).tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}
