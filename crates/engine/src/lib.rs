//! The ride engine: owns the device providers, the connected devices and the
//! [`RideSession`], and runs the event and tick loops between them.
//!
//! UIs (the Tauri app, the CLI) call methods and watch [`EngineSnapshot`]s;
//! they never talk to devices directly. A future multiplayer client would
//! subscribe here as well, publishing snapshots and receiving other riders'.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{watch, Mutex as AsyncMutex};
use tokio::time::Instant;
use wattsup_core::gearing::ShiftDirection;
use wattsup_core::network::{Junction, Maneuver, Navigator, Network, NetworkInfo, PlannedLeg};
use wattsup_core::physics::{steady_speed_for_power, RiderParams};
use wattsup_core::protocol::zwift::Button;
use wattsup_core::route::{Route, RouteInfo};
use wattsup_core::session::{ControlMode, RideReport, RideSession, SessionConfig, SessionSnapshot, Workout};
use wattsup_devices::sim::{SimConfig, SimProvider};
use wattsup_devices::{
    event_channel, ConnectionState, Controller, DeviceError, DeviceEvent, DeviceId, DeviceKind, DeviceProvider,
    DiscoveredDevice, EventReceiver, EventSender, HeartRateMonitor, Trainer,
};

pub mod rides;
pub mod tcx;

#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub session: SessionConfig,
    /// Offer real Bluetooth devices.
    pub ble: bool,
    #[cfg(feature = "ble")]
    pub ble_config: wattsup_devices::ble::BleConfig,
    /// Offer the simulated trainer, heart-rate strap and controller.
    pub sim: bool,
    pub sim_config: SimConfig,
    pub tick: Duration,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            session: SessionConfig::default(),
            ble: cfg!(feature = "ble"),
            #[cfg(feature = "ble")]
            ble_config: Default::default(),
            sim: true,
            sim_config: SimConfig::default(),
            tick: Duration::from_millis(250),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DeviceStatus {
    pub kind: DeviceKind,
    pub id: Option<DeviceId>,
    pub name: Option<String>,
    pub state: ConnectionState,
    pub battery_percent: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LogLine {
    pub seq: u64,
    pub elapsed_s: f64,
    pub source: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EngineSnapshot {
    pub session: SessionSnapshot,
    pub devices: Vec<DeviceStatus>,
    pub providers: Vec<String>,
    /// Newest last.
    pub log: Vec<LogLine>,
    /// Bumps whenever the route's points change (a new route, or a navigator extending or re-planning it).
    pub route_version: u64,
    /// The next junction with a choice, when riding a road network.
    pub junction: Option<Junction>,
    /// Where the ride is going, when riding a road network.
    pub navigation: Option<Navigation>,
}

/// Navigation values for the HUD of a network ride.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Navigation {
    /// The ride follows a route planned on the map (false once the rider has left it).
    pub planned: bool,
    /// Road left to the planned destination.
    pub remaining_m: Option<f64>,
    /// Climbing left to the planned destination.
    pub remaining_climb_m: Option<f64>,
    /// The next junction the plan takes, at any distance.
    pub next: Option<Maneuver>,
    /// Time to the planned destination from the road profile ahead: at the rider's
    /// average power so far, or at 70 % of FTP before a minute of riding.
    pub eta_s: Option<f64>,
    /// Where the rider's current leg ends; a re-plan (back onto a route) starts there.
    pub leg_end: Option<RoadPoint>,
}

/// A point of a road network: the edge and the global point index.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoadPoint {
    pub edge: usize,
    pub index: usize,
}

/// Share of FTP a rider is assumed to hold over a whole ride, for the time estimate.
const ETA_FTP_SHARE: f64 = 0.7;
/// Seconds of riding before the rider's own average power replaces the FTP guess.
const ETA_OWN_POWER_AFTER_S: f64 = 60.0;

/// How far ahead the rider is told about a junction.
const JUNCTION_LOOKAHEAD_M: f64 = 500.0;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ScanResult {
    pub devices: Vec<DiscoveredDevice>,
    /// Providers that failed (e.g. no Bluetooth adapter), as messages.
    pub errors: Vec<String>,
}

#[derive(Default)]
struct Slots {
    trainer: Option<Arc<dyn Trainer>>,
    heart_rate: Option<Arc<dyn HeartRateMonitor>>,
    controller: Option<Arc<dyn Controller>>,
}

