//! WattsUp desktop app: a thin Tauri shell. All ride logic lives in
//! `wattsup-engine`; this file only exposes it as commands and forwards
//! snapshots to the web view as `snapshot` events.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod tiles;

use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager, State};
use wattsup_core::gearing::ShiftDirection;
use wattsup_core::network::{NetworkInfo, PlannedLeg};
use wattsup_core::protocol::zwift::Button;
use wattsup_core::route::{Route, RouteInfo, BUILTIN_ROUTES};
use wattsup_core::session::{ControlMode, Workout};
use wattsup_devices::{DeviceId, DeviceKind};
use wattsup_engine::rides::{RideRecord, RideStore, RideSummary};
use wattsup_engine::{Engine, EngineConfig, EngineSnapshot, ScanResult};

struct AppState {
    engine: Engine,
    startup: StartupInfo,
    /// Rides on disk: `<app data dir>/rides`.
    rides: RideStore,
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
    /// The route came from `--route` / WATTSUP_ROUTE; otherwise the UI may restore the last one ridden.
    route_given: bool,
    /// Metres along the route to start at (for looking at a specific spot).
    start_m: f64,
    /// Camera mode to start in: chase, side, front or drone.
    camera: Option<String>,
    /// Screen to open at startup (start, menu, rider, settings, ride), for looking at one.
    screen: Option<String>,
    /// "lat,lon[,back]": start the island ride at that spot (for looking at a place).
    island_at: Option<String>,
    /// JavaScript the UI runs once it is up (WATTSUP_DEV_JS): for driving the screens from a script when testing.
    dev_js: Option<String>,
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
        route_given: value("--route", "WATTSUP_ROUTE").is_some(),
        start_m: value("--start", "WATTSUP_START_M")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.0),
        camera: value("--camera", "WATTSUP_CAMERA"),
        // `--trainer` / WATTSUP_TRAINER=1: the ERG-only trainer screen, no 3D world.
        screen: value("--screen", "WATTSUP_SCREEN")
            .or_else(|| flag("--trainer", "WATTSUP_TRAINER").then(|| "trainer".to_string())),
        island_at: value("--island-at", "WATTSUP_ISLAND_AT"),
        dev_js: std::env::var("WATTSUP_DEV_JS").ok().filter(|s| !s.is_empty()),
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
fn network_info(state: State<'_, AppState>, world: String) -> Option<NetworkInfo> {
    state.engine.network_info(&world)
}

#[tauri::command]
fn network_points(state: State<'_, AppState>, world: String) -> CmdResult<tauri::ipc::Response> {
    state
        .engine
        .network_points(&world)
        .map(tauri::ipc::Response::new)
        .ok_or_else(|| format!("no road network for {world}"))
}

#[tauri::command]
async fn start_on_network(state: State<'_, AppState>, world: String, x: f64, z: f64, forward: bool) -> CmdResult<()> {
    state.engine.start_on_network(&world, x, z, forward).await
}

#[tauri::command]
async fn start_planned_ride(
    state: State<'_, AppState>,
    world: String,
    name: String,
    legs: Vec<PlannedLeg>,
) -> CmdResult<()> {
    state.engine.start_planned_ride(&world, &name, &legs).await
}

#[tauri::command]
async fn replan_ride(state: State<'_, AppState>, world: String, name: String, legs: Vec<PlannedLeg>) -> CmdResult<()> {
    state.engine.replan_ride(&world, &name, &legs).await
}

#[tauri::command]
fn set_ftp(state: State<'_, AppState>, watts: f64) {
    state.engine.set_ftp(watts);
}

#[tauri::command]
async fn choose_turn(state: State<'_, AppState>, edge: usize) -> CmdResult<bool> {
    Ok(state.engine.choose_turn(edge).await)
}

#[tauri::command]
async fn turn_around(state: State<'_, AppState>) -> CmdResult<bool> {
    Ok(state.engine.turn_around().await)
}

/// Stores the ride so far (its totals and one-second samples) and answers its summary.
#[tauri::command]
fn save_ride(state: State<'_, AppState>) -> CmdResult<RideSummary> {
    let report = state.engine.ride_report();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let started_at_ms = now_ms.saturating_sub((report.elapsed_s * 1000.0) as u64);
    state.rides.save(report, started_at_ms)
}

#[tauri::command]
fn rides(state: State<'_, AppState>) -> Vec<RideSummary> {
    state.rides.list()
}

#[tauri::command]
fn ride(state: State<'_, AppState>, id: String) -> CmdResult<RideRecord> {
    state.rides.load(&id)
}

#[tauri::command]
fn delete_ride(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.rides.delete(&id)
}

#[tauri::command]
async fn start_workout(state: State<'_, AppState>, workout: Workout) -> CmdResult<()> {
    state.engine.start_workout(workout).await;
    Ok(())
}

#[tauri::command]
async fn stop_workout(state: State<'_, AppState>) -> CmdResult<()> {
    state.engine.stop_workout().await;
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
async fn set_workout_bias(state: State<'_, AppState>, watts: f64) -> CmdResult<()> {
    state.engine.set_workout_bias(watts).await;
    Ok(())
}

#[tauri::command]
async fn skip_workout_step(state: State<'_, AppState>) -> CmdResult<bool> {
    Ok(state.engine.skip_workout_step().await)
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
async fn set_virtual_gearing(state: State<'_, AppState>, on: bool) -> CmdResult<()> {
    state.engine.set_virtual_gearing(on).await;
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
            let rides = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("wattsup"))
                .join("rides");
            app.manage(AppState {
                engine,
                startup: startup.clone(),
                rides: RideStore::new(rides),
            });
            app.manage(tiles::Tiles::new(app.handle()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_info,
            snapshot,
            route,
            routes,
            set_route,
            reset_ride,
            start_workout,
            stop_workout,
            network_info,
            network_points,
            start_on_network,
            start_planned_ride,
            replan_ride,
            set_ftp,
            choose_turn,
            turn_around,
            save_ride,
            rides,
            ride,
            delete_ride,
            tiles::fetch_cached,
            tiles::cache_fetch,
            scan,
            connect,
            disconnect,
            shift,
            set_mode,
            set_workout_bias,
            skip_workout_step,
            set_erg_target,
            set_road_grade,
            set_auto_shift,
            set_target_cadence,
            set_virtual_gearing,
            press_button
        ])
        .run(tauri::generate_context!())
        .expect("error while running WattsUp");
}
