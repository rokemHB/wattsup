//! The ride session: all live ride state, changed only through method calls.
//!
//! Device tasks feed measurements in, the UI feeds rider intent in (shift,
//! mode, ERG target, grade), and a periodic [`RideSession::tick`] advances the
//! virtual bike and says what the trainer should be told. No clock, no I/O:
//! time only moves through `tick(dt)`, which keeps it deterministic for
//! tests and, later, for replaying the same inputs on a multiplayer server.

use serde::{Deserialize, Serialize};

use crate::gearing::{implied_ratio, GearSet, Gearbox, ShiftDirection};
use crate::physics::{kmh_to_mps, mps_to_kmh, step_speed, RiderParams};
use crate::protocol::ftms::ControlRequest;
use crate::resistance::{virtual_gear_power, virtual_gear_sim, SimTarget, TrainerProfile};

/// How the trainer's resistance is controlled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlMode {
    /// Free riding: virtual gears + virtual road → FTMS simulation grade.
    Sim,
    /// Fixed target power; the trainer holds it whatever gear or cadence.
    /// Workouts will drive this later. Shifting still changes virtual speed.
    Erg,
}

/// A protocol-neutral instruction for the trainer.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TrainerCommand {
    Simulation(SimTarget),
    TargetPower { watts: i16 },
}

impl TrainerCommand {
    pub fn to_ftms(&self) -> ControlRequest {
        match *self {
            TrainerCommand::Simulation(t) => ControlRequest::SetIndoorBikeSimulation {
                wind_mps: t.wind_mps,
                grade_pct: t.grade_pct,
                crr: t.crr,
                cw_kg_per_m: t.cw_kg_per_m,
            },
            TrainerCommand::TargetPower { watts } => ControlRequest::SetTargetPower(watts),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionConfig {
    pub rider: RiderParams,
    pub trainer: TrainerProfile,
    pub gears: GearSet,
    /// Zero-based starting gear.
    pub start_gear: usize,
    /// Minimum time between trainer commands in steady riding.
    pub command_interval_s: f64,
    /// Re-send the current command this often even if nothing changed, in
    /// case a write was lost.
    pub resend_after_s: f64,
    /// Grade changes smaller than this are not worth a write.
    pub grade_deadband_pct: f64,
    /// Measurements older than this count as missing (device gone quiet).
    pub data_timeout_s: f64,
    pub erg_min_w: f64,
    pub erg_max_w: f64,
}

impl Default for SessionConfig {
    fn default() -> Self {
        let gears = GearSet::default();
        let start_gear = gears.len() / 2 - 1;
        Self {
            rider: RiderParams::default(),
            trainer: TrainerProfile::default(),
            gears,
            start_gear,
            command_interval_s: 0.25,
            resend_after_s: 5.0,
            grade_deadband_pct: 0.1,
            data_timeout_s: 3.0,
            erg_min_w: 0.0,
            erg_max_w: 1500.0,
        }
    }
}

/// One trainer measurement; fields the device did not send stay `None`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TrainerSample {
    pub power_w: Option<f64>,
    pub cadence_rpm: Option<f64>,
    pub speed_kmh: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default)]
struct Reading {
    value: f64,
    at_s: f64,
    valid: bool,
}

impl Reading {
    fn set(&mut self, value: f64, now: f64) {
        *self = Reading {
            value,
            at_s: now,
            valid: true,
        };
    }
    fn fresh(&self, now: f64, timeout: f64) -> Option<f64> {
        (self.valid && now - self.at_s <= timeout).then_some(self.value)
    }
}

/// Everything the debug screen (and later the game and other riders) needs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub elapsed_s: f64,
    pub mode: ControlMode,
    pub erg_target_w: f64,
    pub road_grade_pct: f64,
    /// One-based gear number.
    pub gear: usize,
    pub gear_count: usize,
    pub gear_ratio: f64,
    pub power_w: Option<f64>,
    pub cadence_rpm: Option<f64>,
    pub trainer_speed_kmh: Option<f64>,
    pub heart_rate_bpm: Option<f64>,
    pub virtual_speed_kmh: f64,
    pub distance_m: f64,
    /// Pedal power the virtual road asks for at the current cadence, gear and
    /// grade. In SIM mode the trainer should make the rider produce about this
    /// much; the gap to `power_w` shows how far the [`TrainerProfile`] is off.
    pub model_power_w: f64,
    pub last_command: Option<TrainerCommand>,
    pub last_command_age_s: Option<f64>,
    /// Chainring/cog ratio measured from the trainer's own speed and cadence.
    pub measured_drive_ratio: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct RideSession {
    config: SessionConfig,
    gearbox: Gearbox,
    mode: ControlMode,
    erg_target_w: f64,
    road_grade_pct: f64,
    clock_s: f64,
    power: Reading,
    cadence: Reading,
    trainer_speed: Reading,
    heart_rate: Reading,
    virtual_speed_mps: f64,
    distance_m: f64,
    last_command: Option<TrainerCommand>,
    last_command_at: f64,
    /// Rider intent changed: send at the next tick, skipping the rate limit.
    urgent: bool,
    drive_ratio_estimate: Option<f64>,
}

impl RideSession {
    pub fn new(config: SessionConfig) -> Self {
        let gearbox = Gearbox::new(config.gears.clone(), config.start_gear);
        Self {
            config,
            gearbox,
            mode: ControlMode::Sim,
            erg_target_w: 150.0,
            road_grade_pct: 0.0,
            clock_s: 0.0,
            power: Reading::default(),
            cadence: Reading::default(),
            trainer_speed: Reading::default(),
            heart_rate: Reading::default(),
            virtual_speed_mps: 0.0,
            distance_m: 0.0,
            last_command: None,
            last_command_at: 0.0,
            urgent: true,
            drive_ratio_estimate: None,
        }
    }