struct Inner {
    providers: Vec<Arc<dyn DeviceProvider>>,
    session: Mutex<RideSession>,
    slots: AsyncMutex<Slots>,
    statuses: Mutex<HashMap<DeviceKind, DeviceStatus>>,
    log: Mutex<(u64, VecDeque<LogLine>)>,
    events: EventSender,
    snapshots: watch::Sender<EngineSnapshot>,
    navigator: Mutex<Option<Navigator>>,
    junction: Mutex<Option<Junction>>,
    navigation: Mutex<Option<Navigation>>,
    route_version: AtomicU64,
    /// The rider's FTP in watts, for the time estimate of a planned ride.
    ftp_w: Mutex<f64>,
}

const LOG_LINES: usize = 60;
const KINDS: [DeviceKind; 3] = [DeviceKind::Trainer, DeviceKind::HeartRate, DeviceKind::Controller];

/// Cheap to clone; all clones drive the same ride.
#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

impl Engine {
    /// Builds the providers and starts the event and tick loops on the current Tokio runtime.
    pub fn start(config: EngineConfig) -> Self {
        let mut providers: Vec<Arc<dyn DeviceProvider>> = Vec::new();
        #[cfg(feature = "ble")]
        if config.ble {
            providers.push(Arc::new(wattsup_devices::ble::BleProvider::new(
                config.ble_config.clone(),
            )));
        }
        if config.sim {
            providers.push(Arc::new(SimProvider::new(config.sim_config.clone())));
        }
        Self::with_providers(config.session, providers, config.tick)
    }

    pub fn with_providers(session: SessionConfig, providers: Vec<Arc<dyn DeviceProvider>>, tick: Duration) -> Self {
        let (events, rx) = event_channel();
        let session = RideSession::new(session);
        let statuses = KINDS
            .iter()
            .map(|&kind| {
                (
                    kind,
                    DeviceStatus {
                        kind,
                        id: None,
                        name: None,
                        state: ConnectionState::Disconnected,
                        battery_percent: None,
                    },
                )
            })
            .collect();
        let first = EngineSnapshot {
            session: session.snapshot(),
            devices: vec![],
            providers: providers.iter().map(|p| p.name().to_string()).collect(),
            log: vec![],
            route_version: 0,
            junction: None,
            navigation: None,
        };
        let inner = Arc::new(Inner {
            providers,
            session: Mutex::new(session),
            slots: AsyncMutex::new(Slots::default()),
            statuses: Mutex::new(statuses),
            log: Mutex::new((0, VecDeque::new())),
            events,
            snapshots: watch::channel(first).0,
            navigator: Mutex::new(None),
            junction: Mutex::new(None),
            navigation: Mutex::new(None),
            route_version: AtomicU64::new(0),
            ftp_w: Mutex::new(200.0),
        });
        tokio::spawn(event_loop(inner.clone(), rx));
        tokio::spawn(tick_loop(inner.clone(), tick));
        let engine = Self { inner };
        engine.publish();
        engine
    }

    pub fn subscribe(&self) -> watch::Receiver<EngineSnapshot> {
        self.inner.snapshots.subscribe()
    }

    pub fn snapshot(&self) -> EngineSnapshot {
        self.inner.snapshots.borrow().clone()
    }

    /// The route the session rides, for UIs that draw it.
    pub fn route(&self) -> Option<Route> {
        self.inner.session.lock().unwrap().route().cloned()
    }

    /// All routes shipped with the app.
    pub fn routes(&self) -> Vec<RouteInfo> {
        Route::builtin_list()
    }

    /// Switches to a built-in route and starts a fresh ride on it.
    pub async fn set_route(&self, id: &str) -> Result<(), String> {
        let route = Route::builtin(id).ok_or_else(|| format!("unknown route {id}"))?;
        *self.inner.navigator.lock().unwrap() = None;
        *self.inner.junction.lock().unwrap() = None;
        *self.inner.navigation.lock().unwrap() = None;
        self.inner.session.lock().unwrap().set_route(Some(route));
        self.inner.route_version.fetch_add(1, Ordering::Relaxed);
        self.inner.send_now().await;
        Ok(())
    }

    /// Everything a map needs about a world's road network, without the points.
    pub fn network_info(&self, world: &str) -> Option<NetworkInfo> {
        Network::builtin(world).map(|n| n.info())
    }

    /// The network's points as little-endian f32 x, y, z triples.
    pub fn network_points(&self, world: &str) -> Option<Vec<u8>> {
        Network::builtin(world).map(|n| n.point_bytes())
    }

