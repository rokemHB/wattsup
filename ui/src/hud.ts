// The ride overlay: live numbers and the elevation profile with the rider's position.
import { duration, num } from "./format";
import { clockAfter, maneuverIcon, shortDistance, shortDuration } from "./nav";
import type { EngineSnapshot, Workout } from "./types";
import type { RouteSampler } from "./world/route";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

export class Hud {
  private profile: number[];
  private canvas = $("profile") as HTMLCanvasElement;
  private lastKey = "";
  private frames = 0;
  private fpsAt = performance.now();

  /** Open-ended rides (a road network) show the next few kilometres instead of the whole route. */
  private windowed = false;

  constructor(private sampler: RouteSampler, windowed = false) {
    this.windowed = windowed;
    $("hud-route-name").textContent = sampler.route.name;
    this.profile = sampler.profile(400);
    window.addEventListener("resize", () => (this.lastKey = ""));
  }

  setSampler(sampler: RouteSampler) {
    this.sampler = sampler;
    $("hud-route-name").textContent = sampler.route.name;
    this.profile = sampler.profile(400);
    this.lastKey = "";
  }

  /** Windowed: the profile shows the road ahead instead of the whole route (free rides). */
  setWindowed(on: boolean) {
    this.windowed = on;
    if (!on) this.profile = this.sampler.profile(400);
    this.lastKey = "";
  }

  private noticeUntil = 0;

  /** A line under the route name for a few seconds ("Off the planned route"). */
  notice(text: string, seconds = 8) {
    $("hud-notice").textContent = text;
    this.noticeUntil = performance.now() + seconds * 1000;
  }

  private navKey = "";

  /** The navigation panel of a planned ride: next turn, what is left, when we get there. */
  private updateNavigation(snap: EngineSnapshot) {
    const nav = snap.navigation;
    const s = snap.session;
    $("hud-uturn").hidden = !nav;
    $("hud-notice").hidden = performance.now() > this.noticeUntil;
    const box = $("hud-nav");
    if (!nav?.planned) {
      box.hidden = true;
      this.navKey = "";
      return;
    }
    box.hidden = false;
    const next = nav.next;
    const kind = next ? next.turn : "arrive";
    const road = next ? [next.ref, ...next.to].filter(Boolean).join(" · ") || "side road" : `Destination · ${this.sampler.route.name}`;
    const key = `${kind}:${road}`;
    if (key !== this.navKey) {
      this.navKey = key;
      $("hud-nav-icon").innerHTML = maneuverIcon(kind);
      $("hud-nav-road").textContent = road;
    }
    const remaining = nav.remaining_m ?? 0;
    $("hud-nav-dist").textContent = `in ${shortDistance(next ? next.at_m - s.distance_m : remaining)}`;
    $("hud-nav-remaining").textContent = shortDistance(remaining);
    $("hud-nav-climb").textContent = `${Math.round(nav.remaining_climb_m ?? 0)} m`;
    const left = nav.eta_s;
    $("hud-nav-eta").textContent = left === null ? "–" : shortDuration(left);
    $("hud-nav-arrival").textContent = left === null ? "–" : clockAfter(left);
    const length = this.sampler.length || 1;
    $("hud-nav-bar").style.width = `${Math.min(100, Math.max(0, (100 * (length - remaining)) / length))}%`;
  }

  private workout: Workout | null = null;
  private workoutKey = "";

  /** The workout being ridden, for the interval bar. */
  setWorkout(w: Workout | null) {
    this.workout = w;
    this.workoutKey = "";
  }

