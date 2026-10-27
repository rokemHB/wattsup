// A top-down map of the route in the corner of the ride screen: the aerial
// photo as background where there is one, the road, and the rider.
import type { EngineSnapshot, Route } from "./types";
import type { NetworkIndex } from "./world/network";
import { Frame } from "./world/streaming";
import type { NetworkWorldData, WorldData } from "./world/terrain";
import { RouteSampler } from "./world/route";

/** A map window following the rider over a road network. */
export interface NetworkView {
  data: NetworkWorldData;
  index: NetworkIndex;
}

/** Half the width of the window the minimap shows around the rider, in metres. */
const WINDOW_M = 1600;

export class Minimap {
  private canvas: HTMLCanvasElement;
  private background: HTMLCanvasElement | null = null;
  private sampler: RouteSampler;
  private box: { x0: number; z0: number; w: number; h: number };
  private size = 0;
  private lastDistance = -1;
  private network: NetworkView | null = null;
  private frame: Frame = new Frame(0, 0);

  constructor(canvas: HTMLCanvasElement, route: Route, world?: WorldData, network?: NetworkView) {
    this.canvas = canvas;
    this.sampler = new RouteSampler(route);
    if (network) {
      this.network = network;
      this.frame = new Frame(network.data.origin.lat, network.data.origin.lon);
    }
    const pts = route.points;
    const xs = pts.map((p) => p.x);
    const zs = pts.map((p) => p.z);
    const margin = 120;
    const x0 = Math.min(...xs) - margin;
    const z0 = Math.min(...zs) - margin;
    const w = Math.max(...xs) + margin - x0;
    const h = Math.max(...zs) + margin - z0;
    // Square box around the route so the map does not stretch.
    const side = Math.max(w, h);
    this.box = { x0: x0 - (side - w) / 2, z0: z0 - (side - h) / 2, w: side, h: side };
    if (world?.near.ortho) this.background = this.renderBackground(world);
  }

  /** The photo blocks drawn into an offscreen canvas in map space, once. */
  private renderBackground(world: WorldData): HTMLCanvasElement {
    const { near } = world;
    const o = near.ortho!;
    const c = document.createElement("canvas");
    const px = 512;
    c.width = c.height = px;
    const ctx = c.getContext("2d")!;
    const toMap = (x: number, z: number) => [((x - this.box.x0) / this.box.w) * px, ((z - this.box.z0) / this.box.h) * px] as const;
    for (let br = 0; br < o.rowEdges.length - 1; br++) {
      for (let bc = 0; bc < o.colEdges.length - 1; bc++) {
        const [x0, z0] = toMap(near.x0 + o.colEdges[bc] * near.spacing, near.z0 + o.rowEdges[br] * near.spacing);
        const [x1, z1] = toMap(near.x0 + o.colEdges[bc + 1] * near.spacing, near.z0 + o.rowEdges[br + 1] * near.spacing);
        ctx.drawImage(o.images[br][bc], x0, z0, x1 - x0, z1 - z0);
      }
    }
    // Darken a little so the road and the rider stand out.
    ctx.fillStyle = "rgba(10, 14, 24, 0.35)";
    ctx.fillRect(0, 0, px, px);
    return c;
  }

  setRoute(route: Route) {
    this.sampler = new RouteSampler(route);
    this.lastDistance = -1;
  }