    /// Starts a free ride on a road network at the road point nearest `(x, z)`,
    /// riding toward the edge's end node if `forward`. The route then grows
    /// ahead of the rider and follows their choices at junctions.
    pub async fn start_on_network(&self, world: &str, x: f64, z: f64, forward: bool) -> Result<(), String> {
        let net = Network::builtin(world).ok_or_else(|| format!("no road network for {world}"))?;
        let (edge, index) = net.nearest(x, z).ok_or("empty network")?;
        let nav = Navigator::start(world, net, edge, index, forward);
        let route = nav.route(net);
        *self.inner.navigator.lock().unwrap() = Some(nav);
        self.inner.session.lock().unwrap().set_route(Some(route));
        self.inner.route_version.fetch_add(1, Ordering::Relaxed);
        self.inner.navigate();
        self.inner.send_now().await;
        Ok(())
    }

    /// How long a route planned on the map would take at the rider's FTP (the same model as
    /// the HUD's time left before a minute of riding): for the planner's summary.
    pub fn plan_time_s(&self, world: &str, legs: &[PlannedLeg]) -> Result<f64, String> {
        let net = Network::builtin(world).ok_or_else(|| format!("no road network for {world}"))?;
        let route = Navigator::planned(world, net, "plan", legs)?.route(net);
        let session = self.inner.session.lock().unwrap();
        let speeds = SpeedTable::new(
            &session.config().rider,
            ETA_FTP_SHARE * *self.inner.ftp_w.lock().unwrap(),
        );
        Ok(route_time_s(&route, 0.0, &speeds).1)
    }

    /// Starts a ride along a route planned on the map: `legs` join end to start and the ride
    /// finishes at the last leg's end.
    pub async fn start_planned_ride(&self, world: &str, name: &str, legs: &[PlannedLeg]) -> Result<(), String> {
        let net = Network::builtin(world).ok_or_else(|| format!("no road network for {world}"))?;
        let nav = Navigator::planned(world, net, name, legs)?;
        let route = nav.route(net);
        *self.inner.navigator.lock().unwrap() = Some(nav);
        self.inner.session.lock().unwrap().set_route(Some(route));
        self.inner.route_version.fetch_add(1, Ordering::Relaxed);
        self.inner.navigate();
        self.inner.send_now().await;
        Ok(())
    }

    /// Takes `edge` at the next junction. Returns false when that is not an option there.
    pub async fn choose_turn(&self, edge: usize) -> bool {
        let changed = {
            let mut nav = self.inner.navigator.lock().unwrap();
            let Some(nav) = nav.as_mut() else { return false };
            let Some(net) = Network::builtin(nav.world()) else {
                return false;
            };
            let distance = self.inner.session.lock().unwrap().snapshot().distance_m;
            if !nav.choose(net, distance, edge) {
                return false;
            }
            let route = nav.route(net);
            self.inner.session.lock().unwrap().replace_route(route);
            true
        };
        if changed {
            self.inner.route_version.fetch_add(1, Ordering::Relaxed);
            self.inner.navigate();
            self.inner.send_now().await;
        }
        changed
    }

    /// Re-plans the road ahead of the rider (from the end of the current leg, `Navigation::leg_end`)
    /// so the ride follows a plan again. The ride itself goes on: distance and stats stay.
    pub async fn replan_ride(&self, world: &str, name: &str, legs: &[PlannedLeg]) -> Result<(), String> {
        {
            let mut nav = self.inner.navigator.lock().unwrap();
            let nav = nav.as_mut().ok_or("not on a road network")?;
            if nav.world() != world {
                return Err(format!("riding {}, not {world}", nav.world()));
            }
            let net = Network::builtin(world).ok_or_else(|| format!("no road network for {world}"))?;
            let distance = self.inner.session.lock().unwrap().snapshot().distance_m;
            nav.replan(net, distance, name, legs)?;
            let route = nav.route(net);
            self.inner.session.lock().unwrap().replace_route(route);
        }
        self.inner.route_version.fetch_add(1, Ordering::Relaxed);
        self.inner.navigate();
        self.inner.send_now().await;
        Ok(())
    }

    /// The rider's body mass: the one figure the physics needs about the body
    /// (gravity on every climb). Bike mass and drag area stay at their defaults.
    pub fn set_rider_mass(&self, kg: f64) {
        self.inner.session.lock().unwrap().set_rider_mass(kg);
        self.inner.navigate();
    }

    /// The rider's FTP, which the time estimate of a planned ride starts from.
    pub fn set_ftp(&self, watts: f64) {
        *self.inner.ftp_w.lock().unwrap() = watts.clamp(50.0, 600.0);
        self.inner.navigate();
    }