  update(snap: EngineSnapshot) {
    const s = snap.session;
    this.updateWorkout(snap);
    this.updateNavigation(snap);
    $("hud-offline").hidden = !s.trainer_offline;
    $("hud-power").textContent = num(s.power_w);
    $("hud-cadence").textContent = num(s.cadence_rpm);
    $("hud-hr").textContent = num(s.heart_rate_bpm);
    $("hud-speed").textContent = num(s.virtual_speed_kmh, 1);
    $("hud-gear").textContent = String(s.gear);
    $("hud-gear-ratio").textContent = `of ${s.gear_count}`;
    $("hud-lap").textContent = String(s.lap + 1);
    ($("hud-lap").parentElement as HTMLElement).classList.toggle("windowed", this.windowed);
    $("hud-dist").textContent = this.windowed ? `${(s.distance_m / 1000).toFixed(2)} km ridden` : `${(s.route_position_m / 1000).toFixed(2)} / ${(this.sampler.length / 1000).toFixed(1)} km`;
    const g = s.road_grade_pct;
    const grade = $("hud-grade");
    grade.textContent = `${g >= 0 ? "+" : ""}${g.toFixed(1)} %`;
    grade.className = g > 3 ? "climb" : g < -3 ? "descent" : "";
    if (this.windowed) {
      // The profile of the road from 300 m behind to 4.7 km ahead.
      const from = Math.max(0, s.distance_m - 300);
      const span = 5000;
      const n = 200;
      let lo = Infinity;
      let hi = -Infinity;
      const ys = Array.from({ length: n }, (_, k) => this.sampler.pose(Math.min(this.sampler.length, from + (k / (n - 1)) * span)).y);
      for (const y of ys) {
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
      const range = Math.max(hi - lo, 60);
      this.profile = ys.map((y) => (y - lo) / range);
      this.lastKey = "";
      this.drawProfile((s.distance_m - from) / span);
      return;
    }
    this.drawProfile(s.route_position_m / this.sampler.length);
  }

  private updateWorkout(snap: EngineSnapshot) {
    const w = snap.session.workout;
    const box = $("hud-workout");
    box.hidden = !w;
    if (!w) return;
    const left = Math.max(0, w.step_seconds - w.step_elapsed_s);
    $("hud-workout-watts").textContent = `${Math.round(w.step_watts)} W`;
    $("hud-workout-step").textContent = `interval ${w.step + 1} / ${w.steps}`;
    $("hud-workout-left").textContent = `${duration(left)} left · ${duration(Math.max(0, w.total_seconds - w.elapsed_s))} total`;
    $("hud-workout-next").textContent = w.next_watts === null ? "last interval" : `next ${Math.round(w.next_watts)} W`;
    $("hud-workout-paused").hidden = !w.paused;
    const bar = $("hud-workout-bar") as HTMLCanvasElement;
    const key = `${bar.clientWidth}:${w.elapsed_s.toFixed(0)}`;
    if (key === this.workoutKey || !this.workout) return;
    this.workoutKey = key;
    drawWorkout(bar, this.workout, w.elapsed_s);
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

/** The intervals as bars: width is time, height is watts, the ridden part lit. */
export function drawWorkout(canvas: HTMLCanvasElement, w: Workout, elapsed: number) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width) return;
  const dpr = Math.min(window.devicePixelRatio, 2);
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const total = w.steps.reduce((s, x) => s + x.seconds, 0) || 1;
  const maxW = Math.max(...w.steps.map((s) => s.watts), 1);
  let t = 0;
  for (const step of w.steps) {
    const x0 = (t / total) * width;
    const x1 = ((t + step.seconds) / total) * width;
    const h = Math.max(3, (step.watts / maxW) * (height - 4));
    const done = Math.min(Math.max((elapsed - t) / step.seconds, 0), 1);
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.fillRect(x0 + 1, height - h, Math.max(1, x1 - x0 - 2), h);
    if (done > 0) {
      ctx.fillStyle = "#ffc400";
      ctx.fillRect(x0 + 1, height - h, Math.max(1, (x1 - x0 - 2) * done), h);
    }
    t += step.seconds;
  }
  const x = (Math.min(elapsed, total) / total) * width;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x - 1, 0, 2, height);
}
