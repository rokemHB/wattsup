// The rides screen: what was ridden, week by week, and each ride's graph. Rides are
// stored by the app (see `api.saveRide`), one file each, under the app's data folder.
import { api } from "./api";
import { $, el } from "./dom";
import { duration, num } from "./format";
import type { RideRecord, RideSample, RideSummary } from "./types";

const WEEKS = 12;

/** Midnight at the Monday of the week `date` is in. */
export function weekStart(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

export interface Totals {
  rides: number;
  distance_m: number;
  moving_s: number;
  ascent_m: number;
  energy_kj: number;
}

export function totals(rides: RideSummary[]): Totals {
  const t: Totals = { rides: 0, distance_m: 0, moving_s: 0, ascent_m: 0, energy_kj: 0 };
  for (const r of rides) {
    t.rides++;
    t.distance_m += r.stats.distance_m;
    t.moving_s += r.stats.moving_s;
    t.ascent_m += r.stats.ascent_m;
    t.energy_kj += r.stats.energy_kj;
  }
  return t;
}

/** Kilometres per week for the last `weeks` weeks, oldest first, the current week last. */
export function weeklyDistance(rides: RideSummary[], weeks: number, now = new Date()): { start: Date; km: number }[] {
  const first = weekStart(now);
  first.setDate(first.getDate() - 7 * (weeks - 1));
  const out = Array.from({ length: weeks }, (_, k) => {
    const start = new Date(first);
    start.setDate(first.getDate() + 7 * k);
    return { start, km: 0 };
  });
  for (const r of rides) {
    const k = Math.floor((weekStart(new Date(r.started_at_ms)).getTime() - first.getTime()) / (7 * 86400e3));
    if (k >= 0 && k < weeks) out[k].km += r.stats.distance_m / 1000;
  }
  return out;
}

const dateLabel = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) +
  ", " +
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
const hours = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`);

export class RidesScreen {
  private rides: RideSummary[] = [];
  private selected: string | null = null;
  private record: RideRecord | null = null;
  private confirmDelete = false;

  /** Reloads the list from disk and shows it. */
  async open() {
    this.rides = await api.rides();
    this.renderList();
    const first = this.rides.find((r) => r.id === this.selected) ?? this.rides[0];
    if (first) await this.select(first.id);
    else this.renderDetail();
  }

  private renderList() {
    const now = new Date();
    const week = weekStart(now).getTime();
    const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const block = (title: string, t: Totals) =>
      el(
        "div",
        { className: "totals-block" },
        el("h3", {}, title),
        el("div", { className: "totals-grid" }, ...[
          [`${t.rides}`, t.rides === 1 ? "ride" : "rides"],
          [km(t.distance_m), "distance"],
          [hours(t.moving_s), "moving"],
          [`${Math.round(t.ascent_m)} m`, "climbing"],
        ].flatMap(([v, l]) => [el("b", {}, v), el("span", {}, l)])),
      );
    $("rides-totals").replaceChildren(
      block("This week", totals(this.rides.filter((r) => r.started_at_ms >= week))),
      block("This month", totals(this.rides.filter((r) => r.started_at_ms >= month))),
      block("All time", totals(this.rides)),
    );
    this.drawWeeks();
    const list = $("rides-list");
    if (!this.rides.length) {
      list.replaceChildren(el("p", { className: "hint" }, "No rides yet. Rides are kept here once they are over: 500 m and a minute of riding at least."));
      return;
    }
    list.replaceChildren(
      ...this.rides.map((r) => {
        const s = r.stats;
        const card = el(
          "div",
          { className: `ride-card${r.id === this.selected ? " selected" : ""}` },
          el("span", { className: "when" }, dateLabel(r.started_at_ms)),
          el("b", {}, r.workout ? `${r.workout} · ${r.route}` : r.route),
          el(
            "span",
            { className: "metrics" },
            ...[km(s.distance_m), duration(r.elapsed_s), s.avg_power_w === null ? "" : `${num(s.avg_power_w)} W`, s.avg_heart_rate_bpm === null ? "" : `${num(s.avg_heart_rate_bpm)} bpm`, `↑ ${Math.round(s.ascent_m)} m`]
              .filter(Boolean)
              .map((t) => el("span", {}, t)),
          ),
        );
        card.onclick = () => this.select(r.id).catch(console.error);
        return card;
      }),
    );
  }

  private async select(id: string) {
    this.selected = id;
    this.confirmDelete = false;
    Array.from($("rides-list").children).forEach((c, k) => c.classList.toggle("selected", this.rides[k]?.id === id));
    this.record = await api.ride(id);
    this.renderDetail();
  }

  private renderDetail() {
    const box = $("rides-detail");
    const rec = this.record;
    if (!rec || rec.summary.id !== this.selected) {
      box.replaceChildren(el("p", { className: "hint" }, this.rides.length ? "Pick a ride to see its graph." : "Your rides will show up here."));
      return;
    }
    const r = rec.summary;
    const s = r.stats;
    const item = (label: string, value: string) => el("div", {}, el("span", {}, label), el("b", {}, value));
    const w = (v: number | null) => (v === null ? "–" : `${num(v)} W`);
    const del = el("button", { className: this.confirmDelete ? "danger" : "", textContent: this.confirmDelete ? "Really delete" : "Delete" });
    del.onclick = async () => {
      if (!this.confirmDelete) {
        this.confirmDelete = true;
        del.textContent = "Really delete";
        del.className = "danger";
        return;
      }
      await api.deleteRide(r.id);
      this.selected = null;
      this.record = null;
      await this.open();
    };
    const exportLine = el("span", { className: "hint export-line" });
    const exp = el("button", { textContent: "Export TCX" });
    exp.onclick = async () => {
      exp.disabled = true;
      exportLine.textContent = "writing…";
      try {
        const path = await api.exportRide(r.id);
        exportLine.textContent = `Saved ${path} · upload it to Strava as a virtual ride`;
      } catch (e) {
        exportLine.textContent = `export failed: ${e}`;
      } finally {
        exp.disabled = false;
      }
    };
    box.replaceChildren(
      el(
        "header",
        {},
        el("div", {}, el("b", {}, r.workout ? `${r.workout} · ${r.route}` : r.route), el("span", { className: "when" }, `${dateLabel(r.started_at_ms)} · ${r.finished ? "finished" : "stopped early"} · ↑ ${Math.round(s.ascent_m)} m ↓ ${Math.round(s.descent_m)} m`)),
        el("span", { className: "row" }, exp, del),
      ),
      exportLine,
      el(
        "div",
        { className: "ride-stats" },
        item("Time", duration(r.elapsed_s)),
        item("Moving", duration(s.moving_s)),
        item("Distance", `${(s.distance_m / 1000).toFixed(2)} km`),
        item("Avg speed", `${s.avg_speed_kmh.toFixed(1)} km/h`),
        item("Avg power", w(s.avg_power_w)),
        item("Normalized", w(s.normalized_power_w)),
        item("Max power", `${num(s.max_power_w)} W`),
        item("Energy", `${Math.round(s.energy_kj)} kJ`),
        item("Avg heart rate", s.avg_heart_rate_bpm === null ? "–" : `${num(s.avg_heart_rate_bpm)} bpm`),
        item("Max heart rate", s.max_heart_rate_bpm > 0 ? `${num(s.max_heart_rate_bpm)} bpm` : "–"),
        item("Avg cadence", s.avg_cadence_rpm === null ? "–" : `${num(s.avg_cadence_rpm)} rpm`),
        item("Climbing", `${Math.round(s.ascent_m)} m`),
      ),
      el("canvas", { id: "ride-graph", className: "ride-graph" }),
      el("p", { className: "legend" }, el("i", { className: "power" }), "power (30 s)", el("i", { className: "hr" }), "heart rate", el("i", { className: "elev" }), "elevation"),
    );
    requestAnimationFrame(() => drawRide($<HTMLCanvasElement>("ride-graph"), rec.samples));
  }

  private drawWeeks() {
    const c = $<HTMLCanvasElement>("rides-weeks");
    const weeks = weeklyDistance(this.rides, WEEKS);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w) {
      requestAnimationFrame(() => this.drawWeeks());
      return;
    }
    const dpr = Math.min(window.devicePixelRatio, 2);
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const max = Math.max(10, ...weeks.map((x) => x.km));
    const top = 18;
    const bottom = h - 18;
    const slot = w / weeks.length;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    weeks.forEach((x, k) => {
      const bar = Math.max(0, ((bottom - top) * x.km) / max);
      const x0 = k * slot + slot * 0.2;
      const bw = slot * 0.6;
      ctx.fillStyle = k === weeks.length - 1 ? "#ffc400" : "rgba(64, 200, 255, 0.75)";
      ctx.beginPath();
      ctx.roundRect(x0, bottom - bar, bw, bar, [4, 4, 0, 0]);
      ctx.fill();
      ctx.fillStyle = "#8892a8";
      if (x.km > 0) ctx.fillText(`${Math.round(x.km)}`, x0 + bw / 2, bottom - bar - 4);
      if (slot >= 36 || k % 2 === weeks.length % 2) ctx.fillText(`${x.start.getDate()}.${x.start.getMonth() + 1}`, x0 + bw / 2, h - 4);
    });
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.beginPath();
    ctx.moveTo(0, bottom + 0.5);
    ctx.lineTo(w, bottom + 0.5);
    ctx.stroke();
  }
}

/** Power (30 s average), heart rate and elevation over the ride's time. */
export function drawRide(c: HTMLCanvasElement, samples: RideSample[]) {
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (!w || samples.length < 2) return;
  const dpr = Math.min(window.devicePixelRatio, 2);
  c.width = w * dpr;
  c.height = h * dpr;
  const ctx = c.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const left = 40;
  const right = w - 40;
  const top = 10;
  const bottom = h - 22;
  const total = samples[samples.length - 1].t_s || 1;
  const x = (t: number) => left + ((right - left) * t) / total;
  // Elevation behind everything.
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of samples) {
    lo = Math.min(lo, s.elevation_m);
    hi = Math.max(hi, s.elevation_m);
  }
  const range = Math.max(hi - lo, 50);
  ctx.beginPath();
  ctx.moveTo(x(0), bottom);
  for (const s of samples) ctx.lineTo(x(s.t_s), bottom - ((bottom - top) * 0.6 * (s.elevation_m - lo)) / range);
  ctx.lineTo(x(total), bottom);
  ctx.closePath();
  ctx.fillStyle = "rgba(136, 146, 168, 0.22)";
  ctx.fill();
  // Power, smoothed over 30 s.
  const power: number[] = [];
  let sum = 0;
  const win: number[] = [];
  for (const s of samples) {
    const p = s.power_w ?? 0;
    win.push(p);
    sum += p;
    if (win.length > 30) sum -= win.shift()!;
    power.push(sum / win.length);
  }
  const maxP = Math.max(100, ...power) * 1.1;
  const yP = (p: number) => bottom - ((bottom - top) * p) / maxP;
  ctx.beginPath();
  ctx.moveTo(x(0), bottom);
  samples.forEach((s, i) => ctx.lineTo(x(s.t_s), yP(power[i])));
  ctx.lineTo(x(total), bottom);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, top, 0, bottom);
  fill.addColorStop(0, "rgba(255,196,0,0.6)");
  fill.addColorStop(1, "rgba(255,196,0,0.08)");
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.beginPath();
  samples.forEach((s, i) => (i ? ctx.lineTo(x(s.t_s), yP(power[i])) : ctx.moveTo(x(s.t_s), yP(power[i]))));
  ctx.strokeStyle = "#ffc400";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Heart rate on its own scale.
  const hrs = samples.map((s) => s.heart_rate_bpm).filter((v): v is number => v !== null);
  if (hrs.length) {
    const maxH = Math.max(...hrs) + 10;
    const minH = Math.max(0, Math.min(...hrs) - 20);
    const yH = (v: number) => bottom - ((bottom - top) * (v - minH)) / (maxH - minH);
    ctx.beginPath();
    let pen = false;
    for (const s of samples) {
      if (s.heart_rate_bpm === null) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(x(s.t_s), yH(s.heart_rate_bpm));
      else ctx.moveTo(x(s.t_s), yH(s.heart_rate_bpm));
      pen = true;
    }
    ctx.strokeStyle = "#ff5a5a";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#ff5a5a";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`${Math.round(maxH - 10)}`, right + 4, yH(maxH - 10) + 4);
    ctx.fillText(`${Math.round(minH + 20)}`, right + 4, yH(minH + 20) + 4);
  }
  // Axes.
  ctx.fillStyle = "#8892a8";
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "right";
  for (const p of [Math.round(maxP / 2 / 50) * 50, Math.round(maxP / 1.1 / 50) * 50]) {
    if (p > 0 && p < maxP) ctx.fillText(`${p}`, left - 4, yP(p) + 4);
  }
  ctx.textAlign = "center";
  const step = total > 2 * 3600 ? 1800 : total > 3600 ? 900 : total > 1200 ? 600 : 300;
  for (let t = step; t < total; t += step) {
    ctx.fillText(duration(t), x(t), h - 6);
    ctx.fillRect(x(t), bottom, 1, 4);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.beginPath();
  ctx.moveTo(left, bottom + 0.5);
  ctx.lineTo(right, bottom + 0.5);
  ctx.stroke();
}
