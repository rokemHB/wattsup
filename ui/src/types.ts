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
  power_w: number | null;
  cadence_rpm: number | null;
  trainer_speed_kmh: number | null;
  heart_rate_bpm: number | null;
  virtual_speed_kmh: number;
  distance_m: number;
  model_power_w: number;
  last_command: TrainerCommand | null;
  last_command_age_s: number | null;
  measured_drive_ratio: number | null;
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

export interface EngineSnapshot {
  session: SessionSnapshot;
  devices: DeviceStatus[];
  providers: string[];
  log: LogLine[];
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

export interface StartupInfo {
  ble: boolean;
  sim: boolean;
  raw_logging: boolean;
  auto_sim: boolean;
}
