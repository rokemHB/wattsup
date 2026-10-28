// The trainer screen: ERG workouts without the 3D world, for training beside a video.
// Setup (quick block or a workout), the live view (target, power, step clock, +/- watts,
// skip, end) and the summary when it is done. The 3D world is not built in this mode.
import { api } from "./api";
import { $, el } from "./dom";
import { duration, num } from "./format";
import { drawWorkout } from "./hud";
import type { EngineSnapshot, Workout } from "./types";
import { describe, fromPreset, loadFtp, loadWorkouts, PRESETS, saveFtp } from "./workouts";

export interface TrainerCallbacks {
  /** Starts `w` in ERG mode on the flat road, with no world. */
  start(w: Workout): Promise<void>;
  /** The workout is over or was ended: store the ride, stop the workout. */
  end(): Promise<void>;
  /** Opens the workout editor on `w` (index into the saved list, -1 for a preset). */
  edit(w: Workout, index: number): void;
  settings(): void;
}

type Phase = "setup" | "live" | "done";

/** A quick block: warm-up and cool-down as a share of FTP, the main part at the given watts. */
export function quickBlock(minutes: number, watts: number, warmMin: number, coolMin: number, ftp: number): Workout {
  const steps = [];
  if (warmMin > 0) steps.push({ watts: Math.round((0.55 * ftp) / 5) * 5, seconds: warmMin * 60 });
  steps.push({ watts, seconds: minutes * 60 });
  if (coolMin > 0) steps.push({ watts: Math.round((0.5 * ftp) / 5) * 5, seconds: coolMin * 60 });
  return { name: `${minutes} min at ${watts} W`, steps };
}

export class TrainerScreen {
  private phase: Phase = "setup";
  private workout: Workout | null = null;
  private barKey = "";
  private ftp = loadFtp();
  private compact = false;

  constructor(private cb: TrainerCallbacks) {
    $("trainer-quick").onclick = () => {
      const n = (id: string) => Number($<HTMLInputElement>(id).value) || 0;
      const w = quickBlock(Math.max(1, n("trainer-min")), Math.max(0, n("trainer-watts")), n("trainer-warm"), n("trainer-cool"), this.ftp);
      this.begin(w);
    };
    const ftp = $<HTMLInputElement>("trainer-ftp");
    ftp.onchange = () => {
      this.ftp = Math.min(600, Math.max(50, Number(ftp.value) || this.ftp));
      saveFtp(this.ftp);
      api.setFtp(this.ftp).catch(console.error);
      this.renderSetup();
    };
    $("trainer-minus").onclick = () => this.bias(-5);
    $("trainer-plus").onclick = () => this.bias(5);
    $("trainer-skip").onclick = () => api.skipWorkoutStep().catch(console.error);
    $("trainer-end").onclick = () => this.finish();
    $("trainer-done-ok").onclick = () => this.showSetup();
    $("trainer-settings").onclick = () => cb.settings();
    $("trainer-compact").onclick = () => this.setCompact(!this.compact).catch(console.error);
  }

  /** Shows the setup view (unless a workout is running, which keeps the live view). */
  open() {
    this.ftp = loadFtp();
    if (this.phase === "setup") this.showSetup();
  }

  /** Keyboard: + / − change the watts, S skips a step. True when handled. */
  key(k: string): boolean {
    if (this.phase !== "live") return false;
    if (k === "+" || k === "=" || k === "ArrowUp") this.bias(5);
    else if (k === "-" || k === "ArrowDown") this.bias(-5);
    else if (k === "s" || k === "S") api.skipWorkoutStep().catch(console.error);
    else return false;
    return true;
  }

  /** Start was clicked and the engine has not reported the workout yet. */
  private starting = false;

  private begin(w: Workout) {
    this.workout = w;
    this.barKey = "";
    this.phase = "live";
    this.starting = true;
    this.show("live");
    this.cb
      .start(w)
      .catch((e) => {
        console.error(e);
        this.showSetup();
      })
      .finally(() => (this.starting = false));
  }

  private finish() {
    if (this.phase !== "live") return;
    this.phase = "done";
    this.cb.end().catch(console.error);
  }

  private bias(delta: number) {
    const current = this.lastBias;
    api.setWorkoutBias(current + delta).catch(console.error);
  }

  private lastBias = 0;

  private showSetup() {
    this.phase = "setup";
    this.workout = null;
    this.show("setup");
    this.renderSetup();
  }

  private show(view: "setup" | "live" | "done") {
    $("trainer-setup").hidden = view !== "setup";
    $("trainer-live").hidden = view !== "live";
    $("trainer-done").hidden = view !== "done";
  }

  private renderSetup() {
    $<HTMLInputElement>("trainer-ftp").value = String(this.ftp);
    const watts = $<HTMLInputElement>("trainer-watts");
    if (!watts.value) watts.value = String(Math.round((0.7 * this.ftp) / 5) * 5);
    const saved = loadWorkouts();
    const card = (w: Workout, index: number) => {
      const start = el("button", { className: "primary", textContent: "Start" });
      start.onclick = (e) => {
        e.stopPropagation();
        this.begin(w);
      };
      const c = el("div", { className: "route-card" }, el("b", {}, w.name), start, el("span", { className: "meta" }, `${describe(w)}${index < 0 ? " · preset at FTP" : ""}`));
      c.onclick = () => this.cb.edit(w, index);
      return c;
    };
    $("trainer-workouts").replaceChildren(...saved.map((w, i) => card(w, i)), ...PRESETS.map((p) => card(fromPreset(p, this.ftp), -1)));
  }

