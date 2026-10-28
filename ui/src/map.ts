// The map screen: the island picture with the rideable roads drawn over it,
// a route planner on top (start, destination, waypoints; drag the line to
// bend it through somewhere else) and free-ride starts, all from a menu that
// opens where you click. Everything that is drawn per frame is prebuilt: the
// roads are canvas paths, the route is a path rebuilt only when it changes,
// and a redraw happens at most once per animation frame.
import { $, el } from "./dom";
import { elevationGain, type PlannedPath, Router } from "./routing";
import type { Place } from "./types";
import { NetworkIndex, type RoadNetwork } from "./world/network";
import { Frame } from "./world/streaming";
import type { NetworkWorldData } from "./world/terrain";

/** A point on a road: local position, edge and global point index. */
export interface RoadSpot {
  x: number;
  z: number;
  edge: number;
  i: number;
}

interface Waypoint extends RoadSpot {
  name: string;
}

export interface SavedPlan {
  name: string;
  world: string;
  waypoints: { x: number; z: number }[];
  length_m: number;
}

export interface MapCallbacks {
  freeRide(at: RoadSpot, forward: boolean): void;
  plannedRide(path: PlannedPath, name: string, start: RoadSpot): void;
}

/** Distance (canvas pixels) within which the route line or a waypoint counts as hit. */
const LINE_HIT_PX = 9;
const WAYPOINT_HIT_PX = 13;

type Drag =
  | { kind: "pan"; x: number; y: number; ox: number; oy: number; moved: boolean }
  | { kind: "waypoint"; index: number; x: number; y: number; moved: boolean; inserted: boolean };

const STORAGE = "wattsup.plans";

export function loadPlans(): SavedPlan[] {
  try {
    const raw = localStorage.getItem(STORAGE);
    return raw ? (JSON.parse(raw) as SavedPlan[]) : [];
  } catch {
    return [];
  }
}

function storePlans(plans: SavedPlan[]) {
  localStorage.setItem(STORAGE, JSON.stringify(plans));
}

export class MapScreen {
  private canvas = $<HTMLCanvasElement>("map-canvas");
  private net: RoadNetwork | null = null;
  private index: NetworkIndex | null = null;
  private world: NetworkWorldData | null = null;
  private router: Router | null = null;
  private frame = new Frame(0, 0);
  /** Map-image pixel of every network point (x, y pairs), so paths and hit tests never convert coordinates. */
  private pointPx = new Float32Array(0);
  private metersPerPx = 1;
  private roads: { byKind: { kind: number; path: Path2D }[]; bounds: { x0: number; y0: number; x1: number; y1: number }; places: Place[] } | null = null;
  /** Map pixel at the canvas origin, and map pixels per canvas pixel. */
  private view = { ox: 0, oy: 0, scale: 0 };
  private drag: Drag | null = null;
  private drawQueued = false;
  private hover: { point: number } | null = null;
  private hoverWaypoint = -1;
  private popup: RoadSpot | null = null;
  private waypoints: Waypoint[] = [];
  private path: PlannedPath | null = null;
  private routePath: Path2D | null = null;
  private segmentPaths = new Map<string, Path2D>();
  private statsDirty = false;
  /** The latest cursor position of a waypoint drag, applied once per frame however fast the mouse reports. */
  private pendingDrag: { index: number; cx: number; cy: number } | null = null;
  private nameEdited = false;
  private plans: SavedPlan[] = loadPlans();
  /** Called when the saved plans change, so the main menu can list them. */
  onPlansChanged: (() => void) | null = null;

  constructor(private cb: MapCallbacks) {
    this.wire();
  }

