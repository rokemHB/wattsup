// Typed wrappers around the Tauri commands in src-tauri/src/main.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PlannedLeg } from "./routing";
import type {
  ControlMode,
  ControllerButton,
  DeviceKind,
  EngineSnapshot,
  NetworkInfo,
  RideRecord,
  RideSummary,
  Route,
  RouteInfo,
  ScanResult,
  ShiftDirection,
  StartupInfo,
  Workout,
} from "./types";

export const insideTauri = (): boolean => "__TAURI_INTERNALS__" in window;

export const api = {
  startupInfo: () => invoke<StartupInfo>("startup_info"),
  snapshot: () => invoke<EngineSnapshot>("snapshot"),
  route: () => invoke<Route | null>("route"),
  routes: () => invoke<RouteInfo[]>("routes"),
  setRoute: (id: string) => invoke<void>("set_route", { id }),
  resetRide: () => invoke<void>("reset_ride"),
  startWorkout: (workout: Workout) => invoke<void>("start_workout", { workout }),
  networkInfo: (world: string) => invoke<NetworkInfo | null>("network_info", { world }),
  networkPoints: async (world: string) => new Float32Array(await invoke<ArrayBuffer>("network_points", { world })),
  startOnNetwork: (world: string, x: number, z: number, forward: boolean) => invoke<void>("start_on_network", { world, x, z, forward }),
  /** A ride along legs planned on the map (see `routing.ts`); the ride finishes at the last leg's end. */
  startPlannedRide: (world: string, name: string, legs: PlannedLeg[]) => invoke<void>("start_planned_ride", { world, name, legs }),
  chooseTurn: (edge: number) => invoke<boolean>("choose_turn", { edge }),
  /** Turns the rider around on the road network; false when not on one. */
  turnAround: () => invoke<boolean>("turn_around"),
  /** Stores the ride so far on disk and answers its summary. */
  saveRide: () => invoke<RideSummary>("save_ride"),
  rides: () => invoke<RideSummary[]>("rides"),
  ride: (id: string) => invoke<RideRecord>("ride", { id }),
  deleteRide: (id: string) => invoke<void>("delete_ride", { id }),
  /** Map data bytes through the app's disk cache. */
  fetchCached: (url: string) => invoke<ArrayBuffer>("fetch_cached", { url }),
  /** Downloads a map data URL into the disk cache without sending it to the UI; answers its size in bytes. */
  cacheFetch: (url: string) => invoke<number>("cache_fetch", { url }),
  stopWorkout: () => invoke<void>("stop_workout"),
  scan: (seconds: number) => invoke<ScanResult>("scan", { seconds }),
  connect: (id: string, kind: DeviceKind) => invoke<void>("connect", { id, kind }),
  disconnect: (kind: DeviceKind) => invoke<void>("disconnect", { kind }),
  shift: (direction: ShiftDirection) => invoke<void>("shift", { direction }),
  setMode: (mode: ControlMode) => invoke<void>("set_mode", { mode }),
  setErgTarget: (watts: number) => invoke<void>("set_erg_target", { watts }),
  setRoadGrade: (grade: number) => invoke<void>("set_road_grade", { grade }),
  setAutoShift: (enabled: boolean) => invoke<void>("set_auto_shift", { enabled }),
  setTargetCadence: (rpm: number) => invoke<void>("set_target_cadence", { rpm }),
  setVirtualGearing: (on: boolean) => invoke<void>("set_virtual_gearing", { on }),
  pressButton: (button: ControllerButton) => invoke<void>("press_button", { button }),
  quit: () => getCurrentWindow().close(),
  toggleFullscreen: async () => {
    const win = getCurrentWindow();
    await win.setFullscreen(!(await win.isFullscreen()));
  },
  onSnapshot: (handler: (s: EngineSnapshot) => void): Promise<UnlistenFn> =>
    listen<EngineSnapshot>("snapshot", (e) => handler(e.payload)),
};