    /// Turns the rider around on a road network: the road behind becomes the road ahead.
    /// On a planned route this ends the plan. Returns false when not on a network.
    pub async fn turn_around(&self) -> bool {
        {
            let mut nav = self.inner.navigator.lock().unwrap();
            let Some(nav) = nav.as_mut() else { return false };
            let Some(net) = Network::builtin(nav.world()) else {
                return false;
            };
            let distance = self.inner.session.lock().unwrap().snapshot().distance_m;
            nav.turn_around(net, distance);
            let route = nav.route(net);
            self.inner.session.lock().unwrap().replace_route(route);
        }
        self.inner.route_version.fetch_add(1, Ordering::Relaxed);
        self.inner.navigate();
        self.inner.send_now().await;
        true
    }

    /// The ride so far, for storing it (see [`rides::RideStore`]).
    pub fn ride_report(&self) -> RideReport {
        self.inner.session.lock().unwrap().report()
    }

    pub async fn start_workout(&self, workout: Workout) {
        self.inner.session.lock().unwrap().start_workout(workout);
        self.inner.send_now().await;
    }

    pub async fn stop_workout(&self) {
        self.inner.session.lock().unwrap().stop_workout();
        self.inner.send_now().await;
    }

    /// Makes the running workout `watts` harder or easier from now on.
    pub async fn set_workout_bias(&self, watts: f64) {
        self.inner.session.lock().unwrap().set_workout_bias(watts);
        self.inner.send_now().await;
    }

    /// Jumps to the next step of the running workout.
    pub async fn skip_workout_step(&self) -> bool {
        let skipped = self.inner.session.lock().unwrap().skip_workout_step();
        self.inner.send_now().await;
        skipped
    }

    /// Back to the start of the current route.
    pub async fn reset_ride(&self) {
        self.inner.session.lock().unwrap().reset_ride();
        self.inner.send_now().await;
    }

    /// Scans every provider at once. One failing provider does not hide the others.
    pub async fn scan(&self, duration: Duration) -> ScanResult {
        let scans = self.inner.providers.iter().map(|p| {
            let p = p.clone();
            async move { (p.name(), p.scan(duration).await) }
        });
        let mut result = ScanResult::default();
        for (name, r) in join_all(scans).await {
            match r {
                Ok(mut d) => result.devices.append(&mut d),
                Err(e) => {
                    self.inner.log(name, format!("scan failed: {e}"));
                    result.errors.push(format!("{name}: {e}"));
                }
            }
        }
        result
    }

    /// Connects `id` as the device for `kind`, replacing whatever filled that role.
    pub async fn connect(&self, id: &DeviceId, kind: DeviceKind) -> Result<(), DeviceError> {
        let provider = self
            .inner
            .providers
            .iter()
            .find(|p| p.name() == id.provider())
            .ok_or_else(|| DeviceError::NotFound(id.clone()))?
            .clone();
        self.disconnect(kind).await;
        self.inner
            .set_status(kind, Some(id.clone()), None, ConnectionState::Connecting);
        let events = self.inner.events.clone();
        let mut slots = self.inner.slots.lock().await;
        let result = match kind {
            DeviceKind::Trainer => provider
                .connect_trainer(id, events)
                .await
                .map(|d| slots.trainer = Some(d)),
            DeviceKind::HeartRate => provider
                .connect_heart_rate(id, events)
                .await
                .map(|d| slots.heart_rate = Some(d)),
            DeviceKind::Controller => provider
                .connect_controller(id, events)
                .await
                .map(|d| slots.controller = Some(d)),
        };
        drop(slots);
        if let Err(e) = &result {
            self.inner
                .set_status(kind, Some(id.clone()), None, ConnectionState::Failed(e.to_string()));
            self.inner.log(&kind.to_string(), format!("connect failed: {e}"));
        }
        self.publish();
        result
    }

    pub async fn disconnect(&self, kind: DeviceKind) {
        if kind == DeviceKind::Trainer {
            // Taking the trainer away on purpose is not a dropped link.
            self.inner.session.lock().unwrap().set_trainer_offline(false);
        }
        let mut slots = self.inner.slots.lock().await;
        let device: Option<Arc<dyn wattsup_devices::Device>> = match kind {
            DeviceKind::Trainer => slots.trainer.take().map(|d| d as _),
            DeviceKind::HeartRate => slots.heart_rate.take().map(|d| d as _),
            DeviceKind::Controller => slots.controller.take().map(|d| d as _),
        };
        drop(slots);
        if let Some(d) = device {
            let _ = d.disconnect().await;
            self.inner.set_status(kind, None, None, ConnectionState::Disconnected);
        }
        self.publish();
    }

