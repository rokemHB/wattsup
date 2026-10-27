// The ride overlay: live numbers and the elevation profile with the rider's position.
import { num } from "./format";
import type { EngineSnapshot } from "./types";
import type { RouteSampler } from "./world/route";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

export class Hud {
  private profile: number[];
  private canvas = $("profile") as HTMLCanvasElement;
  private lastKey = "";
  private frames = 0;
  private fpsAt = performance.now();

  constructor(private sampler: RouteSampler) {
    $("hud-route-name").textContent = sampler.route.name;
    this.profile = sampler.profile(400);
    window.addEventListener("resize", () => (this.lastKey = ""));
  }

  update(snap: EngineSnapshot) {
    const s = snap.session;
    $("hud-power").textContent = num(s.power_w);
    $("hud-cadence").textContent = num(s.cadence_rpm);
    $("hud-hr").textContent = num(s.heart_rate_bpm);
    $("hud-speed").textContent = num(s.virtual_speed_kmh, 1);
    $("hud-gear").textContent = String(s.gear);
    $("hud-gear-ratio").textContent = `of ${s.gear_count}`;
    $("hud-lap").textContent = String(s.lap + 1);
    $("hud-dist").textContent = `${(s.route_position_m / 1000).toFixed(2)} / ${(this.sampler.length / 1000).toFixed(1)} km`;
    const g = s.road_grade_pct;
    const grade = $("hud-grade");
    grade.textContent = `${g >= 0 ? "+" : ""}${g.toFixed(1)} %`;
    grade.className = g > 3 ? "climb" : g < -3 ? "descent" : "";
    this.drawProfile(s.route_position_m / this.sampler.length);
  }

  /** Called once per rendered frame; shows the rate once a second. */
  frame() {
    this.frames++;
    const now = performance.now();
    if (now - this.fpsAt >= 1000) {
      $("fps").textContent = `${Math.round((this.frames * 1000) / (now - this.fpsAt))} fps`;
      this.frames = 0;
      this.fpsAt = now;
    }
  }

  private drawProfile(fraction: number) {
    const c = this.canvas;
    const w = c.clientWidth;
    const h = c.clientHeight;
    const key = `${w}x${h}:${fraction.toFixed(4)}`;
    if (key === this.lastKey || w === 0) return;
    this.lastKey = key;
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const n = this.profile.length;
    const y = (v: number) => h - 6 - v * (h - 14);
    ctx.beginPath();
    ctx.moveTo(0, h);
    this.profile.forEach((v, i) => ctx.lineTo((i / (n - 1)) * w, y(v)));
    ctx.lineTo(w, h);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, 0, 0, h);
    fill.addColorStop(0, "rgba(255,196,0,0.55)");
    fill.addColorStop(1, "rgba(255,196,0,0.08)");
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.beginPath();
    this.profile.forEach((v, i) => (i ? ctx.lineTo((i / (n - 1)) * w, y(v)) : ctx.moveTo(0, y(v))));
    ctx.strokeStyle = "#ffc400";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Rider marker.
    const x = fraction * w;
    const i = Math.min(n - 1, Math.round(fraction * (n - 1)));
    ctx.beginPath();
    ctx.arc(x, y(this.profile[i]), 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#0f121b";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
