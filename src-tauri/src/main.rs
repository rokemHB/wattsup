//! WattsUp desktop app: a thin Tauri shell. All ride logic lives in
//! `wattsup-engine`; this file only exposes it as commands and forwards
//! snapshots to the web view as `snapshot` events.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager, State};
use wattsup_core::gearing::ShiftDirection;
use wattsup_core::protocol::zwift::Button;
use wattsup_core::route::{Route, RouteInfo, BUILTIN_ROUTES};
use wattsup_core::session::ControlMode;
use wattsup_devices::{DeviceId, DeviceKind};
use wattsup_engine::{Engine, EngineConfig, EngineSnapshot, ScanResult};

struct AppState {
    engine: Engine,
    startup: StartupInfo,
}

/// How the app was started, shown on the debug screen.
#[derive(Clone, Debug, Serialize)]
struct StartupInfo {
    ble: bool,
    sim: bool,
    raw_logging: bool,
    /// Connect the simulated trainer, heart rate and controller right away.
    auto_sim: bool,
    /// Id of the built-in route to ride.
    route: String,
    /// Metres along the route to start at (for looking at a specific spot).
    start_m: f64,
    /// Camera mode to start in: chase, side, front or drone.
    camera: Option<String>,
    /// Screen to open at startup (start, menu, rider, settings, ride), for looking at one.
    screen: Option<String>,
}

/// `--sim-only`, `--no-sim`, `--raw`, `--auto-sim`, or the same as
/// WATTSUP_SIM_ONLY / WATTSUP_NO_SIM / WATTSUP_RAW / WATTSUP_AUTO_SIM=1,
/// and `--route <id>` / WATTSUP_ROUTE (default: the first built-in route).
fn startup_from_env() -> StartupInfo {
    let args: Vec<String> = std::env::args().collect();
    let flag = |arg: &str, var: &str| args.iter().any(|a| a == arg) || std::env::var(var).is_ok_and(|v| v == "1");
    let value = |arg: &str, var: &str| {
        args.iter()
            .position(|a| a == arg)
            .and_then(|i| args.get(i + 1).cloned())
            .or_else(|| std::env::var(var).ok())
    };
    StartupInfo {
        ble: !flag("--sim-only", "WATTSUP_SIM_ONLY"),
        sim: !flag("--no-sim", "WATTSUP_NO_SIM"),
        raw_logging: flag("--raw", "WATTSUP_RAW"),
        auto_sim: flag("--auto-sim", "WATTSUP_AUTO_SIM"),
        route: value("--route", "WATTSUP_ROUTE").unwrap_or_else(|| BUILTIN_ROUTES[0].to_string()),
        start_m: value("--start", "WATTSUP_START_M")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.0),
        camera: value("--camera", "WATTSUP_CAMERA"),
        screen: value("--screen", "WATTSUP_SCREEN"),
    }
}

type CmdResult<T> = Result<T, String>;

#[tauri::command]
fn startup_info(state: State<'_, AppState>) -> StartupInfo {
    state.startup.clone()
}

#[tauri::command]
fn snapshot(state: State<'_, AppState>) -> EngineSnapshot {
    state.engine.snapshot()
}

#[tauri::command]
fn route(state: State<'_, AppState>) -> Option<Route> {
    state.engine.route()
}

#[tauri::command]
fn routes(state: State<'_, AppState>) -> Vec<RouteInfo> {
    state.engine.routes()
}

#[tauri::command]
async fn set_route(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.engine.set_route(&id).await
}

#[tauri::command]
async fn reset_ride(state: State<'_, AppState>) -> CmdResult<()> {
    state.engine.reset_ride().await;
    Ok(())
}

#[tauri::command]
async fn scan(state: State<'_, AppState>, seconds: Option<f64>) -> CmdResult<ScanResult> {
    let secs = seconds.unwrap_or(5.0).clamp(0.5, 30.0);
    Ok(state.engine.scan(Duration::from_secs_f64(secs)).await)
}

#[tauri::command]
async fn connect(state: State<'_, AppState>, id: String, kind: DeviceKind) -> CmdResult<()> {
    state
        .engine
        .connect(&DeviceId(id), kind)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn disconnect(state: State<'_, AppState>, kind: DeviceKind) -> CmdResult<()> {
    state.engine.disconnect(kind).await;
    Ok(())
}

#[tauri::command]
async fn shift(state: State<'_, AppState>, direction: ShiftDirection) -> CmdResult<()> {
    state.engine.shift(direction).await;
    Ok(())
}

#[tauri::command]
async fn set_mode(state: State<'_, AppState>, mode: ControlMode) -> CmdResult<()> {
    state.engine.set_mode(mode).await;
    Ok(())
}

#[tauri::command]
async fn set_erg_target(state: State<'_, AppState>, watts: f64) -> CmdResult<()> {
    state.engine.set_erg_target(watts).await;
    Ok(())
}

#[tauri::command]
async fn set_road_grade(state: State<'_, AppState>, grade: f64) -> CmdResult<()> {
    state.engine.set_road_grade(grade).await;
    Ok(())
}

#[tauri::command]
fn set_auto_shift(state: State<'_, AppState>, enabled: bool) {
    state.engine.set_auto_shift(enabled);
}

#[tauri::command]
fn set_target_cadence(state: State<'_, AppState>, rpm: f64) {
    state.engine.set_target_cadence(rpm);
}

#[tauri::command]
async fn press_button(state: State<'_, AppState>, button: Button) -> CmdResult<()> {
    state.engine.press(button).await.map_err(|e| e.to_string())
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let startup = startup_from_env();
    tauri::Builder::default()
        .setup(move |app| {
            let mut config = EngineConfig {
                ble: startup.ble,
                sim: startup.sim,
                ..EngineConfig::default()
            };
            config.session.start_distance_m = startup.start_m;
            config.session.route = Some(Route::builtin(&startup.route).unwrap_or_else(|| {
                log::warn!("unknown route {:?}, riding {}", startup.route, BUILTIN_ROUTES[0]);
                Route::builtin(BUILTIN_ROUTES[0]).expect("built-in route")
            }));
            config.ble_config.log_raw = startup.raw_logging;
            // Engine::start spawns its loops, so it must run inside Tauri's Tokio runtime.
            let engine = tauri::async_runtime::block_on(async { Engine::start(config) });
            let mut snapshots = engine.subscribe();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Forward at most ~20 snapshots per second to the web view.
                while snapshots.changed().await.is_ok() {
                    let snap = snapshots.borrow_and_update().clone();
                    let _ = handle.emit("snapshot", snap);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            });
            if startup.auto_sim && startup.sim {
                // The simulated rider never shifts by itself; let the gears follow its cadence.
                engine.set_auto_shift(true);
                let engine = engine.clone();
                tauri::async_runtime::spawn(async move {
                    for (local, kind) in [
                        ("trainer", DeviceKind::Trainer),
                        ("heart-rate", DeviceKind::HeartRate),
                        ("controller", DeviceKind::Controller),
                    ] {
                        if let Err(e) = engine.connect(&DeviceId::new("sim", local), kind).await {
                            log::warn!("auto-connecting simulated {kind}: {e}");
                        }
                    }
                });
            }
            app.manage(AppState {
                engine,
                startup: startup.clone(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_info,
            snapshot,
            route,
            routes,
            set_route,
            reset_ride,
            scan,
            connect,
            disconnect,
            shift,
            set_mode,
            set_erg_target,
            set_road_grade,
            set_auto_shift,
            set_target_cadence,
            press_button
        ])
        .run(tauri::generate_context!())
        .expect("error while running WattsUp");
}
