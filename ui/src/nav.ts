// Navigation graphics and arithmetic for the ride HUD: maneuver arrows and time estimates.
import type { Turn } from "./types";

export type ManeuverKind = Turn | "arrive";

/** Arrow shaft and head for each maneuver, in a 48×48 box (y down). */
const SHAPES: Record<ManeuverKind, { shaft: string; head: string }> = {
  straight: { shaft: "M24 42 V12", head: "M14 20 L24 10 L34 20" },
  left: { shaft: "M28 42 V26 Q28 18 20 18 H12", head: "M18 10 L10 18 L18 26" },
  right: { shaft: "M20 42 V26 Q20 18 28 18 H36", head: "M30 10 L38 18 L30 26" },
  sharp_left: { shaft: "M28 42 V20 L12 36", head: "M22 36 L12 36 V26" },
  sharp_right: { shaft: "M20 42 V20 L36 36", head: "M26 36 H36 V26" },
  u_turn: { shaft: "M30 42 V20 A7 7 0 0 0 16 20 V32", head: "M8 24 L16 32 L24 24" },
  arrive: { shaft: "M14 44 V6", head: "M14 8 H36 L30 16 L36 24 H14 Z" },
};

/** A maneuver as inline SVG; `arrive` is a flag. The colour follows `currentColor`. */
export function maneuverIcon(kind: ManeuverKind): string {
  const { shaft, head } = SHAPES[kind];
  const fill = kind === "arrive" ? "currentColor" : "none";
  return (
    `<svg viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${shaft}"/><path d="${head}" fill="${fill}"/></svg>`
  );
}

/** Seconds to the destination at the ride's moving average speed; null until there is a minute of riding to go by. */
export function timeLeft(remainingM: number, avgSpeedKmh: number, movingS: number): number | null {
  if (movingS < 60 || avgSpeedKmh < 3) return null;
  return remainingM / (avgSpeedKmh / 3.6);
}

/** "850 m" below a kilometre (rounded to 10 m), "12.4 km" above. */
export function shortDistance(meters: number): string {
  const m = Math.max(0, meters);
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

/** "1 h 05 min" or "38 min"; under a minute "<1 min". */
export function shortDuration(seconds: number): string {
  const min = Math.round(seconds / 60);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${(min % 60).toString().padStart(2, "0")} min`;
}

/** The wall clock `seconds` from now, as HH:MM. */
export function clockAfter(seconds: number, now = new Date()): string {
  const d = new Date(now.getTime() + seconds * 1000);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}