    pub async fn shift(&self, dir: ShiftDirection) {
        self.inner.shift(dir).await;
    }

    pub async fn set_mode(&self, mode: ControlMode) {
        self.inner.session.lock().unwrap().set_mode(mode);
        self.inner.send_now().await;
    }

    pub async fn set_erg_target(&self, watts: f64) {
        self.inner.session.lock().unwrap().set_erg_target(watts);
        self.inner.send_now().await;
    }

    pub async fn set_road_grade(&self, grade_pct: f64) {
        self.inner.session.lock().unwrap().set_road_grade(grade_pct);
        self.inner.send_now().await;
    }

    /// Automatic shifting toward the target cadence (see [`wattsup_core::session::AutoShift`]).
    pub fn set_auto_shift(&self, enabled: bool) {
        self.inner.session.lock().unwrap().set_auto_shift(enabled);
        self.publish();
    }

    pub fn set_target_cadence(&self, rpm: f64) {
        self.inner.session.lock().unwrap().set_target_cadence(rpm);
        self.publish();
    }

    /// Virtual gears (Zwift Cog style) on or off; off, the trainer gets the road grade as it is.
    pub async fn set_virtual_gearing(&self, on: bool) {
        self.inner.session.lock().unwrap().set_virtual_gearing(on);
        self.inner.send_now().await;
    }

    /// Presses a button on the connected (simulated) controller.
    pub async fn press(&self, button: Button) -> Result<(), DeviceError> {
        let controller = self
            .inner
            .slots
            .lock()
            .await
            .controller
            .clone()
            .ok_or(DeviceError::NotConnected)?;
        controller.inject(button).await
    }

    fn publish(&self) {
        self.inner.publish();
    }
}

impl Inner {
    fn log(&self, source: &str, message: String) {
        let elapsed_s = self.session.lock().unwrap().snapshot().elapsed_s;
        let mut log = self.log.lock().unwrap();
        log.0 += 1;
        let seq = log.0;
        log.1.push_back(LogLine {
            seq,
            elapsed_s,
            source: source.to_string(),
            message,
        });
        while log.1.len() > LOG_LINES {
            log.1.pop_front();
        }
    }

    fn set_status(&self, kind: DeviceKind, id: Option<DeviceId>, name: Option<String>, state: ConnectionState) {
        let mut statuses = self.statuses.lock().unwrap();
        let s = statuses.get_mut(&kind).expect("all kinds present");
        if id.is_some() || matches!(state, ConnectionState::Disconnected) {
            if s.id != id {
                s.battery_percent = None;
            }
            s.id = id;
        }
        if name.is_some() {
            s.name = name;
        }
        s.state = state;
    }

    async fn shift(&self, dir: ShiftDirection) {
        let shifted = self.session.lock().unwrap().shift(dir);
        if shifted {
            self.send_now().await;
        }
    }

    /// Runs a zero-length tick so rider intent reaches the trainer without waiting for the next tick.
    async fn send_now(&self) {
        let cmd = self.session.lock().unwrap().tick(0.0);
        if let Some(cmd) = cmd {
            self.send(cmd).await;
        }
        self.publish();
    }

    async fn send(&self, cmd: wattsup_core::session::TrainerCommand) {
        let trainer = self.slots.lock().await.trainer.clone();
        if let Some(t) = trainer {
            if let Err(e) = t.send(cmd).await {
                self.log("trainer", format!("command not sent: {e}"));
            }
        }
    }

