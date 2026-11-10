// The ride overlay: live numbers and the elevation profile with the rider's position: the next
// two kilometres large, graded in colour, and the whole ride small underneath.
import { duration, num } from "./format";
import { clockAfter, maneuverIcon, shortDistance, shortDuration } from "./nav";
import type { EngineSnapshot, Workout } from "./types";
import type { RouteSampler } from "./world/route";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

/** What the detailed profile shows around the rider: a little behind, two kilometres ahead. */
const DETAIL_BEHIND_M = 150;
const DETAIL_AHEAD_M = 2000;
/** A flight covers ground five times as fast. */
const FLIGHT_BEHIND_M = 500;
const FLIGHT_AHEAD_M = 10000;

/** Colour of a stretch by its grade: blue down, grey-green flat, then yellow to red as it steepens. */
export function gradeColor(grade: number): string {
  if (grade < -2) return "#40c8ff";
  if (grade < 2) return "#7fcf9a";
  if (grade < 4) return "#ffd84d";
  if (grade < 6) return "#ffb020";
  if (grade < 8) return "#ff8a3d";
  if (grade < 10) return "#ff5c5c";
  return "#d6336c";
}

/** What is left to the end of the ride, when it has one. */
export interface Goal {
  left_m: number;
  climb_m: number | null;
}

export class Hud {
  private canvas = $("profile") as HTMLCanvasElement;
  private overview = $("profile-overview") as HTMLCanvasElement;
  /** The whole route's heights for the overview strip, 0..1 of its range. */
  private profile: number[];
  private lastKey = "";
  private overviewKey = "";
  private frames = 0;
  private fpsAt = performance.now();

  /** Open-ended rides (a road network) show the next few kilometres instead of the whole route. */
  private windowed = false;

  /** Flying the plane: distance flown and altitude, not laps and grade. */
  private flight: boolean;

  constructor(private sampler: RouteSampler, windowed = false) {
    this.windowed = windowed;
    this.flight = !!sampler.route.flight;
    $("hud-route-name").textContent = sampler.route.name;
    $("profile-title").textContent = this.flight ? "Next 10 km" : "Next 2 km";
    this.profile = sampler.profile(300);
    window.addEventListener("resize", () => {
      this.lastKey = "";
      this.overviewKey = "";
    });
  }

  setSampler(sampler: RouteSampler) {
    this.sampler = sampler;
    $("hud-route-name").textContent = sampler.route.name;
    this.profile = sampler.profile(300);
    this.lastKey = "";
    this.overviewKey = "";
  }

  /** Windowed: a free ride with no end (no distance or climbing to go, no lap counter). */
  setWindowed(on: boolean) {
    this.windowed = on;
    this.lastKey = "";
  }

