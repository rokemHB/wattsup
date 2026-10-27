// Workouts: ERG interval protocols, as presets (in percent of FTP) and the
// rider's own saved ones (in watts), kept in local storage.
import type { Workout, WorkoutStep } from "./types";

export interface Preset {
  name: string;
  /** Steps as [percent of FTP, minutes]. */
  steps: [number, number][];
}

export const PRESETS: Preset[] = [
  { name: "Sweet spot 3 × 10", steps: [[55, 10], [90, 10], [55, 5], [90, 10], [55, 5], [90, 10], [50, 10]] },
  { name: "Threshold 2 × 20", steps: [[55, 10], [100, 20], [55, 8], [100, 20], [50, 10]] },
  { name: "VO2max 5 × 3", steps: [[55, 10], [120, 3], [50, 3], [120, 3], [50, 3], [120, 3], [50, 3], [120, 3], [50, 3], [120, 3], [50, 10]] },
  { name: "Endurance 60", steps: [[55, 10], [68, 45], [50, 5]] },
  { name: "Ramp test", steps: [[40, 5], [50, 1], [60, 1], [70, 1], [80, 1], [90, 1], [100, 1], [110, 1], [120, 1], [130, 1], [140, 1], [150, 1]] },
];

export function fromPreset(p: Preset, ftp: number): Workout {
  return { name: p.name, steps: p.steps.map(([pct, min]) => ({ watts: Math.round((pct / 100) * ftp / 5) * 5, seconds: min * 60 })) };
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
