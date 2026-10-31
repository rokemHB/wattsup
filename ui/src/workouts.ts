// Workouts: ERG interval protocols, as presets (in percent of FTP) and the
// rider's own saved ones (in watts), kept in local storage.
import { api } from "./api";
import type { RampResult, Workout, WorkoutStep } from "./types";

export interface Preset {
  name: string;
  /** Steps as [percent of FTP, minutes], or [watts, minutes] when `absolute`. */
  steps: [number, number][];
  absolute?: boolean;
  ramp?: boolean;
}

/** The FTP ramp test: 5 minutes of warm-up at 100 W, then from 120 W up by 20 W a minute. */
const RAMP_STEPS: [number, number][] = [[100, 5], ...Array.from({ length: 30 }, (_, k): [number, number] => [120 + 20 * k, 1])];

export const PRESETS: Preset[] = [
  { name: "Sweet spot 3 × 10", steps: [[55, 10], [90, 10], [55, 5], [90, 10], [55, 5], [90, 10], [50, 10]] },
  { name: "Threshold 2 × 20", steps: [[55, 10], [100, 20], [55, 8], [100, 20], [50, 10]] },
  { name: "VO2max 5 × 3", steps: [[55, 10], [120, 3], [50, 3], [120, 3], [50, 3], [120, 3], [50, 3], [120, 3], [50, 3], [120, 3], [50, 10]] },
  { name: "Endurance 60", steps: [[55, 10], [68, 45], [50, 5]] },
  { name: "FTP ramp test", steps: RAMP_STEPS, absolute: true, ramp: true },
];

export function fromPreset(p: Preset, ftp: number): Workout {
  const w: Workout = { name: p.name, steps: p.steps.map(([v, min]) => ({ watts: p.absolute ? v : Math.round((v / 100) * ftp / 5) * 5, seconds: min * 60 })) };
  if (p.ramp) w.ramp = true;
  return w;
}

/**
 * The end of a ramp test for a finish screen: its title and stat rows. The new FTP is saved
 * and handed to the engine at once (the HUD's time estimates and the presets use it).
 */
export function rampOutcome(r: RampResult): { title: string; rows: [string, string][] } {
  if (r.ftp_w >= 50) {
    saveFtp(r.ftp_w);
    api.setFtp(r.ftp_w).catch(console.error);
  }
  const min = Math.floor(r.ramp_s / 60);
  const sec = Math.round(r.ramp_s % 60);
  return {
    title: r.ftp_w >= 50 ? `Your FTP: ${r.ftp_w} W` : "FTP test: too short to tell",
    rows: [
      ["FTP (75 % of best minute)", r.ftp_w >= 50 ? `${r.ftp_w} W · saved` : "–"],
      ["Best minute", `${r.best_minute_w} W`],
      ["Highest step held", r.last_step_w ? `${r.last_step_w} W` : "–"],
      ["Ramp ridden", `${min}:${String(sec).padStart(2, "0")}`],
    ],
  };
}

export function totalSeconds(w: Workout): number {
  return w.steps.reduce((s, x) => s + x.seconds, 0);
}

export function averageWatts(w: Workout): number {
  const t = totalSeconds(w);
  return t ? w.steps.reduce((s, x) => s + x.watts * x.seconds, 0) / t : 0;
}

export function describe(w: Workout): string {
  const minutes = Math.round(totalSeconds(w) / 60);
  return `${minutes} min · ${w.steps.length} steps · avg ${Math.round(averageWatts(w))} W`;
}

const KEY = "wattsup.workouts";
const FTP_KEY = "wattsup.ftp";

export function loadWorkouts(): Workout[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as Workout[]) : [];
    return list.filter((w) => w && Array.isArray(w.steps));
  } catch {
    return [];
  }
}

export function saveWorkouts(list: Workout[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage may be unavailable; the list then lasts for the session.
  }
}

export function loadFtp(): number {
  try {
    const v = Number(localStorage.getItem(FTP_KEY));
    return v >= 50 && v <= 600 ? v : 200;
  } catch {
    return 200;
  }
}

export function saveFtp(ftp: number) {
  try {
    localStorage.setItem(FTP_KEY, String(ftp));
  } catch {
    // ignore
  }
}

export function validStep(s: WorkoutStep): boolean {
  return Number.isFinite(s.watts) && s.watts >= 0 && s.watts <= 1500 && Number.isFinite(s.seconds) && s.seconds > 0;
}
