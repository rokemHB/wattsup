//! The ride engine: owns the device providers, the connected devices and the
//! [`RideSession`], and runs the event and tick loops between them.
//!
//! UIs (the Tauri app, the CLI) call methods and watch [`EngineSnapshot`]s;
//! they never talk to devices directly. A future multiplayer client would
//! subscribe here as well, publishing snapshots and receiving other riders'.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{watch, Mutex as AsyncMutex};
use tokio::time::Instant;
use wattsup_core::gearing::ShiftDirection;
use wattsup_core::protocol::zwift::Button;
use wattsup_core::route::{Route, RouteInfo};
use wattsup_core::session::{ControlMode, RideSession, SessionConfig, SessionSnapshot};
use wattsup_devices::sim::{SimConfig, SimProvider};
use wattsup_devices::{
    event_channel, ConnectionState, Controller, DeviceError, DeviceEvent, DeviceId, DeviceKind, DeviceProvider,
    DiscoveredDevice, EventReceiver, EventSender, HeartRateMonitor, Trainer,
};

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
}

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
        };
        let inner = Arc::new(Inner {
            providers,
            session: Mutex::new(session),
            slots: AsyncMutex::new(Slots::default()),
            statuses: Mutex::new(statuses),
            log: Mutex::new((0, VecDeque::new())),
            events,
            snapshots: watch::channel(first).0,
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
        self.inner.session.lock().unwrap().set_route(Some(route));
        self.inner.send_now().await;
        Ok(())
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

    fn publish(&self) {
        let session = self.session.lock().unwrap().snapshot();
        let devices = {
            let statuses = self.statuses.lock().unwrap();
            KINDS.iter().map(|k| statuses[k].clone()).collect()
        };
        let log = self.log.lock().unwrap().1.iter().cloned().collect();
        self.snapshots.send_modify(|s| {
            s.session = session;
            s.devices = devices;
            s.log = log;
        });
    }
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