  /** Distance and climbing to the end: a planned ride's destination, or the end of an open route. */
  private goal(snap: EngineSnapshot): Goal | null {
    const s = snap.session;
    const nav = snap.navigation;
    if (nav?.planned && nav.remaining_m !== null) return { left_m: nav.remaining_m, climb_m: nav.remaining_climb_m };
    if (this.windowed || this.sampler.route.closed) return null;
    return {
      left_m: Math.max(0, this.sampler.length - s.route_position_m),
      climb_m: this.flight ? null : this.sampler.climbAhead(s.route_position_m),
    };
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
    // Any ride can turn round: a network ride takes the road back, a single route leads back to its start.
    $("hud-uturn").hidden = false;
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
    // Moving time: starts with the ride, stops by itself while the bike stands (the engine's
    // `moving_s` counts only above 0.5 m/s), like a bike computer's auto-pause.
    $("hud-time").textContent = duration(s.stats.moving_s);
    const paused = s.virtual_speed_kmh < 1.8;
    $("hud-time-state").textContent = paused ? "paused" : "moving";
    $("hud-time").closest(".tile")!.classList.toggle("paused", paused);
    $("hud-gear").textContent = String(s.gear);
    $("hud-gear-ratio").textContent = `of ${s.gear_count}`;
    $("hud-lap").textContent = String(s.lap + 1);
    // The lap counter hides on a free ride and a flight (the CSS keys on the strip, not the counter's own span).
    ($("hud-lap").closest(".hud-route") as HTMLElement).classList.toggle("windowed", this.windowed || this.flight || !this.sampler.route.closed);

    // Distance ridden, and what is left when the ride has an end.
    const goal = this.goal(snap);
    const km = s.stats.distance_m / 1000;
    $("hud-distance").textContent = km.toFixed(km < 100 ? 2 : 1);
    $("hud-distance-sub").textContent = goal ? `km · ${shortDistance(goal.left_m)} to go` : this.flight ? "km flown" : "km ridden";
    // Climbing: since the start, the height above the sea here, and what is left to climb.
    const altitude = this.sampler.pose(s.distance_m).y;
    $("hud-ascent").textContent = `${Math.round(s.stats.ascent_m)}`;
    $("hud-altitude").textContent = `m · ${Math.round(altitude)} m above sea`;
    const left = $("hud-climb-left");
    left.hidden = goal?.climb_m == null;
    if (goal?.climb_m != null) left.textContent = `${Math.round(goal.climb_m)} m left to climb`;

    const grade = $("hud-grade");
    if (this.flight) {
      grade.textContent = `${Math.round(altitude)} m up`;
      grade.className = "";
    } else {
      const g = s.road_grade_pct;
      grade.textContent = `${g >= 0 ? "+" : ""}${g.toFixed(1)} %`;
      grade.className = g > 3 ? "climb" : g < -3 ? "descent" : "";
    }
    this.drawDetail(s.distance_m, goal);
    this.drawOverview(this.sampler.route.closed ? s.route_position_m : s.distance_m);
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

  /** Sets a canvas's backing size to its CSS size (at most 2x) and returns its 2D context, or null when hidden. */
  private static context(c: HTMLCanvasElement): [CanvasRenderingContext2D, number, number] | null {
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return null;
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return [ctx, w, h];
  }

  /**
   * The road from a little behind the rider to two kilometres ahead, at a height scale fine
   * enough to read a ramp: each stretch coloured by its grade, the grade written over each
   * steeper quarter kilometre, a tick every 500 m, the finish if it is in sight.
   */
  private drawDetail(d: number, goal: Goal | null) {
    const behind = this.flight ? FLIGHT_BEHIND_M : DETAIL_BEHIND_M;
    const span = behind + (this.flight ? FLIGHT_AHEAD_M : DETAIL_AHEAD_M);
    const key = `${this.canvas.clientWidth}x${this.canvas.clientHeight}:${Math.round(d)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const got = Hud.context(this.canvas);
    if (!got) return;
    const [ctx, w, h] = got;
    const closed = this.sampler.route.closed;
    const length = this.sampler.length;
    const from = closed ? d - behind : Math.max(0, d - behind);
    // The last distance with road: an open route ends.
    const last = closed ? from + span : Math.min(from + span, length);
    const n = 221;
    const step = span / (n - 1);
    const ds: number[] = [];
    for (let k = 0; k < n && from + k * step <= last + 1e-6; k++) ds.push(from + k * step);
    if (ds.length < 2) return;
    const ys = ds.map((x) => this.sampler.pose(x).y);
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    // At least 20 m of height on the scale: a flat road stays flat, a 3 % ramp shows.
    const pad = Math.max(0, 20 - (hi - lo)) / 2;
    lo -= pad;
    hi += pad;
    const top = 16;
    const bottom = h - 15;
    const X = (x: number) => ((x - from) / span) * w;
    const Y = (y: number) => top + (1 - (y - lo) / (hi - lo)) * (bottom - top);
    // Colour by the grade of whole 50 m blocks (100 m on a flight): solid bands, not stripes.
    const block = this.flight ? 250 : 50;
    const gradeAt = (x: number) => {
      const a = Math.floor(x / block) * block;
      return ((this.sampler.pose(a + block).y - this.sampler.pose(a).y) / block) * 100;
    };

    // Coloured columns under the line, the stretch behind the rider dimmed.
    for (let k = 0; k + 1 < ds.length; k++) {
      const mid = (ds[k] + ds[k + 1]) / 2;
      ctx.globalAlpha = mid < d ? 0.3 : 0.8;
      ctx.fillStyle = gradeColor(gradeAt(mid));
      ctx.beginPath();
      ctx.moveTo(X(ds[k]), Y(ys[k]));
      ctx.lineTo(X(ds[k + 1]) + 0.5, Y(ys[k + 1]));
      ctx.lineTo(X(ds[k + 1]) + 0.5, bottom);
      ctx.lineTo(X(ds[k]), bottom);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ds.forEach((x, k) => (k ? ctx.lineTo(X(x), Y(ys[k])) : ctx.moveTo(X(x), Y(ys[k]))));
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = "600 11px Inter, system-ui, sans-serif";
    ctx.textBaseline = "alphabetic";
    // Ticks every 500 m ahead of the rider (2 km on a flight), labelled underneath.
    const tick = this.flight ? 2000 : 500;
    ctx.fillStyle = "rgba(232,236,245,0.7)";
    ctx.textAlign = "center";
    for (let m = tick; d + m <= from + span; m += tick) {
      const x = X(d + m);
      ctx.fillRect(Math.round(x), bottom, 1, 4);
      const label = m < 1000 ? `${m} m` : `${m / 1000} km`;
      if (d + m <= last) ctx.fillText(label, Math.min(w - 18, x), h - 2);
    }
    // The grade over each 250 m ahead (500 m on a flight) where it matters.
    const bin = this.flight ? 1000 : 250;
    let steepest = -Infinity;
    for (let a = d; a + bin <= last + 1; a += bin) {
      const g = ((this.sampler.pose(a + bin).y - this.sampler.pose(a).y) / bin) * 100;
      steepest = Math.max(steepest, g);
      if (Math.abs(g) < 2) continue;
      const cx = X(a + bin / 2);
      const cy = Math.min(Y(this.sampler.pose(a + bin / 2).y), Y(this.sampler.pose(a + bin * 0.25).y), Y(this.sampler.pose(a + bin * 0.75).y)) - 5;
      const text = `${g > 0 ? "" : "−"}${Math.abs(g).toFixed(Math.abs(g) < 10 ? 1 : 0)}%`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(15,18,27,0.85)";
      ctx.strokeText(text, cx, Math.max(12, cy));
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, cx, Math.max(12, cy));
    }
    $("profile-range").textContent = Number.isFinite(steepest) && steepest >= 1 ? `steepest ${steepest.toFixed(1)} % · ${Math.round(hi - pad)} m top` : `${Math.round(hi - pad)} m top`;
    // The finish, when it is in sight.
    if (goal && !closed && length <= from + span) {
      const x = X(length);
      for (let k = 0; k < 6; k++) {
        ctx.fillStyle = k % 2 ? "#0f121b" : "#ffffff";
        ctx.fillRect(x - 1, top + k * 6, 3, 6);
      }
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = x > w - 40 ? "right" : "left";
      ctx.fillText("finish", x + (x > w - 40 ? -5 : 5), top + 10);
    }
    // Height scale at the left edge.
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(232,236,245,0.75)";
    ctx.fillText(`${Math.round(hi - pad)} m`, 4, top - 4);
    // The rider.
    const rx = X(d);
    const ry = Y(this.sampler.pose(d).y);
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(Math.round(rx), ry, 1, bottom - ry);
    ctx.beginPath();
    ctx.arc(rx, ry, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#0f121b";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  /** The whole ride, small: ridden part lit, the detailed stretch boxed, the rider a dot. */
  private drawOverview(position: number) {
    const length = this.sampler.length || 1;
    const fraction = Math.min(1, Math.max(0, position / length));
    const key = `${this.overview.clientWidth}x${this.overview.clientHeight}:${fraction.toFixed(4)}`;
    if (key === this.overviewKey) return;
    this.overviewKey = key;
    const got = Hud.context(this.overview);
    if (!got) return;
    const [ctx, w, h] = got;
    const n = this.profile.length;
    const Y = (v: number) => h - 2 - v * (h - 5);
    const area = new Path2D();
    area.moveTo(0, h);
    this.profile.forEach((v, i) => area.lineTo((i / (n - 1)) * w, Y(v)));
    area.lineTo(w, h);
    area.closePath();
    const rx = fraction * w;
    ctx.fillStyle = "rgba(232,236,245,0.3)";
    ctx.fill(area);
    // Ridden: lit up to the rider.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, rx, h);
    ctx.clip();
    ctx.fillStyle = "rgba(255,196,0,0.55)";
    ctx.fill(area);
    ctx.restore();
    // The stretch the large profile shows.
    const behind = this.flight ? FLIGHT_BEHIND_M : DETAIL_BEHIND_M;
    const ahead = this.flight ? FLIGHT_AHEAD_M : DETAIL_AHEAD_M;
    const x0 = Math.max(0, ((position - behind) / length) * w);
    const x1 = Math.min(w, ((position + ahead) / length) * w);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, 0.5, Math.max(2, x1 - x0 - 1), h - 1);
    const i = Math.min(n - 1, Math.round(fraction * (n - 1)));
    ctx.beginPath();
    ctx.arc(rx, Y(this.profile[i]), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
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
