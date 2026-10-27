use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use wattsup_core::gearing::wheel_speed_mps;
use wattsup_core::physics::{gravity_rolling_force, mps_to_kmh};
use wattsup_core::resistance::TrainerProfile;
use wattsup_core::session::{TrainerCommand, TrainerSample};

use super::{approach, status, Rng, SimConfig, SimWorld};
use crate::{ConnectionState, Device, DeviceEvent, DeviceId, DeviceKind, EventSender, Result, Trainer};

/// The simulated person on the bike.
#[derive(Clone, Debug)]
pub struct SimRider {
    /// Average power they are willing to put out in SIM mode.
    pub base_effort_w: f64,
    /// How far effort wanders around the base (slow surges and easing off).
    pub effort_swing_w: f64,
    pub preferred_cadence_rpm: f64,
    pub min_cadence_rpm: f64,
    pub max_cadence_rpm: f64,
    /// The physical trainer: drive ratio over the Cog and the mass its SIM model uses.
    pub trainer: TrainerProfile,
    pub wheel_circumference_m: f64,
}

impl Default for SimRider {
    fn default() -> Self {
        Self {
            base_effort_w: 190.0,
            effort_swing_w: 50.0,
            preferred_cadence_rpm: 88.0,
            min_cadence_rpm: 55.0,
            max_cadence_rpm: 115.0,
            trainer: TrainerProfile::default(),
            wheel_circumference_m: 2.105,
        }
    }
}

/// Rider + trainer physics, advanced in fixed steps. Separate from the task so it is testable.
#[derive(Clone, Debug)]
pub(crate) struct TrainerModel {
    rider: SimRider,
    rng: Rng,
    command: Option<TrainerCommand>,
    effort_w: f64,
    effort_target_w: f64,
    /// ERG power before measurement noise.
    erg_power_w: f64,
    pub cadence_rpm: f64,
    pub power_w: f64,
}

impl TrainerModel {
    pub fn new(rider: SimRider, seed: u64) -> Self {
        let effort = rider.base_effort_w;
        let cadence = rider.preferred_cadence_rpm;
        Self {
            rider,
            rng: Rng::new(seed),
            command: None,
            effort_w: effort,
            effort_target_w: effort,
            erg_power_w: 0.0,
            cadence_rpm: cadence,
            power_w: 0.0,
        }
    }

    pub fn command(&mut self, cmd: TrainerCommand) {
        self.command = Some(cmd);
    }

    /// Resistance at the flywheel for the current command, at trainer speed `v`.
    fn trainer_force(&self, v: f64) -> f64 {
        let t = &self.rider.trainer;
        let (grade, crr, cw) = match self.command {
            Some(TrainerCommand::Simulation(s)) => (s.grade_pct, s.crr, s.cw_kg_per_m),
            // Before any command a trainer free-wheels at its "level" baseline.
            _ => (0.0, t.sim_crr, 0.0),
        };
        // A real brake can't push the flywheel, so there is always some drag.
        (gravity_rolling_force(t.assumed_mass_kg, grade, crr) + cw * v * v).max(2.0)
    }

    fn speed_for(&self, cadence: f64) -> f64 {
        wheel_speed_mps(
            cadence,
            self.rider.trainer.drive_ratio,
            self.rider.wheel_circumference_m,
        )
    }

    pub fn step(&mut self, dt: f64) {
        // Effort wanders: pick a new target now and then, drift toward it.
        if self.rng.next_f64() < dt / 20.0 {
            self.effort_target_w = self.rider.base_effort_w + self.rider.effort_swing_w * self.rng.symmetric();
        }
        self.effort_w = approach(self.effort_w, self.effort_target_w, dt, 8.0);
        let jitter = 1.0 + 0.03 * self.rng.symmetric();

        match self.command {
            Some(TrainerCommand::TargetPower { watts }) => {
                // ERG: the brake makes any cadence cost `watts`; the rider spins as they like.
                self.cadence_rpm = approach(self.cadence_rpm, self.rider.preferred_cadence_rpm, dt, 3.0);
                self.erg_power_w = approach(self.erg_power_w, watts.max(0) as f64, dt, 1.5);
                self.power_w = self.erg_power_w * jitter;
            }
            _ => {
                // SIM: the rider picks the cadence that turns their effort into the
                // resistance they feel, within what their legs can do.
                let force = self.trainer_force(self.speed_for(self.cadence_rpm));
                let per_rpm = self.speed_for(1.0);
                let wanted = self.effort_w / (force * per_rpm);
                let wanted = wanted.clamp(self.rider.min_cadence_rpm, self.rider.max_cadence_rpm);
                self.cadence_rpm = approach(self.cadence_rpm, wanted, dt, 1.5);
                let v = self.speed_for(self.cadence_rpm);
                self.power_w = (self.trainer_force(v) * v * jitter).max(0.0);
                self.erg_power_w = self.power_w;
            }
        }
    }

    pub fn sample(&self) -> TrainerSample {
        TrainerSample {
            power_w: Some(self.power_w.round()),
            // FTMS cadence has 0.5 rpm resolution.
            cadence_rpm: Some((self.cadence_rpm * 2.0).round() / 2.0),
            speed_kmh: Some((mps_to_kmh(self.speed_for(self.cadence_rpm)) * 100.0).round() / 100.0),
        }
    }
}