    /// Keeps the planned road ahead of the rider and refreshes the next junction.
    fn navigate(&self) {
        let mut nav = self.navigator.lock().unwrap();
        let Some(nav) = nav.as_mut() else { return };
        let Some(net) = Network::builtin(nav.world()) else {
            return;
        };
        let distance = self.session.lock().unwrap().snapshot().distance_m;
        if nav.keep_ahead(net, distance) {
            let route = nav.route(net);
            self.session.lock().unwrap().replace_route(route);
            self.route_version.fetch_add(1, Ordering::Relaxed);
        }
        *self.junction.lock().unwrap() = nav.junction(net, distance, JUNCTION_LOOKAHEAD_M);
        let planned = nav.is_planned();
        let (remaining_m, remaining_climb_m, eta_s) = if planned {
            let session = self.session.lock().unwrap();
            let snap = session.snapshot();
            let route = session.route().expect("a navigator has a route");
            let length = route.length_m();
            // The rider's own pace once there is one, the FTP guess before.
            let power = match snap.stats.avg_power_w {
                Some(p) if snap.stats.moving_s >= ETA_OWN_POWER_AFTER_S => p,
                _ => ETA_FTP_SHARE * *self.ftp_w.lock().unwrap(),
            };
            let speeds = SpeedTable::new(&session.config().rider, power);
            let (climb, eta) = route_time_s(route, distance, &speeds);
            (Some((length - distance).max(0.0)), Some(climb), Some(eta))
        } else {
            (None, None, None)
        };
        let (edge, index) = nav.current_leg_end(net, distance);
        *self.navigation.lock().unwrap() = Some(Navigation {
            planned,
            remaining_m,
            remaining_climb_m,
            next: nav.next_maneuver(net, distance),
            eta_s,
            leg_end: Some(RoadPoint { edge, index }),
        });
    }

    fn publish(&self) {
        let session = self.session.lock().unwrap().snapshot();
        let devices = {
            let statuses = self.statuses.lock().unwrap();
            KINDS.iter().map(|k| statuses[k].clone()).collect()
        };
        let log = self.log.lock().unwrap().1.iter().cloned().collect();
        let junction = self.junction.lock().unwrap().clone();
        let navigation = self.navigation.lock().unwrap().clone();
        let route_version = self.route_version.load(Ordering::Relaxed);
        self.snapshots.send_modify(|s| {
            s.session = session;
            s.devices = devices;
            s.log = log;
            s.junction = junction;
            s.navigation = navigation;
            s.route_version = route_version;
        });
    }
}

/// Steady speed at one power for every whole-percent grade, so a route's time
/// estimate costs one lookup per point instead of a root search.
struct SpeedTable {
    mps: Vec<f64>,
}

impl SpeedTable {
    const MIN_GRADE: i64 = -25;
    const MAX_GRADE: i64 = 25;

    fn new(rider: &RiderParams, power_w: f64) -> Self {
        let mps = (Self::MIN_GRADE..=Self::MAX_GRADE)
            .map(|g| steady_speed_for_power(rider, power_w, g as f64).max(0.5))
            .collect();
        Self { mps }
    }

    fn at(&self, grade_pct: f64) -> f64 {
        let g = if grade_pct.is_finite() {
            grade_pct.round() as i64
        } else {
            0
        };
        self.mps[(g.clamp(Self::MIN_GRADE, Self::MAX_GRADE) - Self::MIN_GRADE) as usize]
    }
}

/// Climbing and riding time left from `from_m` to the end of `route` at the table's speeds.
fn route_time_s(route: &Route, from_m: f64, speeds: &SpeedTable) -> (f64, f64) {
    let from = ((from_m / 5.0).floor().max(0.0) as usize).min(route.points.len().saturating_sub(1));
    let (mut climb, mut time) = (0.0, 0.0);
    for w in route.points[from..].windows(2) {
        let dy = w[1].y - w[0].y;
        let run = w[1].distance_m - w[0].distance_m;
        climb += dy.max(0.0);
        time += run / speeds.at(dy / run * 100.0);
    }
    (climb, time)
}

async fn event_loop(inner: Arc<Inner>, mut rx: EventReceiver) {
    while let Some(event) = rx.recv().await {
        match event {
            DeviceEvent::Status { kind, id, name, state } => {
                // Ignore late events from a device that no longer fills this role.
                let current = inner.statuses.lock().unwrap()[&kind].id.clone();
                if current.as_ref() == Some(&id) {
                    if let ConnectionState::Reconnecting(why) | ConnectionState::Failed(why) = &state {
                        inner.log(&name, why.clone());
                    }
                    if kind == DeviceKind::Trainer {
                        // A trainer that was connected and dropped holds the ride until it is back.
                        let offline = matches!(state, ConnectionState::Reconnecting(_) | ConnectionState::Failed(_));
                        inner.session.lock().unwrap().set_trainer_offline(offline);
                    }
                    inner.set_status(kind, Some(id), Some(name), state);
                }
            }
            DeviceEvent::Trainer(sample) => inner.session.lock().unwrap().on_trainer_sample(sample),
            DeviceEvent::HeartRate { bpm, .. } => inner.session.lock().unwrap().on_heart_rate(bpm),
            DeviceEvent::Shift(dir) => inner.shift(dir).await,
            DeviceEvent::Button(_) => {}
            DeviceEvent::Battery { kind, percent } => {
                inner
                    .statuses
                    .lock()
                    .unwrap()
                    .get_mut(&kind)
                    .expect("kind")
                    .battery_percent = Some(percent);
            }
            DeviceEvent::Log { kind, message } => inner.log(&kind.to_string(), message),
        }
    }
}