  /** Feeds the latest engine state; drives the live and done views. */
  update(snap: EngineSnapshot) {
    this.renderDevices(snap);
    const w = snap.session.workout;
    if (this.phase === "done") {
      if (!$("trainer-done").hidden) return;
      this.renderDone(snap);
      return;
    }
    if (!w) {
      if (this.phase === "live" && !this.starting) this.showSetup(); // ended elsewhere
      return;
    }
    if (this.phase !== "live") {
      // A workout started from the editor or before this screen opened.
      this.phase = "live";
      if (this.workout?.name !== w.name) this.workout = null;
      this.show("live");
    }
    if (w.done) {
      this.phase = "done";
      this.renderDone(snap);
      this.cb.end().catch(console.error);
      return;
    }
    const s = snap.session;
    this.lastBias = w.bias_w;
    const target = w.step_watts + w.bias_w;
    $("trainer-target").textContent = `${Math.round(target)}`;
    $("trainer-bias").textContent = w.bias_w ? `W · ${w.bias_w > 0 ? "+" : ""}${w.bias_w} W` : "W";
    const power = $("trainer-power");
    power.textContent = num(s.power_w);
    power.className = s.power_w === null ? "" : Math.abs(s.power_w - target) <= Math.max(10, target * 0.08) ? "on" : "off";
    $("trainer-cadence").textContent = num(s.cadence_rpm);
    $("trainer-hr").textContent = num(s.heart_rate_bpm);
    $("trainer-step-left").textContent = duration(Math.max(0, w.step_seconds - w.step_elapsed_s));
    $("trainer-step").textContent = `interval ${w.step + 1} / ${w.steps} · ${Math.round(w.step_watts)} W`;
    $("trainer-next").textContent = w.next_watts === null ? "last interval" : `next ${Math.round(w.next_watts)} W`;
    $("trainer-total").textContent = `${duration(Math.max(0, w.total_seconds - w.elapsed_s))} left of ${duration(w.total_seconds)}`;
    $("trainer-paused").hidden = !w.paused;
    $("trainer-elapsed").textContent = `${duration(s.elapsed_s)} · ${(s.stats.distance_m / 1000).toFixed(1)} km · ${Math.round(s.stats.energy_kj)} kJ`;
    const bar = $<HTMLCanvasElement>("trainer-bar");
    const key = `${bar.clientWidth}:${w.elapsed_s.toFixed(0)}:${w.name}`;
    if (key !== this.barKey) {
      this.barKey = key;
      const workout = this.workout ?? this.rebuild(snap);
      if (workout) drawWorkout(bar, workout, w.elapsed_s);
    }
  }

  /** A workout started elsewhere: the bar needs its steps, which the snapshot does not carry; use the saved one by name. */
  private rebuild(snap: EngineSnapshot): Workout | null {
    const name = snap.session.workout?.name;
    const found = loadWorkouts().find((w) => w.name === name) ?? PRESETS.filter((p) => p.name === name).map((p) => fromPreset(p, this.ftp))[0];
    if (found) this.workout = found;
    return found ?? null;
  }

  private renderDone(snap: EngineSnapshot) {
    const s = snap.session;
    const st = s.stats;
    this.show("done");
    const w = snap.session.workout;
    $("trainer-done-title").textContent = w ? `${w.name}: ${w.done ? "complete!" : "ended"}` : "Workout ended";
    const item = (label: string, value: string) => [el("span", {}, label), el("b", {}, value)];
    $("trainer-done-stats").replaceChildren(
      ...item("Time", duration(s.elapsed_s)),
      ...item("Average power", st.avg_power_w === null ? "–" : `${num(st.avg_power_w)} W`),
      ...item("Normalized power", st.normalized_power_w === null ? "–" : `${num(st.normalized_power_w)} W`),
      ...item("Average heart rate", st.avg_heart_rate_bpm === null ? "–" : `${num(st.avg_heart_rate_bpm)} bpm`),
      ...item("Average cadence", st.avg_cadence_rpm === null ? "–" : `${num(st.avg_cadence_rpm)} rpm`),
      ...item("Energy", `${Math.round(st.energy_kj)} kJ`),
    );
  }

  private devicesKey = "";

  private renderDevices(snap: EngineSnapshot) {
    const parts = snap.devices
      .filter((d) => d.kind !== "controller")
      .map((d) => {
        const label = d.kind === "trainer" ? "Trainer" : "Heart rate";
        const st = d.state.state;
        return st === "connected" ? `${label}: ${d.name ?? d.id}` : st === "disconnected" ? `${label}: none` : `${label}: ${st}`;
      });
    const key = parts.join("|");
    if (key === this.devicesKey) return;
    this.devicesKey = key;
    const trainer = snap.devices.find((d) => d.kind === "trainer");
    const ok = trainer?.state.state === "connected";
    $("trainer-devices").replaceChildren(el("span", { className: ok ? "tone-ok" : "tone-bad" }, parts.join(" · ")), ok ? "" : el("span", { className: "hint" }, " — connect the trainer under Devices"));
  }

  /** A small always-on-top window beside the video, or the normal one. */
  async setCompact(on: boolean) {
    this.compact = on;
    $("screen-trainer").classList.toggle("compact", on);
    document.body.classList.toggle("compact", on);
    $("trainer-compact").textContent = on ? "Normal window" : "Small window";
    await api.compactWindow(on);
  }
}