    pub fn config(&self) -> &SessionConfig {
        &self.config
    }

    pub fn set_trainer_profile(&mut self, profile: TrainerProfile) {
        self.config.trainer = profile;
        self.urgent = true;
    }

    pub fn on_trainer_sample(&mut self, s: TrainerSample) {
        let now = self.clock_s;
        if let Some(p) = s.power_w {
            self.power.set(p, now);
        }
        if let Some(c) = s.cadence_rpm {
            self.cadence.set(c, now);
        }
        if let Some(v) = s.speed_kmh {
            self.trainer_speed.set(v, now);
        }
    }

    pub fn on_heart_rate(&mut self, bpm: f64) {
        self.heart_rate.set(bpm, self.clock_s);
    }

    /// Shifts one gear. Returns false at the end of the range.
    pub fn shift(&mut self, dir: ShiftDirection) -> bool {
        let changed = self.gearbox.shift(dir);
        self.urgent |= changed;
        changed
    }

    pub fn set_mode(&mut self, mode: ControlMode) {
        if mode != self.mode {
            self.mode = mode;
            self.urgent = true;
        }
    }

    pub fn set_erg_target(&mut self, watts: f64) {
        self.erg_target_w = watts.clamp(self.config.erg_min_w, self.config.erg_max_w).round();
        self.urgent = true;
    }

    /// Sets the virtual road's grade (the game world will drive this later).
    pub fn set_road_grade(&mut self, grade_pct: f64) {
        self.road_grade_pct = grade_pct.clamp(-25.0, 25.0);
        self.urgent = true;
    }

    /// Advances time by `dt` seconds. Returns a command when the trainer needs a new one.
    pub fn tick(&mut self, dt: f64) -> Option<TrainerCommand> {
        self.clock_s += dt;
        let timeout = self.config.data_timeout_s;
        let now = self.clock_s;

        let power = self.power.fresh(now, timeout).unwrap_or(0.0);
        self.virtual_speed_mps = step_speed(
            &self.config.rider,
            self.virtual_speed_mps,
            power,
            self.road_grade_pct,
            dt,
        );
        self.distance_m += self.virtual_speed_mps * dt;

        let cadence = self.cadence.fresh(now, timeout);
        let trainer_speed = self.trainer_speed.fresh(now, timeout).map(kmh_to_mps);
        if let (Some(c), Some(v)) = (cadence, trainer_speed) {
            if c >= 50.0 {
                if let Some(r) = implied_ratio(v, c, self.config.rider.wheel_circumference_m) {
                    let est = self.drive_ratio_estimate.map_or(r, |e| e + 0.05 * (r - e));
                    self.drive_ratio_estimate = Some(est);
                }
            }
        }

        let wanted = self.wanted_command(cadence.unwrap_or(0.0), trainer_speed.unwrap_or(0.0));
        let since = now - self.last_command_at;
        let send = match self.last_command {
            None => true,
            Some(_) if self.urgent => true,
            Some(_) if since >= self.config.resend_after_s => true,
            Some(last) => since >= self.config.command_interval_s && self.differs(&last, &wanted),
        };
        if !send {
            return None;
        }
        self.urgent = false;
        self.last_command = Some(wanted);
        self.last_command_at = now;
        Some(wanted)
    }