async fn tick_loop(inner: Arc<Inner>, period: Duration) {
    let mut ticker = tokio::time::interval(period);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last = Instant::now();
    loop {
        ticker.tick().await;
        let now = Instant::now();
        let dt = (now - last).as_secs_f64().min(1.0);
        last = now;
        let cmd = inner.session.lock().unwrap().tick(dt);
        if let Some(cmd) = cmd {
            inner.send(cmd).await;
        }
        inner.navigate();
        inner.publish();
    }
}

/// Minimal join_all so the engine needs no extra futures dependency.
async fn join_all<F>(futures: impl IntoIterator<Item = F>) -> Vec<F::Output>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    let handles: Vec<_> = futures.into_iter().map(tokio::spawn).collect();
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        if let Ok(v) = h.await {
            out.push(v);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use wattsup_core::session::TrainerCommand;

    fn sim_engine() -> Engine {
        let sim: Arc<dyn DeviceProvider> = Arc::new(SimProvider::default());
        Engine::with_providers(SessionConfig::default(), vec![sim], Duration::from_millis(250))
    }

    async fn ride(seconds: u64) {
        tokio::time::sleep(Duration::from_secs(seconds)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn simulated_ride_end_to_end() {
        let engine = sim_engine();
        let scan = engine.scan(Duration::from_millis(10)).await;
        assert_eq!(scan.devices.len(), 3);
        assert!(scan.errors.is_empty());
        for d in &scan.devices {
            engine.connect(&d.id, d.kinds[0]).await.unwrap();
        }
        ride(90).await;
        let s = engine.snapshot();
        assert!(
            s.devices.iter().all(|d| d.state == ConnectionState::Connected),
            "{:?}",
            s.devices
        );
        assert!(s.session.power_w.unwrap() > 50.0, "{:?}", s.session.power_w);
        assert!(s.session.cadence_rpm.is_some());
        assert!(
            s.session.heart_rate_bpm.unwrap() > 100.0,
            "{:?}",
            s.session.heart_rate_bpm
        );
        assert!(s.session.virtual_speed_kmh > 15.0);
        assert!(matches!(s.session.last_command, Some(TrainerCommand::Simulation(_))));
        assert_eq!(s.devices[2].battery_percent, Some(87));
    }

    #[tokio::test(start_paused = true)]
    async fn controller_and_keyboard_shift_the_same_gearbox() {
        let engine = sim_engine();
        engine
            .connect(&DeviceId::new("sim", "controller"), DeviceKind::Controller)
            .await
            .unwrap();
        let start = engine.snapshot().session.gear;
        engine.press(Button::ShiftUpRight).await.unwrap();
        ride(1).await;
        assert_eq!(engine.snapshot().session.gear, start + 1);
        engine.shift(ShiftDirection::Down).await;
        engine.shift(ShiftDirection::Down).await;
        assert_eq!(engine.snapshot().session.gear, start - 1);
    }

    #[tokio::test(start_paused = true)]
    async fn erg_mode_drives_the_simulated_trainer() {
        let engine = sim_engine();
        engine
            .connect(&DeviceId::new("sim", "trainer"), DeviceKind::Trainer)
            .await
            .unwrap();
        engine.set_mode(ControlMode::Erg).await;
        engine.set_erg_target(260.0).await;
        ride(30).await;
        let s = engine.snapshot().session;
        assert_eq!(s.last_command, Some(TrainerCommand::TargetPower { watts: 260 }));
        assert!((s.power_w.unwrap() - 260.0).abs() < 15.0, "{:?}", s.power_w);
    }

    #[tokio::test(start_paused = true)]
    async fn rides_the_road_network_and_takes_turns() {
        let engine = sim_engine();
        engine
            .connect(&DeviceId::new("sim", "trainer"), DeviceKind::Trainer)
            .await
            .unwrap();
        // Somewhere on the Ma-10 west of Sóller: the network's nearest road point is used.
        let net = Network::builtin("mallorca").unwrap();
        let ma10 = net
            .edges
            .iter()
            .position(|e| e.road_ref.as_deref() == Some("Ma-10") && e.count > 50)
            .unwrap();
        let p = net.points[net.edges[ma10].start + 10];
        engine
            .start_on_network("mallorca", p[0] as f64, p[2] as f64, true)
            .await
            .unwrap();
        let s = engine.snapshot();
        assert!(s.route_version >= 1);
        let route = engine.route().unwrap();
        assert!(
            route.length_m() > wattsup_core::network::PLAN_AHEAD_M,
            "{}",
            route.length_m()
        );
        assert_eq!(route.world.as_deref(), Some("mallorca"));
        ride(120).await;
        let s = engine.snapshot();
        assert!(s.session.distance_m > 200.0, "{}", s.session.distance_m);
        assert!(!s.session.finished);
        assert_eq!(s.navigation.as_ref().map(|n| n.planned), Some(false));
        // Turn around: the route now doubles back, and the rider rides the same road the other way.
        let here = s.session.distance_m;
        let before = engine.route().unwrap();
        assert!(engine.turn_around().await);
        let after = engine.route().unwrap();
        assert!(after.length_m() > here + 1000.0);
        let back = after.points[((here + 100.0) / 5.0) as usize];
        let there = before.points[((here - 100.0) / 5.0) as usize];
        assert!(
            (back.x - there.x).abs() < 6.0 && (back.z - there.z).abs() < 6.0,
            "{back:?} vs {there:?}"
        );
        ride(30).await;
        assert!(engine.snapshot().session.distance_m > here + 50.0);
        assert!(engine.network_info("mallorca").is_some());
        assert!(engine.network_points("mallorca").unwrap().len() > 100_000);
        assert!(!engine.choose_turn(usize::MAX).await, "nonsense edges are refused");
        engine.set_route("flat").await.unwrap();
        assert!(engine.snapshot().junction.is_none());
        // A planned route: the first 40 points of that Ma-10 edge, and nothing beyond.
        let legs = [PlannedLeg {
            edge: ma10,
            forward: true,
            from: 0,
            to: 40,
        }];
        engine
            .start_planned_ride("mallorca", "a short one", &legs)
            .await
            .unwrap();
        let route = engine.route().unwrap();
        assert_eq!(route.name, "a short one");
        assert!(route.length_m() < 400.0, "{}", route.length_m());
        let plan_s = engine.plan_time_s("mallorca", &legs).unwrap();
        assert!(plan_s > 10.0 && plan_s < 600.0, "{plan_s}");
        assert!(engine.plan_time_s("mallorca", &[]).is_err());
        ride(2).await;
        let nav = engine.snapshot().navigation.expect("navigation on a planned ride");
        assert!(nav.planned);
        assert!(nav.remaining_m.unwrap() > 100.0 && nav.remaining_m.unwrap() <= route.length_m());
        assert!(nav.remaining_climb_m.is_some());
        // The time estimate follows the FTP guess before a minute of riding, then the rider's pace.
        let eta = nav.eta_s.expect("a time estimate");
        assert!(eta > 10.0 && eta < 600.0, "{eta}");
        assert_eq!(
            nav.leg_end,
            Some(RoadPoint {
                edge: ma10,
                index: net.edges[ma10].start + 40
            })
        );
        ride(600).await;
        assert!(
            engine.snapshot().session.finished,
            "the planned ride ends at its destination"
        );
        let report = engine.ride_report();
        assert_eq!(report.route, "a short one");
        assert!(
            report.finished && report.samples.len() > 100,
            "{}",
            report.samples.len()
        );
        assert!(engine.start_planned_ride("mallorca", "x", &[]).await.is_err());
        engine.set_route("flat").await.unwrap();
        assert!(!engine.turn_around().await, "not on a network after set_route");
    }

    #[tokio::test(start_paused = true)]
    async fn disconnect_and_unknown_devices() {
        let engine = sim_engine();
        let id = DeviceId::new("sim", "heart-rate");
        engine.connect(&id, DeviceKind::HeartRate).await.unwrap();
        ride(5).await;
        engine.disconnect(DeviceKind::HeartRate).await;
        ride(5).await;
        let hr = &engine.snapshot().devices[1];
        assert_eq!(hr.state, ConnectionState::Disconnected);
        assert!(engine
            .connect(&DeviceId::new("ble", "nope"), DeviceKind::Trainer)
            .await
            .is_err());
        assert!(engine
            .connect(&DeviceId::new("sim", "nope"), DeviceKind::Trainer)
            .await
            .is_err());
        assert!(matches!(engine.snapshot().devices[0].state, ConnectionState::Failed(_)));
        assert!(engine.press(Button::Plus).await.is_err(), "no controller connected");
    }
}