pub struct SimTrainer {
    id: DeviceId,
    events: EventSender,
    commands: watch::Sender<Option<TrainerCommand>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

const NAME: &str = "Simulated trainer";

impl SimTrainer {
    pub(crate) fn start(id: DeviceId, config: &SimConfig, world: Arc<Mutex<SimWorld>>, events: EventSender) -> Self {
        let (commands, mut rx) = watch::channel(None);
        let mut model = TrainerModel::new(config.rider.clone(), config.seed);
        let interval = config.trainer_interval;
        let tx = events.clone();
        status(&events, DeviceKind::Trainer, &id, NAME, ConnectionState::Connected);
        let task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            loop {
                ticker.tick().await;
                if rx.has_changed().unwrap_or(false) {
                    if let Some(cmd) = *rx.borrow_and_update() {
                        model.command(cmd);
                    }
                }
                model.step(interval.as_secs_f64());
                world.lock().unwrap().power_w = model.power_w;
                if tx.send(DeviceEvent::Trainer(model.sample())).is_err() {
                    break;
                }
            }
        });
        Self {
            id,
            events,
            commands,
            task: Mutex::new(Some(task)),
        }
    }
}

#[async_trait]
impl Device for SimTrainer {
    fn id(&self) -> &DeviceId {
        &self.id
    }
    fn name(&self) -> &str {
        NAME
    }
    fn kind(&self) -> DeviceKind {
        DeviceKind::Trainer
    }
    async fn disconnect(&self) -> Result<()> {
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
            status(
                &self.events,
                DeviceKind::Trainer,
                &self.id,
                NAME,
                ConnectionState::Disconnected,
            );
        }
        Ok(())
    }
}

#[async_trait]
impl Trainer for SimTrainer {
    async fn send(&self, command: TrainerCommand) -> Result<()> {
        let _ = self.commands.send(Some(command));
        Ok(())
    }
}

impl Drop for SimTrainer {
    fn drop(&mut self) {
        if let Some(task) = self.task.get_mut().unwrap().take() {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wattsup_core::resistance::SimTarget;

    fn sim(grade_pct: f64) -> TrainerCommand {
        TrainerCommand::Simulation(SimTarget {
            grade_pct,
            crr: 0.004,
            cw_kg_per_m: 0.0,
            wind_mps: 0.0,
            desired_grade_pct: grade_pct,
            clamped: None,
        })
    }

    fn run(model: &mut TrainerModel, seconds: f64) -> (f64, f64) {
        let steps = (seconds / 0.25) as usize;
        let (mut p, mut c) = (0.0, 0.0);
        for _ in 0..steps {
            model.step(0.25);
            p += model.power_w;
            c += model.cadence_rpm;
        }
        (p / steps as f64, c / steps as f64)
    }

    fn steady_rider() -> SimRider {
        SimRider {
            effort_swing_w: 0.0,
            ..SimRider::default()
        }
    }

    #[test]
    fn erg_holds_target_power() {
        let mut m = TrainerModel::new(steady_rider(), 1);
        m.command(TrainerCommand::TargetPower { watts: 250 });
        run(&mut m, 15.0);
        let (p, c) = run(&mut m, 30.0);
        assert!((p - 250.0).abs() < 5.0, "{p}");
        assert!((c - 88.0).abs() < 1.0, "{c}");
    }

    #[test]
    fn steeper_grade_drops_cadence_at_same_effort() {
        let mut easy = TrainerModel::new(steady_rider(), 2);
        let mut hard = TrainerModel::new(steady_rider(), 2);
        easy.command(sim(2.5));
        hard.command(sim(4.0));
        run(&mut easy, 20.0);
        run(&mut hard, 20.0);
        let (pe, ce) = run(&mut easy, 30.0);
        let (ph, ch) = run(&mut hard, 30.0);
        assert!(ch < ce - 10.0, "cadence {ch} vs {ce}");
        assert!(
            (pe - 190.0).abs() < 15.0 && (ph - 190.0).abs() < 15.0,
            "power {pe} / {ph}"
        );
    }

    #[test]
    fn too_little_resistance_spins_out_and_power_falls() {
        let mut m = TrainerModel::new(steady_rider(), 3);
        m.command(sim(-8.0));
        run(&mut m, 20.0);
        let (p, c) = run(&mut m, 20.0);
        assert!((c - 115.0).abs() < 1.0, "{c}");
        assert!(p < 100.0, "{p}");
    }

    #[test]
    fn samples_use_ftms_resolutions() {
        let mut m = TrainerModel::new(SimRider::default(), 4);
        run(&mut m, 5.0);
        let s = m.sample();
        let c = s.cadence_rpm.unwrap();
        assert_eq!(c * 2.0, (c * 2.0).round());
        assert_eq!(s.power_w.unwrap(), s.power_w.unwrap().round());
    }

    #[tokio::test(start_paused = true)]
    async fn device_reacts_to_commands_through_the_trait() {
        let (tx, mut rx) = crate::event_channel();
        let world = Arc::new(Mutex::new(SimWorld::default()));
        let config = SimConfig {
            rider: steady_rider(),
            ..SimConfig::default()
        };
        let t = SimTrainer::start(DeviceId::new("sim", "trainer"), &config, world.clone(), tx);
        t.send(TrainerCommand::TargetPower { watts: 300 }).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        let mut last = None;
        while let Ok(ev) = rx.try_recv() {
            if let DeviceEvent::Trainer(s) = ev {
                last = s.power_w;
            }
        }
        assert!((last.unwrap() - 300.0).abs() < 12.0, "{last:?}");
        assert!((world.lock().unwrap().power_w - 300.0).abs() < 12.0);
        t.disconnect().await.unwrap();
        tokio::task::yield_now().await;
        assert!(matches!(
            rx.try_recv(),
            Ok(DeviceEvent::Status {
                state: ConnectionState::Disconnected,
                ..
            })
        ));
    }
}
