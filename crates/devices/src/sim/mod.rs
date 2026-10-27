//! Simulated devices that behave like the real ones.
//!
//! One [`SimWorld`] is shared by the three simulators so they stay
//! consistent: the trainer's rider model decides power, and the heart rate
//! follows that power. The trainer reacts to the same [`TrainerCommand`]s a
//! real KICKR gets, so virtual gearing can be exercised end to end.
//!
//! [`TrainerCommand`]: wattsup_core::session::TrainerCommand

mod controller;
mod heart_rate;
mod trainer;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;

pub use controller::SimController;
pub use heart_rate::SimHeartRate;
pub use trainer::{SimRider, SimTrainer};

use crate::{
    Controller, DeviceError, DeviceId, DeviceKind, DeviceProvider, DiscoveredDevice, EventSender, HeartRateMonitor,
    Result, Trainer,
};

pub const PROVIDER: &str = "sim";

/// Simulation settings. The defaults model a fit amateur on a 34×14 Zwift Cog setup.
#[derive(Clone, Debug)]
pub struct SimConfig {
    pub rider: SimRider,
    /// Rate of trainer data notifications (a KICKR sends about 4 per second).
    pub trainer_interval: Duration,
    pub heart_rate_interval: Duration,
    pub seed: u64,
}

impl Default for SimConfig {
    fn default() -> Self {
        Self {
            rider: SimRider::default(),
            trainer_interval: Duration::from_millis(250),
            heart_rate_interval: Duration::from_secs(1),
            seed: 0x5EED_CAFE,
        }
    }
}

/// State shared between the simulated devices.
#[derive(Debug, Default)]
pub struct SimWorld {
    /// Latest power the simulated rider produced, in watts.
    pub power_w: f64,
}

pub struct SimProvider {
    config: SimConfig,
    world: Arc<Mutex<SimWorld>>,
}

impl SimProvider {
    pub fn new(config: SimConfig) -> Self {
        Self {
            config,
            world: Arc::new(Mutex::new(SimWorld::default())),
        }
    }

    pub fn world(&self) -> Arc<Mutex<SimWorld>> {
        self.world.clone()
    }

    fn id(kind: DeviceKind) -> DeviceId {
        DeviceId::new(
            PROVIDER,
            match kind {
                DeviceKind::Trainer => "trainer",
                DeviceKind::HeartRate => "heart-rate",
                DeviceKind::Controller => "controller",
            },
        )
    }

    fn check(id: &DeviceId, kind: DeviceKind) -> Result<()> {
        if *id == Self::id(kind) {
            Ok(())
        } else {
            Err(DeviceError::NotFound(id.clone()))
        }
    }
}

impl Default for SimProvider {
    fn default() -> Self {
        Self::new(SimConfig::default())
    }
}

#[async_trait]
impl DeviceProvider for SimProvider {
    fn name(&self) -> &'static str {
        PROVIDER
    }

    async fn scan(&self, _duration: Duration) -> Result<Vec<DiscoveredDevice>> {
        let dev = |kind, name: &str| DiscoveredDevice {
            id: Self::id(kind),
            name: name.into(),
            kinds: vec![kind],
            rssi: None,
            simulated: true,
        };
        Ok(vec![
            dev(DeviceKind::Trainer, "Simulated trainer"),
            dev(DeviceKind::HeartRate, "Simulated heart rate"),
            dev(DeviceKind::Controller, "Simulated controller"),
        ])
    }

    async fn connect_trainer(&self, id: &DeviceId, events: EventSender) -> Result<Arc<dyn Trainer>> {
        Self::check(id, DeviceKind::Trainer)?;
        Ok(Arc::new(SimTrainer::start(
            id.clone(),
            &self.config,
            self.world.clone(),
            events,
        )))
    }

    async fn connect_heart_rate(&self, id: &DeviceId, events: EventSender) -> Result<Arc<dyn HeartRateMonitor>> {
        Self::check(id, DeviceKind::HeartRate)?;
        Ok(Arc::new(SimHeartRate::start(
            id.clone(),
            &self.config,
            self.world.clone(),
            events,
        )))
    }

    async fn connect_controller(&self, id: &DeviceId, events: EventSender) -> Result<Arc<dyn Controller>> {
        Self::check(id, DeviceKind::Controller)?;
        Ok(Arc::new(SimController::start(id.clone(), events)))
    }
}

/// Small deterministic PRNG (xorshift64*), so runs and tests are repeatable.
#[derive(Clone, Debug)]
pub(crate) struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    /// Uniform in [0, 1).
    pub fn next_f64(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Uniform in [-1, 1).
    pub fn symmetric(&mut self) -> f64 {
        self.next_f64() * 2.0 - 1.0
    }
}

/// Moves `value` toward `target` with time constant `tau` seconds.
pub(crate) fn approach(value: f64, target: f64, dt: f64, tau: f64) -> f64 {
    value + (target - value) * (1.0 - (-dt / tau).exp())
}

/// Emits the status event every simulator sends on connect / disconnect.
pub(crate) fn status(events: &EventSender, kind: DeviceKind, id: &DeviceId, name: &str, state: crate::ConnectionState) {
    let _ = events.send(crate::DeviceEvent::Status {
        kind,
        id: id.clone(),
        name: name.into(),
        state,
    });
}