  /** Shows a network on the map: resets the view and the plan. */
  open(net: RoadNetwork, index: NetworkIndex, world: NetworkWorldData) {
    if (this.net !== net) {
      this.net = net;
      this.index = index;
      this.world = world;
      this.router = new Router(net);
      this.frame = new Frame(world.origin.lat, world.origin.lon);
      const m = world.map!;
      this.metersPerPx = (this.frame.kx * (m.lon_max - m.lon_min)) / m.image.width;
      this.pointPx = new Float32Array(net.points * 2);
      for (let i = 0; i < net.points; i++) {
        const [px, py] = this.mapPixel(net.xyz[i * 3], net.xyz[i * 3 + 2]);
        this.pointPx[i * 2] = px;
        this.pointPx[i * 2 + 1] = py;
      }
      this.roads = this.buildRoads();
    }
    this.view.scale = 0;
    this.clear();
    this.renderSaved();
    this.hint("Click a road to plan a route or to ride from there. Scroll to zoom, drag to pan.");
    requestAnimationFrame(() => this.draw());
  }

  /** Plans a route through these positions (lat, lon pairs), snapped to the roads. */
  planThrough(latLon: [number, number][]) {
    const spots = latLon.map(([lat, lon]) => {
      const [x, z] = this.frame.toXZ(lat, lon);
      return this.snap(x, z, 5000);
    });
    this.waypoints = spots.filter((s): s is RoadSpot => !!s).map((s) => ({ ...s, name: this.nameOf(s) }));
    this.reroute();
    this.renderPlan();
  }

  /** Loads a saved plan: its waypoints snapped to the current roads. */
  load(plan: SavedPlan) {
    this.waypoints = plan.waypoints.map((w) => this.snap(w.x, w.z, 2000)).filter((s): s is RoadSpot => !!s).map((s) => ({ ...s, name: this.nameOf(s) }));
    this.nameEdited = true;
    $<HTMLInputElement>("map-route-name").value = plan.name;
    this.reroute();
    this.renderPlan();
    this.fitRoute();
  }

  /** Escape: closes the click menu. Returns true when something was closed. */
  escape(): boolean {
    if (!this.popup) return false;
    this.closePopup();
    return true;
  }

  savedPlans(): SavedPlan[] {
    return this.plans;
  }

  // --- geometry -----------------------------------------------------------------

  private mapPixel(x: number, z: number): [number, number] {
    const m = this.world!.map!;
    const [lat, lon] = this.frame.toLatLon(x, z);
    return [((lon - m.lon_min) / (m.lon_max - m.lon_min)) * m.image.width, ((m.lat_max - lat) / (m.lat_max - m.lat_min)) * m.image.height];
  }

  private localOf(px: number, py: number): [number, number] {
    const m = this.world!.map!;
    const lon = m.lon_min + (px / m.image.width) * (m.lon_max - m.lon_min);
    const lat = m.lat_max - (py / m.image.height) * (m.lat_max - m.lat_min);
    return this.frame.toXZ(lat, lon);
  }

  /** Canvas position of a global network point. */
  private canvasOfPoint(i: number): [number, number] {
    const s = this.view.scale;
    return [(this.pointPx[i * 2] - this.view.ox) / s, (this.pointPx[i * 2 + 1] - this.view.oy) / s];
  }

  private mouse(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** The nearest road point to a canvas position within `radiusPx`, as a spot. */
  private snapCanvas(cx: number, cy: number, radiusPx: number): RoadSpot | null {
    const [x, z] = this.localOf(this.view.ox + cx * this.view.scale, this.view.oy + cy * this.view.scale);
    return this.snap(x, z, Math.min(2500, radiusPx * this.view.scale * this.metersPerPx));
  }

  private snap(x: number, z: number, radiusM: number): RoadSpot | null {
    const near = this.index!.nearest(x, z, radiusM);
    if (near.i < 0 || near.d > radiusM) return null;
    const xyz = this.net!.xyz;
    return { x: xyz[near.i * 3], z: xyz[near.i * 3 + 2], edge: near.edge, i: near.i };
  }

  /** The waypoint under a canvas position, or -1. */
  private waypointAt(cx: number, cy: number): number {
    for (let k = this.waypoints.length - 1; k >= 0; k--) {
      const [wx, wy] = this.canvasOfPoint(this.waypoints[k].i);
      if (Math.hypot(wx - cx, wy - cy) <= WAYPOINT_HIT_PX) return k;
    }
    return -1;
  }

  /** The index into the route's points nearest a canvas position within the hit distance, or -1. */
  private routePointAt(cx: number, cy: number): number {
    if (!this.path) return -1;
    const s = this.view.scale;
    const px = this.view.ox + cx * s;
    const py = this.view.oy + cy * s;
    const r = LINE_HIT_PX * s;
    let best = r * r;
    let bi = -1;
    const pts = this.path.points;
    const pp = this.pointPx;
    for (let k = 0; k < pts.length; k++) {
      const dx = pp[pts[k] * 2] - px;
      const dy = pp[pts[k] * 2 + 1] - py;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        bi = k;
      }
    }
    return bi;
  }