    fn wanted_command(&self, cadence: f64, trainer_speed_mps: f64) -> TrainerCommand {
        match self.mode {
            ControlMode::Sim => TrainerCommand::Simulation(virtual_gear_sim(
                &self.config.rider,
                &self.config.trainer,
                cadence,
                self.gearbox.ratio(),
                self.road_grade_pct,
                trainer_speed_mps,
            )),
            ControlMode::Erg => TrainerCommand::TargetPower {
                watts: self.erg_target_w as i16,
            },
        }
    }

    fn differs(&self, a: &TrainerCommand, b: &TrainerCommand) -> bool {
        match (a, b) {
            (TrainerCommand::Simulation(x), TrainerCommand::Simulation(y)) => {
                (x.grade_pct - y.grade_pct).abs() >= self.config.grade_deadband_pct
                    || x.crr != y.crr
                    || x.cw_kg_per_m != y.cw_kg_per_m
            }
            _ => a != b,
        }
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        let now = self.clock_s;
        let t = self.config.data_timeout_s;
        let cadence = self.cadence.fresh(now, t).unwrap_or(0.0);
        let model_power_w = virtual_gear_power(&self.config.rider, cadence, self.gearbox.ratio(), self.road_grade_pct);
        SessionSnapshot {
            elapsed_s: now,
            mode: self.mode,
            erg_target_w: self.erg_target_w,
            road_grade_pct: self.road_grade_pct,
            gear: self.gearbox.gear_number(),
            gear_count: self.gearbox.set().len(),
            gear_ratio: self.gearbox.ratio(),
            power_w: self.power.fresh(now, t),
            cadence_rpm: self.cadence.fresh(now, t),
            trainer_speed_kmh: self.trainer_speed.fresh(now, t),
            heart_rate_bpm: self.heart_rate.fresh(now, t),
            virtual_speed_kmh: mps_to_kmh(self.virtual_speed_mps),
            distance_m: self.distance_m,
            model_power_w,
            last_command: self.last_command,
            last_command_age_s: self.last_command.map(|_| now - self.last_command_at),
            measured_drive_ratio: self.drive_ratio_estimate,
        }
    }
}

impl Default for RideSession {
    fn default() -> Self {
        Self::new(SessionConfig::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gearing::wheel_speed_mps;

    fn riding(session: &mut RideSession, power: f64, cadence: f64) {
        let speed = mps_to_kmh(wheel_speed_mps(cadence, 34.0 / 14.0, 2.105));
        session.on_trainer_sample(TrainerSample {
            power_w: Some(power),
            cadence_rpm: Some(cadence),
            speed_kmh: Some(speed),
        });
    }

    fn grade(cmd: Option<TrainerCommand>) -> f64 {
        match cmd {
            Some(TrainerCommand::Simulation(t)) => t.grade_pct,
            other => panic!("expected a simulation command, got {other:?}"),
        }
    }

    #[test]
    fn first_tick_always_sends() {
        let mut s = RideSession::default();
        assert!(s.tick(0.25).is_some());
        assert!(s.tick(0.25).is_none(), "nothing changed");
    }

    #[test]
    fn shifting_sends_immediately_and_changes_resistance() {
        let mut s = RideSession::default();
        riding(&mut s, 200.0, 90.0);
        let base = grade(s.tick(0.25));
        assert!(s.shift(ShiftDirection::Up));
        let harder = grade(s.tick(0.01));
        assert!(harder > base, "{harder} > {base}");
        s.shift(ShiftDirection::Down);
        s.shift(ShiftDirection::Down);
        let easier = grade(s.tick(0.01));
        assert!(easier < base);
        assert_eq!(s.snapshot().gear, 11);
    }

    #[test]
    fn steady_riding_is_rate_limited_and_deadbanded() {
        let mut s = RideSession::default();
        riding(&mut s, 200.0, 90.0);
        assert!(s.tick(0.25).is_some());
        let mut sent = 0;
        for _ in 0..16 {
            riding(&mut s, 200.0, 90.0);
            sent += s.tick(0.25).is_some() as usize;
        }
        assert_eq!(sent, 0, "same cadence, same gear, under the 5 s resend: no writes");
        // A big cadence change moves the grade past the deadband, but not faster than the interval.
        riding(&mut s, 200.0, 110.0);
        assert!(s.tick(0.1).is_some());
        riding(&mut s, 200.0, 60.0);
        assert!(s.tick(0.1).is_none(), "inside the 0.25 s interval");
        assert!(s.tick(0.2).is_some());
    }

    #[test]
    fn resends_after_quiet_period() {
        let mut s = RideSession::default();
        s.tick(0.25);
        let mut sent = 0;
        for _ in 0..21 {
            sent += s.tick(0.25).is_some() as usize;
        }
        assert_eq!(sent, 1);
    }

    #[test]
    fn erg_mode_sends_target_power_and_ignores_gears() {
        let mut s = RideSession::default();
        s.tick(0.25);
        s.set_mode(ControlMode::Erg);
        s.set_erg_target(222.4);
        assert_eq!(s.tick(0.25), Some(TrainerCommand::TargetPower { watts: 222 }));
        s.shift(ShiftDirection::Up);
        assert_eq!(
            s.tick(0.25),
            Some(TrainerCommand::TargetPower { watts: 222 }),
            "shift is still sent promptly"
        );
        assert_eq!(s.tick(0.25), None);
        s.set_erg_target(5000.0);
        assert_eq!(s.tick(0.25), Some(TrainerCommand::TargetPower { watts: 1500 }));
        s.set_mode(ControlMode::Sim);
        assert!(matches!(s.tick(0.25), Some(TrainerCommand::Simulation(_))));
    }

    #[test]
    fn virtual_bike_moves_with_power_and_stops_without_data() {
        let mut s = RideSession::default();
        for _ in 0..(60 * 4) {
            riding(&mut s, 200.0, 90.0);
            s.tick(0.25);
        }
        let snap = s.snapshot();
        assert!(
            snap.virtual_speed_kmh > 25.0 && snap.virtual_speed_kmh < 40.0,
            "{}",
            snap.virtual_speed_kmh
        );
        assert!(snap.distance_m > 300.0);
        // Trainer goes quiet: readings expire and the bike coasts down.
        for _ in 0..(120 * 4) {
            s.tick(0.25);
        }
        let snap = s.snapshot();
        assert_eq!(snap.power_w, None);
        assert_eq!(snap.cadence_rpm, None);
        assert!(snap.virtual_speed_kmh < 12.0, "{}", snap.virtual_speed_kmh);
    }

    #[test]
    fn climbing_road_slows_the_bike() {
        let mut flat = RideSession::default();
        let mut hill = RideSession::default();
        hill.set_road_grade(6.0);
        for _ in 0..(90 * 4) {
            riding(&mut flat, 220.0, 85.0);
            riding(&mut hill, 220.0, 85.0);
            flat.tick(0.25);
            hill.tick(0.25);
        }
        assert!(hill.snapshot().virtual_speed_kmh < flat.snapshot().virtual_speed_kmh * 0.6);
    }

    #[test]
    fn measures_the_trainer_drive_ratio() {
        let mut s = RideSession::default();
        for _ in 0..200 {
            riding(&mut s, 180.0, 88.0);
            s.tick(0.25);
        }
        let r = s.snapshot().measured_drive_ratio.unwrap();
        assert!((r - 34.0 / 14.0).abs() < 0.01, "{r}");
    }

    #[test]
    fn model_power_follows_cadence_gear_and_grade() {
        let mut s = RideSession::default();
        assert_eq!(s.snapshot().model_power_w, 0.0, "not pedalling");
        riding(&mut s, 200.0, 90.0);
        s.tick(0.25);
        let flat = s.snapshot().model_power_w;
        assert!(flat > 40.0 && flat < 200.0, "{flat}");
        s.shift(ShiftDirection::Up);
        let harder = s.snapshot().model_power_w;
        assert!(harder > flat, "{harder} > {flat}");
        s.set_road_grade(5.0);
        assert!(s.snapshot().model_power_w > harder);
        for _ in 0..13 {
            s.tick(0.25);
        }
        assert_eq!(s.snapshot().model_power_w, 0.0, "cadence expired");
    }

    #[test]
    fn heart_rate_expires() {
        let mut s = RideSession::default();
        s.on_heart_rate(130.0);
        assert_eq!(s.snapshot().heart_rate_bpm, Some(130.0));
        for _ in 0..13 {
            s.tick(0.25);
        }
        assert_eq!(s.snapshot().heart_rate_bpm, None);
    }

    #[test]
    fn snapshot_serializes_for_the_frontend() {
        let mut s = RideSession::default();
        s.tick(0.25);
        let json = serde_json::to_string(&s.snapshot()).unwrap();
        assert!(json.contains("\"mode\":\"sim\""), "{json}");
        assert!(json.contains("\"type\":\"simulation\""), "{json}");
        assert!(json.contains("\"gear\":12"), "{json}");
    }

    #[test]
    fn commands_map_to_ftms() {
        let cmd = TrainerCommand::TargetPower { watts: 250 };
        assert_eq!(cmd.to_ftms().encode(), vec![0x05, 0xfa, 0x00]);
    }
}
