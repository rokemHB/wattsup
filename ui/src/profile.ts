// The rider's profile: name, weight, avatar and kit colours. Kept in the web view's
// local storage; later the multiplayer client will send it along.

export interface Profile {
  name: string;
  avatar: string;
  jersey: string;
  accent: string;
  bike: string;
  /** Body mass in kg: what the physics needs; the trainer feels it on every climb. */
  weightKg: number;
}

export const AVATARS = ["🚴", "🦅", "🦊", "🐺", "🦁", "🐉", "🦈", "🐆", "🦉", "🐐", "🚀", "⚡"];
export const JERSEYS = ["#ffc400", "#ff4d4d", "#3ddc84", "#40c8ff", "#ff7ad9", "#f4f4f4", "#8a5cff", "#ff8a00"];
export const ACCENTS = ["#1b1b22", "#f4f4f4", "#ffc400", "#ff4d4d", "#40c8ff", "#3ddc84"];
export const BIKES = ["#2b7fff", "#1b1b22", "#ff4d4d", "#f4f4f4", "#3ddc84", "#ffc400", "#8a5cff", "#c9ccd4"];

export const DEFAULT_PROFILE: Profile = { name: "Rider", avatar: "🚴", jersey: "#ffc400", accent: "#1b1b22", bike: "#2b7fff", weightKg: 75 };

const KEY = "wattsup.profile";

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PROFILE };
    const p = JSON.parse(raw) as Partial<Profile>;
    const weightKg = Number(p.weightKg);
    return { ...DEFAULT_PROFILE, ...p, name: (p.name ?? DEFAULT_PROFILE.name).slice(0, 24), weightKg: weightKg >= 30 && weightKg <= 200 ? weightKg : DEFAULT_PROFILE.weightKg };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Storage may be unavailable (private mode); the profile then lasts for the session.
  }
}
