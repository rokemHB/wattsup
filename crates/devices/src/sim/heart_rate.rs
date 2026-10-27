use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::task::JoinHandle;

use super::{approach, status, Rng, SimConfig, SimWorld};
use crate::{ConnectionState, Device, DeviceEvent, DeviceId, DeviceKind, EventSender, HeartRateMonitor, Result};

/// Heart-rate response to effort: a steady-state target from power, reached
/// with a lag (faster going up than coming down), plus slow cardiac drift
/// during sustained work and beat-to-beat noise.
#[derive(Clone, Debug)]
pub(crate) struct HeartModel {
    pub resting_bpm: f64,
    pub max_bpm: f64,
    /// Power at which heart rate settles around 90% of max.
    pub threshold_w: f64,
    pub bpm: f64,
    drift_bpm: f64,
    rng: Rng,
}

impl HeartModel {
    pub fn new(seed: u64) -> Self {
        Self {
            resting_bpm: 62.0,
            max_bpm: 188.0,
            threshold_w: 250.0,
            bpm: 62.0,
            drift_bpm: 0.0,
            rng: Rng::new(seed ^ 0x4842),
        }
    }

    pub fn target(&self, power_w: f64) -> f64 {
        let reserve = self.max_bpm - self.resting_bpm;
        let fraction = (power_w.max(0.0) / self.threshold_w * 0.85).min(1.0);
        self.resting_bpm + reserve * fraction + self.drift_bpm
    }

    pub fn step(&mut self, power_w: f64, dt: f64) {
        // Drift creeps up ~0.3 bpm/min while working hard, recovers when easy.
        if power_w > 0.6 * self.threshold_w {
            self.drift_bpm = (self.drift_bpm + 0.3 / 60.0 * dt).min(12.0);
        } else {
            self.drift_bpm = approach(self.drift_bpm, 0.0, dt, 120.0);
        }
        let target = self.target(power_w).min(self.max_bpm);
        let tau = if target > self.bpm { 25.0 } else { 45.0 };
        self.bpm = approach(self.bpm, target, dt, tau);
    }

    pub fn reading(&mut self) -> (f64, Vec<f64>) {
        let bpm = (self.bpm + 0.8 * self.rng.symmetric()).round();
        let rr = 60_000.0 / bpm.max(30.0);
        (bpm, vec![(rr * 1024.0 / 1000.0).round() * 1000.0 / 1024.0])
    }
}

pub struct SimHeartRate {
    id: DeviceId,
    events: EventSender,
    task: Mutex<Option<JoinHandle<()>>>,
}

const NAME: &str = "Simulated heart rate";

impl SimHeartRate {
    pub(crate) fn start(id: DeviceId, config: &SimConfig, world: Arc<Mutex<SimWorld>>, events: EventSender) -> Self {
        let mut model = HeartModel::new(config.seed);
        let interval = config.heart_rate_interval;
        let tx = events.clone();
        status(&events, DeviceKind::HeartRate, &id, NAME, ConnectionState::Connected);
        let task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            loop {
                ticker.tick().await;
                let power = world.lock().unwrap().power_w;
                model.step(power, interval.as_secs_f64());
                let (bpm, rr_intervals_ms) = model.reading();
                if tx.send(DeviceEvent::HeartRate { bpm, rr_intervals_ms }).is_err() {
                    break;
                }
            }
        });
        Self {
            id,
            events,
            task: Mutex::new(Some(task)),
        }
    }
}

#[async_trait]
impl Device for SimHeartRate {
    fn id(&self) -> &DeviceId {
        &self.id
    }
    fn name(&self) -> &str {
        NAME
    }
    fn kind(&self) -> DeviceKind {
        DeviceKind::HeartRate
    }
    async fn disconnect(&self) -> Result<()> {
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
            status(
                &self.events,
                DeviceKind::HeartRate,
                &self.id,
                NAME,
                ConnectionState::Disconnected,
            );
        }
        Ok(())
    }
}

impl HeartRateMonitor for SimHeartRate {}

impl Drop for SimHeartRate {
    fn drop(&mut self) {
        if let Some(task) = self.task.get_mut().unwrap().take() {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ride(m: &mut HeartModel, power: f64, seconds: usize) {
        for _ in 0..seconds {
            m.step(power, 1.0);
        }
    }

    #[test]
    fn rises_with_effort_and_lags() {
        let mut m = HeartModel::new(1);
        ride(&mut m, 200.0, 10);
        let early = m.bpm;
        ride(&mut m, 200.0, 170);
        let settled = m.bpm;
        assert!(early < settled - 20.0, "lag: {early} then {settled}");
        assert!(settled > 140.0 && settled < 160.0, "{settled}");
    }

    #[test]
    fn harder_means_higher_and_never_above_max() {
        let mut easy = HeartModel::new(1);
        let mut hard = HeartModel::new(1);
        ride(&mut easy, 120.0, 300);
        ride(&mut hard, 400.0, 3600);
        assert!(hard.bpm > easy.bpm + 30.0);
        assert!(hard.bpm <= hard.max_bpm);
    }

    #[test]
    fn drifts_up_during_long_efforts_and_recovers() {
        let mut m = HeartModel::new(1);
        ride(&mut m, 220.0, 300);
        let at5 = m.bpm;
        ride(&mut m, 220.0, 1500);
        assert!(m.bpm > at5 + 4.0, "drift {at5} -> {}", m.bpm);
        ride(&mut m, 0.0, 900);
        assert!(m.bpm < 70.0, "recovery {}", m.bpm);
    }

    #[test]
    fn readings_are_whole_bpm_with_matching_rr() {
        let mut m = HeartModel::new(9);
        ride(&mut m, 180.0, 120);
        let (bpm, rr) = m.reading();
        assert_eq!(bpm, bpm.round());
        assert!((60_000.0 / rr[0] - bpm).abs() < 0.5);
    }
}
