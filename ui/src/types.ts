// Mirrors of the Rust types the backend serializes (serde, snake_case).
// Keep in sync with crates/core/src/session.rs and crates/engine/src/lib.rs.

export type ControlMode = "sim" | "erg";
export type DeviceKind = "trainer" | "heart_rate" | "controller";
export type ShiftDirection = "up" | "down";
export type ControllerButton = "shift_up_right" | "shift_up_left" | "plus" | "minus";

export interface SimTarget {
  grade_pct: number;
  crr: number;
  cw_kg_per_m: number;
  wind_mps: number;
  desired_grade_pct: number;
  clamped: "low" | "high" | null;
}

export type TrainerCommand =
  | ({ type: "simulation" } & SimTarget)
  | { type: "target_power"; watts: number };

export interface SessionSnapshot {
  elapsed_s: number;
  mode: ControlMode;
  erg_target_w: number;
  road_grade_pct: number;
  gear: number;
  gear_count: number;
  gear_ratio: number;
  auto_shift: boolean;
  target_cadence_rpm: number;
  virtual_gearing: boolean;
  power_w: number | null;
  cadence_rpm: number | null;
  trainer_speed_kmh: number | null;
  heart_rate_bpm: number | null;
  virtual_speed_kmh: number;
  distance_m: number;
  route_position_m: number;
  lap: number;
  finished: boolean;
  workout: WorkoutSnapshot | null;
  trainer_offline: boolean;
  model_power_w: number;
  last_command: TrainerCommand | null;
  last_command_age_s: number | null;
  measured_drive_ratio: number | null;
  stats: RideStats;
}

/** Totals of the ride so far (crates/core/src/session.rs `RideStats`). */
export interface RideStats {
  moving_s: number;
  distance_m: number;
  ascent_m: number;
  descent_m: number;
  avg_power_w: number | null;
  max_power_w: number;
  normalized_power_w: number | null;
  avg_heart_rate_bpm: number | null;
  max_heart_rate_bpm: number;
  avg_cadence_rpm: number | null;
  avg_speed_kmh: number;
  energy_kj: number;
}

/** One second of a ride. */
export interface RideSample {
  t_s: number;
  distance_m: number;
  elevation_m: number;
  grade_pct: number;
  speed_kmh: number;
  power_w: number | null;
  cadence_rpm: number | null;
  heart_rate_bpm: number | null;
}

/** A stored ride as the list shows it (crates/engine/src/rides.rs). */
export interface RideSummary {
  id: string;
  started_at_ms: number;
  route: string;
  world: string | null;
  workout: string | null;
  finished: boolean;
  elapsed_s: number;
  stats: RideStats;
}

export interface RideRecord {
  summary: RideSummary;
  samples: RideSample[];
}

export type ConnectionState =
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "reconnecting"; detail: string }
  | { state: "failed"; detail: string };

export interface DeviceStatus {
  kind: DeviceKind;
  id: string | null;
  name: string | null;
  state: ConnectionState;
  battery_percent: number | null;
}

export interface LogLine {
  seq: number;
  elapsed_s: number;
  source: string;
  message: string;
}

export type Turn = "sharp_left" | "left" | "straight" | "right" | "sharp_right" | "u_turn";

export interface TurnOption {
  edge: number;
  turn: Turn;
  angle_deg: number;
  ref: string | null;
  to: string[];
  chosen: boolean;
}

export interface Junction {
  node: number;
  at_m: number;
  options: TurnOption[];
}

/** The next junction a planned route takes, however far ahead. */
export interface Maneuver {
  at_m: number;
  turn: Turn;
  ref: string | null;
  to: string[];
}

/** Where a network ride is going. */
export interface Navigation {
  /** The ride follows a route planned on the map; false once the rider has left it. */
  planned: boolean;
  remaining_m: number | null;
  remaining_climb_m: number | null;
  next: Maneuver | null;
  /** Time to the destination from the profile ahead, at the rider's average power (70 % of FTP before a minute). */
  eta_s: number | null;
  /** Where the current leg ends: a re-plan starts there. */
  leg_end: { edge: number; index: number } | null;
}

export interface EngineSnapshot {
  session: SessionSnapshot;
  devices: DeviceStatus[];
  providers: string[];
  log: LogLine[];
  route_version: number;
  junction: Junction | null;
  navigation: Navigation | null;
}

export interface Sign {
  edge: number;
  ref: string | null;
  to: string[];
}

export interface NetworkNode {
  x: number;
  z: number;
  y: number;
  signs: Sign[] | null;
}

export interface NetworkEdge {
  a: number;
  b: number;
  ref: string | null;
  name: string | null;
  kind: number;
  start: number;
  count: number;
  length_m: number;
  tunnel?: boolean;
  /** Confirmation signs along the edge: at point `at` (edge-local), for riders heading toward b or a, the next towns with km. */
  markers?: { at: number; toward_b: boolean; to: [string, number][] }[];
}

export interface Place {
  name: string;
  kind: string;
  x: number;
  z: number;
}

export interface NetworkInfo {
  name: string;
  origin: { lat: number; lon: number };
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  places: Place[];
  points: number;
}

export interface DiscoveredDevice {
  id: string;
  name: string;
  kinds: DeviceKind[];
  rssi: number | null;
  simulated: boolean;
}

export interface ScanResult {
  devices: DiscoveredDevice[];
  errors: string[];
}

export interface RoutePoint {
  distance_m: number;
  x: number;
  y: number;
  z: number;
}

export interface Route {
  name: string;
  points: RoutePoint[];
  closed: boolean;
  /** Id of a real-world terrain under /worlds/, or null for a procedural world. */
  world: string | null;
}

export interface WorkoutStep {
  watts: number;
  seconds: number;
}

export interface Workout {
  name: string;
  steps: WorkoutStep[];
}

export interface WorkoutSnapshot {
  name: string;
  step: number;
  steps: number;
  step_watts: number;
  step_seconds: number;
  step_elapsed_s: number;
  total_seconds: number;
  elapsed_s: number;
  next_watts: number | null;
  paused: boolean;
  done: boolean;
  /** Watts the rider added to every step during the workout. */
  bias_w: number;
}

export interface RouteInfo {
  id: string;
  name: string;
  length_m: number;
  climb_m: number;
  closed: boolean;
  world: string | null;
}

export interface StartupInfo {
  ble: boolean;
  sim: boolean;
  raw_logging: boolean;
  auto_sim: boolean;
  route: string;
  start_m: number;
  camera: string | null;
  screen: string | null;
  island_at: string | null;
  dev_js: string | null;
}