  /** A short name for a spot: the nearest town or village, a hamlet close by, else the road. */
  private nameOf(spot: RoadSpot): string {
    const net = this.net!;
    let best: { name: string; d: number } | null = null;
    for (const pl of net.places) {
      const d = Math.hypot(pl.x - spot.x, pl.z - spot.z);
      const reach = pl.kind === "hamlet" ? 1500 : 2500;
      if (d < reach && (!best || d < best.d)) best = { name: pl.name, d };
    }
    if (best) return best.name;
    const e = net.edges[spot.edge];
    return e.ref ?? e.name ?? "road";
  }

  /** "Ma-10 toward Sóller": the edge ridden toward one of its ends. */
  private directionLabel(edge: number, towardB: boolean): string {
    const net = this.net!;
    const e = net.edges[edge];
    const node = net.nodes[towardB ? e.b : e.a];
    let best: { name: string; d: number } | null = null;
    for (const pl of net.places) {
      if (pl.kind === "hamlet") continue;
      const d = Math.hypot(pl.x - node.x, pl.z - node.z);
      if (d < 6000 && (!best || d < best.d)) best = { name: pl.name, d };
    }
    const road = e.ref ?? e.name ?? "road";
    if (best) return `${road} toward ${best.name}`;
    const from = net.nodes[towardB ? e.a : e.b];
    const dirs = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];
    const idx = Math.round((Math.atan2(node.z - from.z, node.x - from.x) / (Math.PI / 4) + 8) % 8);
    return `${road} ${dirs[idx]}`;
  }

  // --- the plan -------------------------------------------------------------------

  /** Re-plans the route through the waypoints. The line and the statistics follow at the next frame. */
  private reroute(schedule = true) {
    const router = this.router!;
    this.path = this.waypoints.length >= 2 ? router.routeAll(this.waypoints) : null;
    this.routePath = null;
    this.statsDirty = true;
    if (schedule) this.scheduleDraw();
  }

  /** Moves the dragged waypoint to the road under the cursor's last known position. */
  private applyPendingDrag() {
    const d = this.pendingDrag;
    this.pendingDrag = null;
    if (!d || !this.waypoints[d.index]) return;
    const spot = this.snapCanvas(d.cx, d.cy, 60);
    if (spot && spot.i !== this.waypoints[d.index].i) {
      this.setWaypoint(d.index, spot);
      this.reroute(false);
    }
  }

  /** The route as a canvas path, assembled from one cached path per piece between waypoints. */
  private buildRoutePath(): Path2D | null {
    if (!this.path) return null;
    const out = new Path2D();
    const pts = this.path.points;
    const stops = this.path.stops;
    const pp = this.pointPx;
    for (let k = 0; k + 1 < stops.length; k++) {
      const a = stops[k];
      const b = stops[k + 1];
      if (b <= a) continue;
      const key = `${pts[a]}>${pts[b]}`;
      let seg = this.segmentPaths.get(key);
      if (!seg) {
        seg = new Path2D();
        seg.moveTo(pp[pts[a] * 2], pp[pts[a] * 2 + 1]);
        for (let i = a + 1; i <= b; i++) seg.lineTo(pp[pts[i] * 2], pp[pts[i] * 2 + 1]);
        if (this.segmentPaths.size > 200) this.segmentPaths.clear();
        this.segmentPaths.set(key, seg);
      }
      out.addPath(seg);
    }
    return out;
  }

  private clear() {
    this.waypoints = [];
    this.path = null;
    this.routePath = null;
    this.hover = null;
    this.nameEdited = false;
    this.closePopup();
    this.renderPlan();
  }

  private autoName(): string {
    const w = this.waypoints;
    if (w.length < 2) return "";
    const a = w[0].name;
    const b = w[w.length - 1].name;
    return a === b ? `${a} loop` : `${a} → ${b}`;
  }

  private setWaypoint(index: number, spot: RoadSpot) {
    this.waypoints[index] = { ...spot, name: this.nameOf(spot) };
  }

  /** Inserts a waypoint where it lengthens the route least. */
  private addWaypoint(spot: RoadSpot) {
    const w = this.waypoints;
    if (w.length < 2) {
      w.push({ ...spot, name: this.nameOf(spot) });
      return;
    }
    const router = this.router!;
    let best = { k: w.length - 1, extra: Infinity };
    for (let k = 0; k < w.length - 1; k++) {
      const base = router.route(w[k], w[k + 1])?.length_m ?? 0;
      const a = router.route(w[k], spot)?.length_m;
      const b = router.route(spot, w[k + 1])?.length_m;
      if (a === undefined || b === undefined) continue;
      const extra = a + b - base;
      if (extra < best.extra) best = { k, extra };
    }
    w.splice(best.k + 1, 0, { ...spot, name: this.nameOf(spot) });
  }

  private commit() {
    this.reroute();
    this.renderPlan();
  }

  // --- the click menu -------------------------------------------------------------

  private openPopup(spot: RoadSpot, cx: number, cy: number, waypoint: number) {
    this.popup = spot;
    const net = this.net!;
    const e = net.edges[spot.edge];
    const box = $("map-popup");
    const road = `${e.ref ?? ""} ${e.name ?? ""}`.trim() || "unnamed road";
    $("map-popup-title").textContent = waypoint >= 0 ? this.waypointLabel(waypoint) : this.nameOf(spot);
    $("map-popup-sub").textContent = road;
    const actions: HTMLElement[] = [];
    const act = (label: string, primary: boolean, f: () => void) => {
      const b = el("button", { className: primary ? "primary" : "", textContent: label });
      b.onclick = () => {
        this.closePopup();
        f();
        this.commit();
      };
      actions.push(b);
    };
    const n = this.waypoints.length;
    if (waypoint >= 0) {
      act("Remove", false, () => this.waypoints.splice(waypoint, 1));
      if (waypoint !== 0) act("Make it the start", false, () => this.waypoints.unshift(...this.waypoints.splice(waypoint, 1)));
      if (waypoint !== n - 1) act("Make it the destination", false, () => this.waypoints.push(...this.waypoints.splice(waypoint, 1)));
    } else if (n === 0) {
      act("Start here", true, () => this.waypoints.push({ ...spot, name: this.nameOf(spot) }));
    } else if (n === 1) {
      act("Destination here", true, () => this.waypoints.push({ ...spot, name: this.nameOf(spot) }));
      act("Start here instead", false, () => this.setWaypoint(0, spot));
    } else {
      act("Add to the route", true, () => this.addWaypoint(spot));
      act("New destination", false, () => this.setWaypoint(n - 1, spot));
      act("New start", false, () => this.setWaypoint(0, spot));
    }
    if (waypoint < 0) {
      const ride = (forward: boolean) => {
        const b = el("button", { className: "free", textContent: `Free ride ${this.directionLabel(spot.edge, forward)}` });
        b.onclick = () => {
          this.closePopup();
          this.cb.freeRide(spot, forward);
        };
        actions.push(b);
      };
      ride(true);
      ride(false);
    }
    $("map-popup-actions").replaceChildren(...actions);
    box.hidden = false;
    // Keep the menu inside the map.
    const stage = this.canvas.parentElement!.getBoundingClientRect();
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    box.style.left = `${Math.min(cx + 12, stage.width - bw - 8)}px`;
    box.style.top = `${Math.min(cy + 12, stage.height - bh - 8)}px`;
    this.scheduleDraw();
  }

  private closePopup() {
    this.popup = null;
    $("map-popup").hidden = true;
    this.scheduleDraw();
  }

  // --- the side panel ---------------------------------------------------------------

  private waypointLabel(k: number): string {
    const n = this.waypoints.length;
    if (k === 0) return "Start";
    if (k === n - 1) return "Destination";
    return `Waypoint ${k}`;
  }

  private hint(text: string) {
    $("map-hint").textContent = text;
  }

  private renderPlan() {
    const list = $("map-waypoints");
    const w = this.waypoints;
    list.replaceChildren(
      ...w.map((wp, k) => {
        const n = w.length;
        const mark = el("span", { className: `mark ${k === 0 ? "start" : k === n - 1 ? "end" : "via"}` }, k === 0 ? "A" : k === n - 1 ? "B" : String(k));
        const remove = el("button", { className: "small", textContent: "×", title: "Remove" });
        remove.onclick = () => {
          w.splice(k, 1);
          this.commit();
        };
        return el("li", {}, mark, el("span", { className: "name" }, wp.name), remove);
      }),
    );
    $("map-empty").hidden = w.length > 0;
    const name = $<HTMLInputElement>("map-route-name");
    if (!this.nameEdited) name.value = this.autoName();
    $("map-plan").hidden = w.length === 0;
    $<HTMLButtonElement>("map-ride").disabled = !this.path;
    $<HTMLButtonElement>("map-save").disabled = !this.path;
    $<HTMLButtonElement>("map-reverse").disabled = w.length < 2;
    if (w.length === 1) this.hint("Now click where the ride should end.");
    else if (w.length >= 2) this.hint("Drag the route to bend it through somewhere else; click a road to add it.");
    this.renderStats();
  }

  private renderStats() {
    const stats = $("map-stats");
    const profile = $<HTMLCanvasElement>("map-profile");
    if (!this.path) {
      stats.hidden = true;
      profile.hidden = true;
      if (this.waypoints.length >= 2) this.hint("No road joins these points.");
      return;
    }
    stats.hidden = false;
    profile.hidden = false;
    const { ascent, descent } = elevationGain(this.net!, this.path.points);
    $("map-stat-km").textContent = (this.path.length_m / 1000).toFixed(1);
    $("map-stat-up").textContent = String(Math.round(ascent));
    $("map-stat-down").textContent = String(Math.round(descent));
    this.drawProfile(profile);
  }

  private drawProfile(canvas: HTMLCanvasElement) {
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 80;
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const all = this.path!.points;
    const xyz = this.net!.xyz;
    // Points are 5 m apart; a couple per pixel is plenty for the picture.
    const stride = Math.max(1, Math.floor(all.length / (w * 2)));
    const n = Math.ceil(all.length / stride);
    let min = Infinity;
    let max = -Infinity;
    const ys = new Float32Array(n);
    const ds = new Float32Array(n);
    let d = 0;
    for (let k = 0; k < n; k++) {
      const i = all[Math.min(all.length - 1, k * stride)];
      const y = xyz[i * 3 + 1];
      ys[k] = y;
      if (k) {
        const j = all[Math.min(all.length - 1, (k - 1) * stride)];
        d += Math.hypot(xyz[i * 3] - xyz[j * 3], xyz[i * 3 + 2] - xyz[j * 3 + 2]);
      }
      ds[k] = d;
      if (y < min) min = y;
      if (y > max) max = y;
    }
    const span = Math.max(50, max - min);
    const pad = 4;
    const top = 14;
    const yOf = (y: number) => h - pad - ((y - min) / span) * (h - pad - top);
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let k = 0; k < n; k++) ctx.lineTo((ds[k] / d) * w, yOf(ys[k]));
    ctx.lineTo(w, h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, top, 0, h);
    g.addColorStop(0, "rgba(64, 200, 255, 0.55)");
    g.addColorStop(1, "rgba(64, 200, 255, 0.08)");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.beginPath();
    for (let k = 0; k < n; k++) ctx.lineTo((ds[k] / d) * w, yOf(ys[k]));
    ctx.strokeStyle = "#40c8ff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#8892a8";
    ctx.font = "11px sans-serif";
    ctx.fillText(`${Math.round(max)} m`, 4, 11);
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(min)} m`, w - 4, h - 6);
    ctx.textAlign = "left";
  }

  private renderSaved() {
    const box = $("map-saved");
    const mine = this.plans.filter((p) => p.world === this.world?.id);
    $("map-saved-title").hidden = !mine.length;
    box.replaceChildren(
      ...mine.map((plan) => {
        const row = el("div", { className: "saved-route" });
        const open = el("button", { className: "name" }, plan.name, el("span", { className: "meta" }, `${(plan.length_m / 1000).toFixed(1)} km`));
        open.onclick = () => this.load(plan);
        const remove = el("button", { className: "small", textContent: "×", title: "Delete" });
        remove.onclick = () => {
          this.plans = this.plans.filter((p) => p !== plan);
          storePlans(this.plans);
          this.renderSaved();
          this.onPlansChanged?.();
        };
        row.append(open, remove);
        return row;
      }),
    );
  }

  private save() {
    if (!this.path || !this.world) return;
    const name = $<HTMLInputElement>("map-route-name").value.trim() || this.autoName();
    const plan: SavedPlan = { name, world: this.world.id, waypoints: this.waypoints.map((w) => ({ x: w.x, z: w.z })), length_m: this.path.length_m };
    this.plans = [...this.plans.filter((p) => !(p.world === plan.world && p.name === name)), plan];
    storePlans(this.plans);
    this.renderSaved();
    this.onPlansChanged?.();
    this.hint(`Saved "${name}". It is in the main menu too.`);
  }

  /** Zooms the view to the route. */
  private fitRoute() {
    if (!this.path) return;
    const pp = this.pointPx;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of this.path.points) {
      x0 = Math.min(x0, pp[i * 2]);
      x1 = Math.max(x1, pp[i * 2]);
      y0 = Math.min(y0, pp[i * 2 + 1]);
      y1 = Math.max(y1, pp[i * 2 + 1]);
    }
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const s = Math.min(40, Math.max(0.5, Math.max((x1 - x0) / w, (y1 - y0) / h) * 1.3));
    this.view.scale = s;
    this.view.ox = (x0 + x1) / 2 - (w / 2) * s;
    this.view.oy = (y0 + y1) / 2 - (h / 2) * s;
    this.scheduleDraw();
  }

  // --- drawing ----------------------------------------------------------------------

  private buildRoads() {
    const net = this.net!;
    const pp = this.pointPx;
    const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const byKind = [3, 2, 1, 0].map((kind) => ({ kind, path: new Path2D() }));
    for (const e of net.edges) {
      const path = byKind.find((k) => k.kind === e.kind)?.path ?? byKind[0].path;
      for (let i = e.start; i < e.start + e.count; i++) {
        const px = pp[i * 2];
        const py = pp[i * 2 + 1];
        if (i === e.start) path.moveTo(px, py);
        else path.lineTo(px, py);
        if (px < bounds.x0) bounds.x0 = px;
        if (px > bounds.x1) bounds.x1 = px;
        if (py < bounds.y0) bounds.y0 = py;
        if (py > bounds.y1) bounds.y1 = py;
      }
    }
    // Only the places along the rideable roads get a label; the rest of the island is just the picture.
    const places = net.places.filter((pl) => this.index!.nearest(pl.x, pl.z, 2500).d < 2500);
    return { byKind, bounds, places };
  }

  scheduleDraw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.applyPendingDrag();
      this.draw();
    });
  }

  draw() {
    if (!this.world?.map || !this.net || !this.roads || this.canvas.closest("section")?.hidden) return;
    if (this.statsDirty) {
      this.statsDirty = false;
      this.renderStats();
    }
    const canvas = this.canvas;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const img = this.world.map.image;
    const view = this.view;
    if (!view.scale) {
      // Fit the roads' extent: the Tramuntana, not the whole island.
      const b = this.roads.bounds;
      view.scale = Math.max((b.x1 - b.x0) / w, (b.y1 - b.y0) / h) * 1.05;
      view.ox = (b.x0 + b.x1) / 2 - (w / 2) * view.scale;
      view.oy = (b.y0 + b.y1) / 2 - (h / 2) * view.scale;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0b0d14";
    ctx.fillRect(0, 0, w, h);
    const s = view.scale;
    // Only the part of the image inside the view: WebKit draws nothing when the source rectangle leaves the image.
    const sx0 = Math.max(0, view.ox);
    const sy0 = Math.max(0, view.oy);
    const sx1 = Math.min(img.width, view.ox + w * s);
    const sy1 = Math.min(img.height, view.oy + h * s);
    if (sx1 > sx0 && sy1 > sy0) ctx.drawImage(img, sx0, sy0, sx1 - sx0, sy1 - sy0, (sx0 - view.ox) / s, (sy0 - view.oy) / s, (sx1 - sx0) / s, (sy1 - sy0) / s);
    // Roads and the route: prebuilt paths in map-image pixels, drawn through the view transform.
    ctx.save();
    ctx.setTransform(dpr / s, 0, 0, dpr / s, (-view.ox * dpr) / s, (-view.oy * dpr) / s);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const { kind, path } of this.roads.byKind) {
      ctx.strokeStyle = kind === 0 ? "#ffd166" : kind === 1 ? "#ffffff" : kind === 2 ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.35)";
      ctx.lineWidth = (kind <= 1 ? 2.2 : 1.2) * s;
      ctx.stroke(path);
    }
    if (!this.routePath && this.path) this.routePath = this.buildRoutePath();
    if (this.routePath) {
      ctx.strokeStyle = "rgba(0, 20, 40, 0.8)";
      ctx.lineWidth = 8 * s;
      ctx.stroke(this.routePath);
      ctx.strokeStyle = "#40c8ff";
      ctx.lineWidth = 4.5 * s;
      ctx.stroke(this.routePath);
    }
    ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = "bold 12px sans-serif";
    for (const pl of this.roads.places) {
      if (pl.kind === "hamlet" && s > 6) continue;
      if (pl.kind === "village" && s > 12) continue;
      const [px, py] = this.mapPixel(pl.x, pl.z);
      const cx = (px - view.ox) / s;
      const cy = (py - view.oy) / s;
      if (cx < 0 || cy < 0 || cx > w || cy > h) continue;
      ctx.fillStyle = "#0f121b";
      ctx.fillText(pl.name, cx + 7, cy + 5);
      ctx.fillStyle = pl.kind === "town" || pl.kind === "city" ? "#ffffff" : "rgba(255,255,255,0.8)";
      ctx.fillText(pl.name, cx + 6, cy + 4);
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // The drag handle on the route.
    if (this.hover && this.path && !this.drag) {
      const [cx, cy] = this.canvasOfPoint(this.path.points[this.hover.point]);
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#40c8ff";
      ctx.stroke();
    }
    // Waypoints: lettered start and destination, numbered stops between.
    const n = this.waypoints.length;
    this.waypoints.forEach((wp, k) => {
      const [cx, cy] = this.canvasOfPoint(wp.i);
      const end = k === 0 || k === n - 1;
      const r = end ? 11 : 8;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = k === 0 ? "#3ddc84" : k === n - 1 ? "#ff5c5c" : "#ffffff";
      ctx.fill();
      ctx.lineWidth = k === this.hoverWaypoint ? 3 : 2;
      ctx.strokeStyle = "#0b0d14";
      ctx.stroke();
      ctx.fillStyle = "#0b0d14";
      ctx.font = end ? "bold 13px sans-serif" : "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(k === 0 ? "A" : k === n - 1 ? "B" : String(k), cx, cy + 0.5);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    });
    if (this.popup) {
      const [cx, cy] = this.canvasOfPoint(this.popup.i);
      ctx.beginPath();
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,196,0,0.35)";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ffc400";
      ctx.stroke();
    }
  }

  // --- input ------------------------------------------------------------------------

  private wire() {
    const canvas = this.canvas;
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (!this.view.scale) return;
      const [mx, my] = this.mouse(e);
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      const ns = Math.min(40, Math.max(0.5, this.view.scale * factor));
      this.view.ox += mx * (this.view.scale - ns);
      this.view.oy += my * (this.view.scale - ns);
      this.view.scale = ns;
      if (this.popup) this.closePopup();
      this.scheduleDraw();
    });
    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !this.net) return;
      const [cx, cy] = this.mouse(e);
      if (this.popup) this.closePopup();
      const wp = this.waypointAt(cx, cy);
      if (wp >= 0) {
        this.drag = { kind: "waypoint", index: wp, x: e.clientX, y: e.clientY, moved: false, inserted: false };
        return;
      }
      const rp = this.routePointAt(cx, cy);
      if (rp >= 0 && this.path) {
        // Grab the line: a new waypoint goes in between the stops this piece of route joins.
        const stops = this.path.stops;
        let k = 0;
        while (k < stops.length - 2 && rp > stops[k + 1]) k++;
        const i = this.path.points[rp];
        const spot = { x: this.net.xyz[i * 3], z: this.net.xyz[i * 3 + 2], edge: this.index!.edgeOfPoint(i), i };
        this.waypoints.splice(k + 1, 0, { ...spot, name: this.nameOf(spot) });
        this.drag = { kind: "waypoint", index: k + 1, x: e.clientX, y: e.clientY, moved: false, inserted: true };
        this.hover = null;
        this.scheduleDraw();
        return;
      }
      this.drag = { kind: "pan", x: e.clientX, y: e.clientY, ox: this.view.ox, oy: this.view.oy, moved: false };
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.net) return;
      const drag = this.drag;
      if (!drag) {
        if (this.canvas.closest("section")?.hidden) return;
        const [cx, cy] = this.mouse(e);
        const inside = cx >= 0 && cy >= 0 && cx <= canvas.clientWidth && cy <= canvas.clientHeight;
        const wp = inside ? this.waypointAt(cx, cy) : -1;
        const rp = inside && wp < 0 ? this.routePointAt(cx, cy) : -1;
        const hover = rp >= 0 ? { point: rp } : null;
        if (wp !== this.hoverWaypoint || (hover?.point ?? -1) !== (this.hover?.point ?? -1)) {
          this.hoverWaypoint = wp;
          this.hover = hover;
          canvas.style.cursor = wp >= 0 ? "grab" : hover ? "copy" : "crosshair";
          this.scheduleDraw();
        }
        return;
      }
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
      if (drag.kind === "pan") {
        this.view.ox = drag.ox - (e.clientX - drag.x) * this.view.scale;
        this.view.oy = drag.oy - (e.clientY - drag.y) * this.view.scale;
        this.scheduleDraw();
        return;
      }
      if (!drag.moved) return;
      const [cx, cy] = this.mouse(e);
      this.pendingDrag = { index: drag.index, cx, cy };
      this.scheduleDraw();
    });
    window.addEventListener("mouseup", (e) => {
      const drag = this.drag;
      this.drag = null;
      if (!drag || !this.net || this.canvas.closest("section")?.hidden) return;
      const [cx, cy] = this.mouse(e);
      if (drag.kind === "waypoint") {
        if (!drag.moved) {
          if (drag.inserted) {
            // A click on the line, not a drag: nothing changes.
            this.waypoints.splice(drag.index, 1);
            this.reroute();
          } else {
            this.openPopup(this.waypoints[drag.index], cx, cy, drag.index);
          }
          return;
        }
        this.applyPendingDrag();
        canvas.style.cursor = "crosshair";
        this.hoverWaypoint = -1;
        this.commit();
        return;
      }
      if (drag.moved) return; // it was a pan
      const spot = this.snapCanvas(cx, cy, 40);
      if (!spot) {
        this.hint("No road near there. Click closer to a road.");
        return;
      }
      this.openPopup(spot, cx, cy, -1);
    });
    $("map-ride").onclick = () => {
      if (!this.path) return;
      const name = $<HTMLInputElement>("map-route-name").value.trim() || this.autoName();
      this.cb.plannedRide(this.path, name, this.waypoints[0]);
    };
    $("map-reverse").onclick = () => {
      this.waypoints.reverse();
      this.commit();
    };
    $("map-clear").onclick = () => this.clear();
    $("map-save").onclick = () => this.save();
    $("map-fit").onclick = () => this.fitRoute();
    $<HTMLInputElement>("map-route-name").oninput = () => (this.nameEdited = true);
    window.addEventListener("resize", () => this.scheduleDraw());
  }
}
