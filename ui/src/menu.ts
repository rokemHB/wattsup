// The main menu's dashboard: a tile per device (the check before every ride: is the trainer
// there, is the strap reading, are both pucks up), the rider's numbers, this week's riding,
// and a height profile for the route cards.

import { el } from "./dom";
import { stateLabel } from "./format";
import type { DeviceKind, DeviceStatus, EngineSnapshot, RideSummary } from "./types";

const TILES: { kind: DeviceKind; label: string }[] = [
  { kind: "trainer", label: "Trainer" },
  { kind: "heart_rate", label: "Heart rate" },
  { kind: "controller", label: "Controls" },
];

interface Tile {
  root: HTMLButtonElement;
  dot: HTMLElement;
  value: HTMLElement;
  sub: HTMLElement;
}

let tiles: Map<DeviceKind, Tile> | null = null;

/** Builds the tiles into `box`; a click on one opens the devices (`onOpen`). */
export function buildDeviceTiles(box: HTMLElement, onOpen: () => void) {
  tiles = new Map();
  box.replaceChildren(
    ...TILES.map(({ kind, label }) => {
      const dot = el("span", { className: "dot tone-off" });
      const value = el("span", { className: "tile-value" }, "–");
      const sub = el("span", { className: "tile-sub" }, "not connected");
      const root = el("button", { className: "device-tile", title: "Devices" }, el("span", { className: "tile-label" }, dot, label), value, sub);
      root.onclick = onOpen;
      tiles!.set(kind, { root, dot, value, sub });
      return root;
    }),
  );
}

function set(node: HTMLElement, text: string) {
  if (node.textContent !== text) node.textContent = text;
}

/** Live values in the tiles: watts, beats, which pucks are up. Cheap: text changes only. */
export function renderDeviceTiles(snap: EngineSnapshot) {
  if (!tiles) return;
  for (const d of snap.devices) {
    const t = tiles.get(d.kind);
    if (!t) continue;
    const st = stateLabel(d.state);
    const tone = `dot tone-${st.tone}`;
    if (t.dot.className !== tone) t.dot.className = tone;
    t.root.classList.toggle("ready", d.state.state === "connected");
    set(t.value, tileValue(d, snap));
    const battery = d.battery_percent === null ? "" : ` · ${d.battery_percent} %`;
    // A lost link's reason is a sentence: it goes in the small line (cut to fit) and the tooltip.
    const detail = d.state.state === "failed" || d.state.state === "reconnecting" ? d.state.detail : "";
    set(t.sub, d.state.state === "disconnected" ? "not connected · click to pair" : detail || `${d.name ?? d.id ?? ""}${battery}`);
    const title = detail ? `${d.name ?? d.id ?? ""}: ${detail}` : "Devices";
    if (t.root.title !== title) t.root.title = title;
  }
}

/** A word or two that fits the tile; the details go underneath. */
const SHORT_STATE: Record<DeviceStatus["state"]["state"], string> = {
  connected: "ready",
  connecting: "connecting…",
  reconnecting: "reconnecting…",
  failed: "lost",
  disconnected: "–",
};

function tileValue(d: DeviceStatus, snap: EngineSnapshot): string {
  if (d.state.state !== "connected") return SHORT_STATE[d.state.state];
  const s = snap.session;
  if (d.kind === "trainer") return s.power_w === null ? "ready" : `${Math.round(s.power_w)} W`;
  if (d.kind === "heart_rate") return s.heart_rate_bpm === null ? "no reading" : `${Math.round(s.heart_rate_bpm)} bpm`;
  const parts = d.parts ?? [];
  if (parts.length) {
    const up = (side: string) => parts.find((p) => p.part === side)?.state.state === "connected";
    return `L ${up("left") ? "●" : "○"}  R ${up("right") ? "●" : "○"}`;
  }
  return "ready";
}

/** "This week": rides, distance and time over the last seven days. */
export function weekSummary(rides: RideSummary[], now = Date.now()): { rides: number; km: number; hours: number } {
  const week = rides.filter((r) => now - r.started_at_ms < 7 * 24 * 3600 * 1000);
  return {
    rides: week.length,
    km: week.reduce((a, r) => a + r.stats.distance_m, 0) / 1000,
    hours: week.reduce((a, r) => a + r.elapsed_s, 0) / 3600,
  };
}

export function renderWeek(box: HTMLElement, rides: RideSummary[]) {
  const w = weekSummary(rides);
  const h = Math.floor(w.hours);
  const m = Math.round((w.hours - h) * 60);
  const stat = (value: string, label: string) => el("div", { className: "week-stat" }, el("b", {}, value), el("span", {}, label));
  box.replaceChildren(
    el("span", { className: "eyebrow" }, "Last 7 days"),
    el("div", { className: "week-stats" }, stat(String(w.rides), w.rides === 1 ? "ride" : "rides"), stat(w.km.toFixed(0), "km"), stat(`${h}:${String(m).padStart(2, "0")}`, "hours")),
  );
}

const SVG = "http://www.w3.org/2000/svg";

/** A small height profile: an area under the route's elevations, `w`×`h` pixels. */
export function profileSvg(heights: number[], w = 120, h = 34): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.classList.add("profile");
  if (heights.length < 2) return svg;
  const lo = Math.min(...heights);
  // Flat routes stay flat: at least 60 m of height fills the box.
  const span = Math.max(60, Math.max(...heights) - lo);
  const pts = heights.map((y, i) => `${((i / (heights.length - 1)) * w).toFixed(1)},${(h - 2 - ((y - lo) / span) * (h - 4)).toFixed(1)}`);
  const area = document.createElementNS(SVG, "path");
  area.setAttribute("d", `M0,${h} L${pts.join(" L")} L${w},${h} Z`);
  area.setAttribute("class", "profile-area");
  const line = document.createElementNS(SVG, "polyline");
  line.setAttribute("points", pts.join(" "));
  line.setAttribute("class", "profile-line");
  svg.append(area, line);
  return svg;
}
