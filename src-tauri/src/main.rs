//! WattsUp desktop app: a thin Tauri shell. All ride logic lives in
//! `wattsup-engine`; this file only exposes it as commands and forwards
//! snapshots to the web view as `snapshot` events.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager, State};
use wattsup_core::gearing::ShiftDirection;
use wattsup_core::protocol::zwift::Button;
use wattsup_core::route::Route;
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
}

/// `--sim-only`, `--no-sim`, `--raw`, `--auto-sim`, or the same as
/// WATTSUP_SIM_ONLY / WATTSUP_NO_SIM / WATTSUP_RAW / WATTSUP_AUTO_SIM=1.
fn startup_from_env() -> StartupInfo {
    let args: Vec<String> = std::env::args().collect();
    let flag = |arg: &str, var: &str| args.iter().any(|a| a == arg) || std::env::var(var).is_ok_and(|v| v == "1");
    StartupInfo {
        ble: !flag("--sim-only", "WATTSUP_SIM_ONLY"),
        sim: !flag("--no-sim", "WATTSUP_NO_SIM"),
        raw_logging: flag("--raw", "WATTSUP_RAW"),
        auto_sim: flag("--auto-sim", "WATTSUP_AUTO_SIM"),
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
            config.session.route = Some(Route::demo());
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
            scan,
            connect,
            disconnect,
            shift,
            set_mode,
            set_erg_target,
            set_road_grade,
            press_button
        ])
        .run(tauri::generate_context!())
        .expect("error while running WattsUp");
}
