// Typed wrappers around the Tauri commands in src-tauri/src/main.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  ControlMode,
  ControllerButton,
  DeviceKind,
  EngineSnapshot,
  Route,
  RouteInfo,
  ScanResult,
  ShiftDirection,
  StartupInfo,
} from "./types";

export const insideTauri = (): boolean => "__TAURI_INTERNALS__" in window;

export const api = {
  startupInfo: () => invoke<StartupInfo>("startup_info"),
  snapshot: () => invoke<EngineSnapshot>("snapshot"),
  route: () => invoke<Route | null>("route"),
  routes: () => invoke<RouteInfo[]>("routes"),
  setRoute: (id: string) => invoke<void>("set_route", { id }),
  resetRide: () => invoke<void>("reset_ride"),
  scan: (seconds: number) => invoke<ScanResult>("scan", { seconds }),
  connect: (id: string, kind: DeviceKind) => invoke<void>("connect", { id, kind }),
  disconnect: (kind: DeviceKind) => invoke<void>("disconnect", { kind }),
  shift: (direction: ShiftDirection) => invoke<void>("shift", { direction }),
  setMode: (mode: ControlMode) => invoke<void>("set_mode", { mode }),
  setErgTarget: (watts: number) => invoke<void>("set_erg_target", { watts }),
  setRoadGrade: (grade: number) => invoke<void>("set_road_grade", { grade }),
  setAutoShift: (enabled: boolean) => invoke<void>("set_auto_shift", { enabled }),
  setTargetCadence: (rpm: number) => invoke<void>("set_target_cadence", { rpm }),
  pressButton: (button: ControllerButton) => invoke<void>("press_button", { button }),
  quit: () => getCurrentWindow().close(),
  toggleFullscreen: async () => {
    const win = getCurrentWindow();
    await win.setFullscreen(!(await win.isFullscreen()));
  },
  onSnapshot: (handler: (s: EngineSnapshot) => void): Promise<UnlistenFn> =>
    listen<EngineSnapshot>("snapshot", (e) => handler(e.payload)),
};