  update(snap: EngineSnapshot) {
    if (this.network) {
      this.updateWindow(snap);
      return;
    }
    const d = snap.session.route_position_m;
    const size = this.canvas.clientWidth;
    if (size === 0) return;
    if (Math.abs(d - this.lastDistance) < 3 && size === this.size) return;
    this.lastDistance = d;
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (this.size !== size) {
      this.size = size;
      this.canvas.width = this.canvas.height = size * dpr;
    }
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const toMap = (x: number, z: number) => [((x - this.box.x0) / this.box.w) * size, ((z - this.box.z0) / this.box.h) * size] as const;

    // Rounded clip.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, 14);
    ctx.clip();
    if (this.background) ctx.drawImage(this.background, 0, 0, size, size);
    else {
      ctx.fillStyle = "rgba(15, 18, 27, 0.8)";
      ctx.fillRect(0, 0, size, size);
    }

    // The road, with the part already ridden in the accent colour.
    const pts = this.sampler.route.points;
    const draw = (from: number, to: number, style: string, width: number) => {
      ctx.beginPath();
      for (let i = from; i <= to; i++) {
        const [x, y] = toMap(pts[i].x, pts[i].z);
        if (i === from) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    };
    const at = Math.min(pts.length - 1, Math.round(d / this.sampler.spacing));
    draw(0, pts.length - 1, "rgba(255,255,255,0.85)", 2.5);
    if (at > 0) draw(0, at, "#ffc400", 3);

    // Rider.
    const pose = this.sampler.pose(d);
    const [rx, ry] = toMap(pose.x, pose.z);
    ctx.beginPath();
    ctx.arc(rx, ry, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#0f121b";
    ctx.lineWidth = 2;
    ctx.stroke();
    // North arrow.
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.font = "bold 11px sans-serif";
    ctx.fillText("N", size - 16, 16);
    ctx.restore();
  }

  /** The map window around the rider on a road network: island image, roads, the planned road, the rider. */
  private updateWindow(snap: EngineSnapshot) {
    const d = snap.session.route_position_m;
    const size = this.canvas.clientWidth;
    if (size === 0) return;
    if (Math.abs(d - this.lastDistance) < 3 && size === this.size) return;
    this.lastDistance = d;
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (this.size !== size) {
      this.size = size;
      this.canvas.width = this.canvas.height = size * dpr;
    }
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const pose = this.sampler.pose(d);
    const x0 = pose.x - WINDOW_M;
    const z0 = pose.z - WINDOW_M;
    const toMap = (x: number, z: number) => [((x - x0) / (2 * WINDOW_M)) * size, ((z - z0) / (2 * WINDOW_M)) * size] as const;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, 14);
    ctx.clip();
    const { data, index } = this.network!;
    if (data.map) {
      const m = data.map;
      const [latA, lonA] = this.frame.toLatLon(x0, z0);
      const [latB, lonB] = this.frame.toLatLon(x0 + 2 * WINDOW_M, z0 + 2 * WINDOW_M);
      const px = (lon: number) => ((lon - m.lon_min) / (m.lon_max - m.lon_min)) * m.image.width;
      const py = (lat: number) => ((m.lat_max - lat) / (m.lat_max - m.lat_min)) * m.image.height;
      ctx.drawImage(m.image, px(lonA), py(latA), px(lonB) - px(lonA), py(latB) - py(latA), 0, 0, size, size);
      ctx.fillStyle = "rgba(10, 14, 24, 0.3)";
      ctx.fillRect(0, 0, size, size);
    } else {
      ctx.fillStyle = "rgba(15, 18, 27, 0.8)";
      ctx.fillRect(0, 0, size, size);
    }
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const ei of index.edgesIn(x0, z0, x0 + 2 * WINDOW_M, z0 + 2 * WINDOW_M, 100)) {
      const e = index.edge(ei);
      const xyz = index.net.xyz;
      ctx.beginPath();
      for (let i = e.start; i < e.start + e.count; i++) {
        const [mx, my] = toMap(xyz[i * 3], xyz[i * 3 + 2]);
        if (i === e.start) ctx.moveTo(mx, my);
        else ctx.lineTo(mx, my);
      }
      ctx.strokeStyle = e.kind <= 1 ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.55)";
      ctx.lineWidth = e.kind <= 1 ? 2.5 : 1.5;
      ctx.stroke();
    }
    const pts = this.sampler.route.points;
    const from = Math.max(0, Math.round(d / this.sampler.spacing));
    const to = Math.min(pts.length - 1, from + Math.round((WINDOW_M * 1.5) / this.sampler.spacing));
    ctx.beginPath();
    for (let i = from; i <= to; i++) {
      const [mx, my] = toMap(pts[i].x, pts[i].z);
      if (i === from) ctx.moveTo(mx, my);
      else ctx.lineTo(mx, my);
    }
    ctx.strokeStyle = "#ffc400";
    ctx.lineWidth = 3;
    ctx.stroke();
    const [rx, ry] = toMap(pose.x, pose.z);
    ctx.save();
    ctx.translate(rx, ry);
    ctx.rotate(Math.atan2(pose.dz, pose.dx) + Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(6, 6);
    ctx.lineTo(-6, 6);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#0f121b";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.font = "bold 11px sans-serif";
    ctx.fillText("N", size - 16, 16);
    ctx.restore();
  }
}
