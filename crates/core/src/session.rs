//! The ride session: all live ride state, changed only through method calls.
//!
//! Device tasks feed measurements in, the UI feeds rider intent in (shift,
//! mode, ERG target, grade), and a periodic [`RideSession::tick`] advances the
//! virtual bike and says what the trainer should be told. No clock, no I/O:
//! time only moves through `tick(dt)`, which keeps it deterministic for
//! tests and, later, for replaying the same inputs on a multiplayer server.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::gearing::{implied_ratio, GearSet, Gearbox, ShiftDirection};
use crate::physics::{kmh_to_mps, mps_to_kmh, step_speed, RiderParams};
use crate::protocol::ftms::ControlRequest;
use crate::ramp::{RampResult, RampTracker};
use crate::resistance::{virtual_gear_power, virtual_gear_sim, SimTarget, TrainerProfile};
use crate::route::{flight_speed_mps, Route};

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
    /// The road the rider moves along. Its grade overrides [`RideSession::set_road_grade`].
    pub route: Option<Route>,
    /// Zero-based starting gear.
    pub start_gear: usize,
    /// Distance already ridden at the start, to begin part-way along a route.
    pub start_distance_m: f64,
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
            route: None,
            start_gear,
            start_distance_m: 0.0,
            command_interval_s: 0.25,
            resend_after_s: 5.0,
            grade_deadband_pct: 0.1,
            data_timeout_s: 3.0,
            erg_min_w: 0.0,
            erg_max_w: 1500.0,
        }
    }
}

/// Shifts virtual gears to keep the rider's cadence near a target.
///
/// Works for any rider, real or simulated: it only looks at measured cadence.
/// Hysteresis and a hold time stop it hunting between neighbouring gears
/// (one default gear step is about 7.7 %, or 7 rpm at 90 rpm).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct AutoShift {
    pub enabled: bool,
    pub target_cadence_rpm: f64,
    /// Cadence must leave this band around the target before a shift.
    pub band_rpm: f64,
    /// ... and stay outside it this long.
    pub hold_s: f64,
    /// Minimum time between automatic shifts.
    pub interval_s: f64,
    /// After a manual shift, automatic shifting pauses this long.
    pub manual_pause_s: f64,
}

impl Default for AutoShift {
    fn default() -> Self {
        Self {
            enabled: false,
            target_cadence_rpm: 88.0,
            band_rpm: 7.0,
            hold_s: 1.5,
            interval_s: 2.5,
            manual_pause_s: 12.0,
        }
    }
}

/// One step of an ERG workout: hold `watts` for `seconds`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkoutStep {
    pub watts: f64,
    pub seconds: f64,
}

/// A structured ERG workout: the trainer holds each step's watts in turn.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Workout {
    pub name: String,
    pub steps: Vec<WorkoutStep>,
    /// An FTP ramp test: the first step is the warm-up, the rest climb until the rider gives
    /// out, which ends the workout with a [`RampResult`] in the snapshot.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ramp: bool,
}

impl Workout {
    pub fn total_seconds(&self) -> f64 {
        self.steps.iter().map(|s| s.seconds).sum()
    }
}

/// Where a running workout stands.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkoutSnapshot {
    pub name: String,
    /// Zero-based index of the current step.
    pub step: usize,
    pub steps: usize,
    pub step_watts: f64,
    pub step_seconds: f64,
    pub step_elapsed_s: f64,
    pub total_seconds: f64,
    pub elapsed_s: f64,
    /// Watts of the step after this one, if any.
    pub next_watts: Option<f64>,
    /// The workout clock only runs while pedalling.
    pub paused: bool,
    pub done: bool,
    /// Watts added to every step by the rider during the workout (the trainer holds step + bias).
    pub bias_w: f64,
}

pub const MIN_TARGET_CADENCE: f64 = 50.0;
pub const MAX_TARGET_CADENCE: f64 = 130.0;

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

/// Totals of the ride so far: for the HUD, the finish screen and the stored ride record.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RideStats {
    /// Seconds the bike was moving.
    pub moving_s: f64,
    /// Metres ridden since the ride started.
    pub distance_m: f64,
    pub ascent_m: f64,
    pub descent_m: f64,
    /// Over the whole ride clock, zeros included.
    pub avg_power_w: Option<f64>,
    pub max_power_w: f64,
    /// Normalized power: the fourth-power mean of 30 s rolling averages (after the first 30 s).
    pub normalized_power_w: Option<f64>,
    pub avg_heart_rate_bpm: Option<f64>,
    pub max_heart_rate_bpm: f64,
    /// While pedalling.
    pub avg_cadence_rpm: Option<f64>,
    pub avg_speed_kmh: f64,
    /// Work at the pedals in kilojoules (about the kilocalories burned).
    pub energy_kj: f64,
}

/// One second of a ride, for the ride record and its graphs.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct RideSample {
    /// Ride clock in seconds.
    pub t_s: f64,
    pub distance_m: f64,
    pub elevation_m: f64,
    pub grade_pct: f64,
    pub speed_kmh: f64,
    pub power_w: Option<f64>,
    pub cadence_rpm: Option<f64>,
    pub heart_rate_bpm: Option<f64>,
    /// Where on the world the sample was taken (route x, z), for exports with positions.
    #[serde(default)]
    pub xz: Option<[f64; 2]>,
}

/// A finished (or abandoned) ride as the session knows it; the engine adds the clock time and stores it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RideReport {
    pub route: String,
    pub world: Option<String>,
    pub workout: Option<String>,
    /// The end of the route was reached.
    pub finished: bool,
    pub elapsed_s: f64,
    pub stats: RideStats,
    pub samples: Vec<RideSample>,
}

/// Seconds of power averaged for normalized power.
const NP_WINDOW_S: usize = 30;
/// Below this the bike counts as standing, and stays put until the rider pedals.
const STANDSTILL_MPS: f64 = 0.5;
/// Seconds the plane takes to close most of the gap to a new cruising speed.
const FLIGHT_LAG_S: f64 = 3.0;
/// Cadence that counts as pedalling.
const PEDALLING_RPM: f64 = 20.0;
/// Power that counts as pedalling when the trainer reports no cadence.
const PEDALLING_W: f64 = 20.0;

/// Running sums behind [`RideStats`].
#[derive(Clone, Debug, Default)]
struct Totals {
    power_ws: f64,
    power_s: f64,
    hr_bpm_s: f64,
    hr_s: f64,
    cadence_rpm_s: f64,
    cadence_s: f64,
    /// The last 30 one-second power values.
    np_window: VecDeque<f64>,
    np_sum4: f64,
    np_n: f64,
    last_elevation: Option<f64>,
    /// Ride clock at which the next one-second sample is due.
    next_sample_s: f64,
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
    pub auto_shift: bool,
    pub target_cadence_rpm: f64,
    /// Virtual gears on (single-speed drive like the Zwift Cog). Off: the
    /// trainer gets the road grade as it is and the rider shifts a real cassette.
    pub virtual_gearing: bool,
    pub power_w: Option<f64>,
    pub cadence_rpm: Option<f64>,
    pub trainer_speed_kmh: Option<f64>,
    pub heart_rate_bpm: Option<f64>,
    pub virtual_speed_kmh: f64,
    pub distance_m: f64,
    /// Distance within the current lap of the route (equals `distance_m` without a route).
    pub route_position_m: f64,
    /// Zero-based lap count on a closed route.
    pub lap: u32,
    /// The end of an open route has been reached.
    pub finished: bool,
    pub workout: Option<WorkoutSnapshot>,
    /// How the last FTP ramp test ended (until the next workout starts).
    #[serde(default)]
    pub ramp_result: Option<RampResult>,
    /// The trainer's link is down: the ride is held until it is back.
    pub trainer_offline: bool,
    /// Pedal power the virtual road asks for at the current cadence, gear and
    /// grade. In SIM mode the trainer should make the rider produce about this
    /// much; the gap to `power_w` shows how far the [`TrainerProfile`] is off.
    pub model_power_w: f64,
    pub last_command: Option<TrainerCommand>,
    pub last_command_age_s: Option<f64>,
    /// Chainring/cog ratio measured from the trainer's own speed and cadence.
    pub measured_drive_ratio: Option<f64>,
    pub stats: RideStats,
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
    auto_shift: AutoShift,
    /// Clock reading when the current ride started; `elapsed_s` counts from here.
    ride_start_s: f64,
    /// A running workout, with the seconds of it ridden so far.
    workout: Option<(Workout, f64)>,
    workout_paused: bool,
    /// Watching a ramp test, and how the last one ended.
    ramp: Option<RampTracker>,
    ramp_result: Option<RampResult>,
    workout_bias_w: f64,
    trainer_offline: bool,
    /// Seconds the ride clock has been held for an offline trainer.
    held_s: f64,
    virtual_gearing: bool,
    /// How long the cadence has been outside the auto-shift band, signed (+ = too fast).
    cadence_off_s: f64,
    last_auto_shift_at: f64,
    last_manual_shift_at: f64,
    stats: RideStats,
    totals: Totals,
    /// One sample per second of the ride clock.
    samples: Vec<RideSample>,
}

impl RideSession {
    pub fn new(config: SessionConfig) -> Self {
        let gearbox = Gearbox::new(config.gears.clone(), config.start_gear);
        let start_distance_m = config.start_distance_m.max(0.0);
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
            distance_m: start_distance_m,
            last_command: None,
            last_command_at: 0.0,
            urgent: true,
            drive_ratio_estimate: None,
            auto_shift: AutoShift::default(),
            ride_start_s: 0.0,
            workout: None,
            ramp: None,
            ramp_result: None,
            workout_paused: false,
            workout_bias_w: 0.0,
            trainer_offline: false,
            held_s: 0.0,
            virtual_gearing: true,
            cadence_off_s: 0.0,
            last_auto_shift_at: f64::MIN / 4.0,
            last_manual_shift_at: f64::MIN / 4.0,
            stats: RideStats::default(),
            totals: Totals::default(),
            samples: Vec::new(),
        }
    }

    pub fn stats(&self) -> &RideStats {
        &self.stats
    }

    /// The ride so far, with its one-second samples.
    pub fn report(&self) -> RideReport {
        let snap = self.snapshot();
        RideReport {
            route: self
                .config
                .route
                .as_ref()
                .map_or_else(|| "Free ride".to_string(), |r| r.name.clone()),
            world: self.config.route.as_ref().and_then(|r| r.world.clone()),
            workout: self.workout.as_ref().map(|(w, _)| w.name.clone()),
            finished: snap.finished,
            elapsed_s: snap.elapsed_s,
            stats: self.stats.clone(),
            samples: self.samples.clone(),
        }
    }

    /// Flying the plane (a flight route), not riding.
    fn is_flight(&self) -> bool {
        self.config.route.as_ref().is_some_and(|r| r.flight)
    }

    /// Adds this tick to the ride totals and takes the one-second sample when due.
    fn account(&mut self, dt: f64, power: f64) {
        let now = self.clock_s;
        let timeout = self.config.data_timeout_s;
        let elapsed = now - self.ride_start_s - self.held_s;
        let t = &mut self.totals;
        let s = &mut self.stats;
        s.distance_m += self.virtual_speed_mps * dt;
        if self.virtual_speed_mps > 0.5 {
            s.moving_s += dt;
        }
        t.power_ws += power * dt;
        t.power_s += dt;
        s.max_power_w = s.max_power_w.max(power);
        s.energy_kj += power * dt / 1000.0;
        let heart_rate = self.heart_rate.fresh(now, timeout);
        if let Some(hr) = heart_rate {
            t.hr_bpm_s += hr * dt;
            t.hr_s += dt;
            s.max_heart_rate_bpm = s.max_heart_rate_bpm.max(hr);
        }
        let cadence = self.cadence.fresh(now, timeout);
        if let Some(c) = cadence.filter(|c| *c >= 20.0) {
            t.cadence_rpm_s += c * dt;
            t.cadence_s += dt;
        }
        let elevation = self.config.route.as_ref().map(|r| r.elevation_at(self.distance_m));
        if let (Some(y), Some(last)) = (elevation, t.last_elevation) {
            let dy = y - last;
            if dy > 0.0 {
                s.ascent_m += dy;
            } else {
                s.descent_m -= dy;
            }
        }
        t.last_elevation = elevation;
        s.avg_power_w = (t.power_s > 0.0).then(|| t.power_ws / t.power_s);
        s.avg_heart_rate_bpm = (t.hr_s > 0.0).then(|| t.hr_bpm_s / t.hr_s);
        s.avg_cadence_rpm = (t.cadence_s > 0.0).then(|| t.cadence_rpm_s / t.cadence_s);
        s.avg_speed_kmh = if s.moving_s > 0.0 {
            mps_to_kmh(s.distance_m / s.moving_s)
        } else {
            0.0
        };
        if elapsed >= t.next_sample_s {
            t.next_sample_s = elapsed.floor() + 1.0;
            t.np_window.push_back(power);
            if t.np_window.len() > NP_WINDOW_S {
                t.np_window.pop_front();
            }
            if t.np_window.len() == NP_WINDOW_S {
                let avg = t.np_window.iter().sum::<f64>() / NP_WINDOW_S as f64;
                t.np_sum4 += avg.powi(4);
                t.np_n += 1.0;
                s.normalized_power_w = Some((t.np_sum4 / t.np_n).powf(0.25));
            }
            self.samples.push(RideSample {
                t_s: elapsed,
                distance_m: self.distance_m,
                elevation_m: elevation.unwrap_or(0.0),
                grade_pct: self.road_grade_pct,
                speed_kmh: mps_to_kmh(self.virtual_speed_mps),
                power_w: self.power.fresh(now, timeout),
                cadence_rpm: cadence,
                heart_rate_bpm: heart_rate,
                xz: self.config.route.as_ref().map(|r| {
                    let (x, _, z) = r.position_at(self.distance_m);
                    [x, z]
                }),
            });
        }
    }

    pub fn auto_shift(&self) -> &AutoShift {
        &self.auto_shift
    }

    /// Turns virtual gearing on or off. Off, shifts do nothing and the trainer
    /// simulates the road grade directly, for riders with a real cassette.
    pub fn set_virtual_gearing(&mut self, on: bool) {
        if on != self.virtual_gearing {
            self.virtual_gearing = on;
            self.urgent = true;
        }
    }

    pub fn set_auto_shift(&mut self, enabled: bool) {
        self.auto_shift.enabled = enabled;
        self.cadence_off_s = 0.0;
    }

    pub fn set_target_cadence(&mut self, rpm: f64) {
        self.auto_shift.target_cadence_rpm = rpm.clamp(MIN_TARGET_CADENCE, MAX_TARGET_CADENCE).round();
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

    /// Shifts one gear by hand. Returns false at the end of the range.
    /// Pauses automatic shifting for a while so the rider's choice sticks.
    pub fn shift(&mut self, dir: ShiftDirection) -> bool {
        if !self.virtual_gearing {
            return false;
        }
        self.last_manual_shift_at = self.clock_s;
        self.cadence_off_s = 0.0;
        let changed = self.gearbox.shift(dir);
        self.urgent |= changed;
        changed
    }

    /// Automatic shifting for this tick. Only in SIM mode, only while pedalling.
    fn auto_shift_step(&mut self, cadence: Option<f64>, dt: f64) {
        let a = self.auto_shift;
        let now = self.clock_s;
        let Some(c) = cadence.filter(|c| *c >= 20.0) else {
            self.cadence_off_s = 0.0;
            return;
        };
        if !a.enabled
            || !self.virtual_gearing
            || self.mode != ControlMode::Sim
            || now - self.last_manual_shift_at < a.manual_pause_s
            || now - self.last_auto_shift_at < a.interval_s
        {
            self.cadence_off_s = 0.0;
            return;
        }
        let off = c - a.target_cadence_rpm;
        if off > a.band_rpm {
            self.cadence_off_s = self.cadence_off_s.max(0.0) + dt;
        } else if off < -a.band_rpm {
            self.cadence_off_s = self.cadence_off_s.min(0.0) - dt;
        } else {
            self.cadence_off_s = 0.0;
            return;
        }
        if self.cadence_off_s.abs() < a.hold_s {
            return;
        }
        let dir = if self.cadence_off_s > 0.0 {
            ShiftDirection::Up
        } else {
            ShiftDirection::Down
        };
        if self.gearbox.shift(dir) {
            self.urgent = true;
            self.last_auto_shift_at = now;
        }
        self.cadence_off_s = 0.0;
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

    /// Sets the virtual road's grade by hand. Ignored while a route is set.
    pub fn set_road_grade(&mut self, grade_pct: f64) {
        if self.config.route.is_some() {
            return;
        }
        self.road_grade_pct = grade_pct.clamp(-25.0, 25.0);
        self.urgent = true;
    }

    pub fn route(&self) -> Option<&Route> {
        self.config.route.as_ref()
    }

    /// Replaces the road without touching the ride: for a navigator that
    /// extends or re-plans the route ahead. The new route must agree with
    /// the old one up to the rider's position.
    pub fn replace_route(&mut self, route: Route) {
        self.config.route = Some(route);
        if let Some(r) = &self.config.route {
            self.road_grade_pct = r.grade_at(self.distance_m);
        }
    }

    /// Switches the road and starts a fresh ride on it.
    /// The rider's body mass, in kg (bike mass and drag area keep their defaults).
    /// Gravity on every climb, and so the trainer's grade, follow from it.
    pub fn set_rider_mass(&mut self, kg: f64) {
        self.config.rider.rider_mass_kg = kg.clamp(30.0, 200.0);
    }

    pub fn rider(&self) -> &RiderParams {
        &self.config.rider
    }

    pub fn set_route(&mut self, route: Option<Route>) {
        self.config.route = route;
        self.reset_ride();
    }

    /// Back to the start: distance, speed and the ride clock. Devices and
    /// settings (gear, mode, auto-shift) stay as they are.
    pub fn reset_ride(&mut self) {
        self.distance_m = 0.0;
        self.virtual_speed_mps = 0.0;
        self.ride_start_s = self.clock_s;
        self.held_s = 0.0;
        self.stats = RideStats::default();
        self.totals = Totals::default();
        self.samples.clear();
        if let Some(route) = &self.config.route {
            self.road_grade_pct = route.grade_at(0.0);
        }
        self.urgent = true;
    }

    /// The trainer's link dropped (or came back). While it is down the ride is
    /// held: no distance, no ride clock, no workout clock; the bike coasts to a
    /// stop. The last command is re-sent on reconnect by the device layer.
    pub fn set_trainer_offline(&mut self, offline: bool) {
        if offline != self.trainer_offline {
            self.trainer_offline = offline;
            self.urgent = true;
        }
    }

    /// Starts an ERG workout from its first step. Empty workouts are ignored.
    pub fn start_workout(&mut self, workout: Workout) {
        if workout.steps.is_empty() {
            return;
        }
        self.set_mode(ControlMode::Erg);
        self.workout_bias_w = 0.0;
        self.set_erg_target(workout.steps[0].watts);
        self.ramp = workout.ramp.then(RampTracker::new);
        self.ramp_result = None;
        self.workout = Some((workout, 0.0));
        self.workout_paused = true;
    }

    /// Makes the whole workout `watts` harder (or easier, negative) from now on.
    pub fn set_workout_bias(&mut self, watts: f64) {
        self.workout_bias_w = watts.clamp(-300.0, 300.0).round();
        if let Some((w, elapsed)) = &self.workout {
            let step = Self::step_index(w, *elapsed);
            let target = w.steps[step].watts + self.workout_bias_w;
            self.set_erg_target(target);
        }
    }

    /// Jumps to the start of the next step. False at the last step or without a workout.
    pub fn skip_workout_step(&mut self) -> bool {
        let Some((w, elapsed)) = self.workout.as_mut() else {
            return false;
        };
        let step = Self::step_index(w, *elapsed);
        if step + 1 >= w.steps.len() {
            return false;
        }
        *elapsed = w.steps[..=step].iter().map(|s| s.seconds).sum();
        let target = w.steps[step + 1].watts + self.workout_bias_w;
        self.set_erg_target(target);
        true
    }

    /// Ends the workout and returns to free riding.
    pub fn stop_workout(&mut self) {
        // A ramp test stopped by the rider still has a result.
        if let Some(t) = self.ramp.take() {
            self.ramp_result = Some(t.result());
        }
        if self.workout.take().is_some() {
            self.set_mode(ControlMode::Sim);
        }
    }

    pub fn workout(&self) -> Option<WorkoutSnapshot> {
        let (w, elapsed) = self.workout.as_ref()?;
        let total = w.total_seconds();
        let mut acc = 0.0;
        let mut step = w.steps.len() - 1;
        for (i, s) in w.steps.iter().enumerate() {
            if *elapsed < acc + s.seconds {
                step = i;
                break;
            }
            acc += s.seconds;
        }
        let done = *elapsed >= total;
        let step_start: f64 = w.steps[..step].iter().map(|s| s.seconds).sum();
        Some(WorkoutSnapshot {
            name: w.name.clone(),
            step,
            steps: w.steps.len(),
            step_watts: w.steps[step].watts,
            step_seconds: w.steps[step].seconds,
            step_elapsed_s: (elapsed - step_start).clamp(0.0, w.steps[step].seconds),
            total_seconds: total,
            elapsed_s: elapsed.min(total),
            next_watts: w.steps.get(step + 1).map(|s| s.watts),
            paused: self.workout_paused && !done,
            done,
            bias_w: self.workout_bias_w,
        })
    }

    /// Advances the workout clock while the rider pedals; moves the ERG target along the steps.
    fn workout_step(&mut self, dt: f64, pedalling: bool) {
        let Some((workout, elapsed)) = self.workout.as_mut() else {
            return;
        };
        let total = workout.total_seconds();
        if *elapsed >= total {
            return;
        }
        self.workout_paused = !pedalling;
        if !pedalling {
            return;
        }
        let before = Self::step_index(workout, *elapsed);
        *elapsed += dt;
        let after = Self::step_index(workout, *elapsed);
        if after != before {
            let watts = workout.steps[after].watts + self.workout_bias_w;
            self.set_erg_target(watts);
        }
    }

    /// Feeds a running ramp test; when the rider gives out (or rides every step) the workout
    /// is over: its clock jumps to the end, so it reports done, and the result is kept.
    fn ramp_step(&mut self, dt: f64, power: f64, pedalling: bool) {
        let (Some(tracker), Some((w, elapsed))) = (self.ramp.as_mut(), self.workout.as_mut()) else {
            return;
        };
        let total = w.total_seconds();
        let step = Self::step_index(w, *elapsed);
        let target = w.steps[step].watts + self.workout_bias_w;
        // Not pedalling at all (the workout clock stands) counts as giving out too.
        let result = tracker.feed(dt, if pedalling { power } else { 0.0 }, target, step > 0);
        if result.is_some() || *elapsed >= total {
            self.ramp_result = Some(result.unwrap_or_else(|| tracker.result()));
            *elapsed = total;
            self.ramp = None;
        }
    }

    fn step_index(workout: &Workout, elapsed: f64) -> usize {
        let mut acc = 0.0;
        for (i, s) in workout.steps.iter().enumerate() {
            if elapsed < acc + s.seconds {
                return i;
            }
            acc += s.seconds;
        }
        workout.steps.len() - 1
    }

    /// The rider is turning the pedals: fresh cadence, or power from a trainer that
    /// reports none. A hand on the flywheel (a few watts, no cadence) does not count.
    fn pedalling(&self, now: f64) -> bool {
        let timeout = self.config.data_timeout_s;
        !self.trainer_offline
            && (self.cadence.fresh(now, timeout).is_some_and(|c| c >= PEDALLING_RPM)
                || self.power.fresh(now, timeout).is_some_and(|p| p >= PEDALLING_W))
    }

    /// Advances time by `dt` seconds. Returns a command when the trainer needs a new one.
    pub fn tick(&mut self, dt: f64) -> Option<TrainerCommand> {
        self.clock_s += dt;
        let timeout = self.config.data_timeout_s;
        let now = self.clock_s;
        let pedalling = self.pedalling(now);
        self.workout_step(dt, pedalling);
        if self.trainer_offline {
            // Held: the clock does not count and the rider brakes to a stop.
            self.held_s += dt;
            self.virtual_speed_mps = (self.virtual_speed_mps - 1.5 * dt).max(0.0);
            self.cadence_off_s = 0.0;
        }

        let power = if self.trainer_offline {
            0.0
        } else {
            self.power.fresh(now, timeout).unwrap_or(0.0)
        };
        if self.trainer_offline {
            // Held above.
        } else if self.is_flight() {
            // The plane: towards its cruising speed for the power over a few seconds (its
            // inertia), down to a standstill in the air without power.
            let target = if pedalling { flight_speed_mps(power) } else { 0.0 };
            self.virtual_speed_mps += (target - self.virtual_speed_mps) * (dt / FLIGHT_LAG_S).min(1.0);
            if self.virtual_speed_mps < STANDSTILL_MPS && target == 0.0 {
                self.virtual_speed_mps = 0.0;
            }
            self.distance_m += self.virtual_speed_mps * dt;
        } else if self.virtual_speed_mps >= STANDSTILL_MPS || pedalling {
            self.virtual_speed_mps = step_speed(
                &self.config.rider,
                self.virtual_speed_mps,
                power,
                self.road_grade_pct,
                dt,
            );
            self.distance_m += self.virtual_speed_mps * dt;
        } else {
            // A foot on the ground: a standing bike waits for the first pedal stroke
            // instead of rolling off down the hill by itself.
            self.virtual_speed_mps = 0.0;
        }
        if let Some(route) = &self.config.route {
            // Not urgent: the deadband and interval decide when the trainer hears about it.
            self.road_grade_pct = route.grade_at(self.distance_m);
        }
        if !self.trainer_offline {
            self.account(dt, power);
        }
        self.ramp_step(dt, power, pedalling);

        let cadence = self.cadence.fresh(now, timeout);
        let trainer_speed = self.trainer_speed.fresh(now, timeout).map(kmh_to_mps);
        self.auto_shift_step(cadence, dt);
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
            ControlMode::Sim if !self.virtual_gearing => {
                // A real drivetrain: the trainer simulates the road as it is.
                let t = &self.config.trainer;
                let grade = self.road_grade_pct.clamp(t.min_grade_pct, t.max_grade_pct);
                TrainerCommand::Simulation(crate::resistance::SimTarget {
                    grade_pct: grade,
                    crr: t.sim_crr,
                    cw_kg_per_m: t.sim_cw,
                    wind_mps: 0.0,
                    desired_grade_pct: self.road_grade_pct,
                    clamped: if self.road_grade_pct > t.max_grade_pct {
                        Some(crate::resistance::Clamp::High)
                    } else if self.road_grade_pct < t.min_grade_pct {
                        Some(crate::resistance::Clamp::Low)
                    } else {
                        None
                    },
                })
            }
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
        let (route_position_m, lap) = self
            .config
            .route
            .as_ref()
            .map_or((self.distance_m, 0), |r| r.lap_position(self.distance_m));
        let finished = self
            .config
            .route
            .as_ref()
            .is_some_and(|r| !r.closed && self.distance_m >= r.length_m());
        SessionSnapshot {
            elapsed_s: now - self.ride_start_s - self.held_s,
            mode: self.mode,
            erg_target_w: self.erg_target_w,
            road_grade_pct: self.road_grade_pct,
            gear: self.gearbox.gear_number(),
            gear_count: self.gearbox.set().len(),
            gear_ratio: self.gearbox.ratio(),
            auto_shift: self.auto_shift.enabled,
            target_cadence_rpm: self.auto_shift.target_cadence_rpm,
            virtual_gearing: self.virtual_gearing,
            power_w: self.power.fresh(now, t),
            cadence_rpm: self.cadence.fresh(now, t),
            trainer_speed_kmh: self.trainer_speed.fresh(now, t),
            heart_rate_bpm: self.heart_rate.fresh(now, t),
            virtual_speed_kmh: mps_to_kmh(self.virtual_speed_mps),
            distance_m: self.distance_m,
            route_position_m,
            lap,
            finished,
            workout: self.workout(),
            ramp_result: self.ramp_result.clone(),
            trainer_offline: self.trainer_offline,
            model_power_w,
            last_command: self.last_command,
            last_command_age_s: self.last_command.map(|_| now - self.last_command_at),
            measured_drive_ratio: self.drive_ratio_estimate,
            stats: self.stats.clone(),
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
    fn a_flight_cruises_at_100_kmh_on_160_w_and_stops_in_place() {
        let mut plane = RideSession::default();
        plane.set_route(Some(Route::builtin("tramuntana-flight").unwrap()));
        for _ in 0..(60 * 4) {
            riding(&mut plane, 160.0, 90.0);
            plane.tick(0.25);
        }
        let p = plane.snapshot();
        assert!((p.virtual_speed_kmh - 100.0).abs() < 0.5, "{}", p.virtual_speed_kmh);
        assert_eq!(p.road_grade_pct, 0.0, "flown level, whatever the altitude does");
        // More power, faster, but by the cube root (drag), not in proportion.
        for _ in 0..(30 * 4) {
            riding(&mut plane, 320.0, 95.0);
            plane.tick(0.25);
        }
        let fast = plane.snapshot().virtual_speed_kmh;
        assert!((fast - 126.0).abs() < 1.0, "{fast}");
        // Pedalling stops: the plane comes to a halt and stays there.
        for _ in 0..(120 * 4) {
            riding(&mut plane, 0.0, 0.0);
            plane.tick(0.25);
        }
        let stopped = plane.snapshot().distance_m;
        for _ in 0..(10 * 4) {
            riding(&mut plane, 0.0, 0.0);
            plane.tick(0.25);
        }
        assert!(plane.snapshot().distance_m - stopped < 0.5);
    }

    #[test]
    fn a_ramp_test_ends_when_the_rider_gives_out_and_reports_ftp() {
        let mut s = RideSession::default();
        let mut steps = vec![WorkoutStep {
            watts: 100.0,
            seconds: 300.0,
        }];
        steps.extend((0..30).map(|k| WorkoutStep {
            watts: 100.0 + 20.0 * k as f64,
            seconds: 60.0,
        }));
        s.start_workout(Workout {
            name: "FTP ramp test".into(),
            steps,
            ramp: true,
        });
        // The rider follows the target up to 300 W, then can only manage 150 W.
        let mut ended_at = None;
        for i in 0..(40 * 60 * 4) {
            let target = s.snapshot().erg_target_w;
            riding(&mut s, if target <= 300.0 { target } else { 150.0 }, 90.0);
            s.tick(0.25);
            if s.snapshot().workout.as_ref().is_some_and(|w| w.done) {
                ended_at = Some(i as f64 * 0.25);
                break;
            }
        }
        let ended_at = ended_at.expect("the test ended");
        // Warm-up 5 min, 11 steps to 300 W, then ten seconds into the 320 W step.
        assert!((ended_at - (300.0 + 11.0 * 60.0 + 10.0)).abs() < 2.0, "{ended_at}");
        let r = s.snapshot().ramp_result.expect("a result");
        assert_eq!(r.last_step_w, 300.0);
        assert!((r.best_minute_w - 300.0).abs() < 2.0, "{}", r.best_minute_w);
        assert!((r.ftp_w - 225.0).abs() < 2.0, "{}", r.ftp_w);
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
    fn route_drives_the_grade_and_laps() {
        let mut s = RideSession::new(SessionConfig {
            route: Some(Route::demo()),
            ..SessionConfig::default()
        });
        s.set_road_grade(12.0);
        riding(&mut s, 250.0, 90.0);
        s.tick(0.25);
        assert!(
            s.snapshot().road_grade_pct.abs() < 3.0,
            "start of the loop is nearly flat"
        );
        let mut seen_climb = false;
        for _ in 0..(20 * 60 * 4) {
            riding(&mut s, 250.0, 90.0);
            s.tick(0.25);
            seen_climb |= s.snapshot().road_grade_pct > 5.0;
        }
        let snap = s.snapshot();
        assert!(seen_climb);
        assert!(snap.lap >= 1, "20 min at 250 W covers more than one lap: {snap:?}");
        assert!(snap.route_position_m < Route::demo().length_m());
    }

    fn run(s: &mut RideSession, seconds: f64, power: f64, cadence: f64) {
        let steps = (seconds * 4.0) as usize;
        for _ in 0..steps {
            riding(s, power, cadence);
            s.tick(0.25);
        }
    }

    #[test]
    fn auto_shift_chases_the_target_cadence() {
        let mut s = RideSession::default();
        let start = s.snapshot().gear;
        run(&mut s, 10.0, 200.0, 110.0);
        assert_eq!(s.snapshot().gear, start, "off by default");

        s.set_auto_shift(true);
        s.set_target_cadence(88.0);
        assert_eq!(s.snapshot().target_cadence_rpm, 88.0);
        assert!(s.snapshot().auto_shift);
        run(&mut s, 2.0, 200.0, 110.0);
        assert_eq!(s.snapshot().gear, start + 1, "one shift after the hold time");
        run(&mut s, 1.0, 200.0, 110.0);
        assert_eq!(s.snapshot().gear, start + 1, "not again inside the interval");
        run(&mut s, 10.0, 200.0, 110.0);
        assert!(
            s.snapshot().gear >= start + 4,
            "keeps shifting while still too fast: {}",
            s.snapshot().gear
        );

        // Inside the band: nothing happens.
        let g = s.snapshot().gear;
        run(&mut s, 10.0, 200.0, 92.0);
        assert_eq!(s.snapshot().gear, g);

        // Too slow: shifts down.
        run(&mut s, 5.0, 200.0, 70.0);
        assert!(s.snapshot().gear < g);

        // Coasting: once the cadence reading has expired, no shifting.
        for _ in 0..13 {
            s.tick(0.25);
        }
        let g = s.snapshot().gear;
        assert_eq!(s.snapshot().cadence_rpm, None);
        for _ in 0..40 {
            s.tick(0.25);
        }
        assert_eq!(s.snapshot().gear, g);
    }

    #[test]
    fn manual_shift_pauses_auto_shift_and_erg_disables_it() {
        let mut s = RideSession::default();
        s.set_auto_shift(true);
        run(&mut s, 5.0, 200.0, 110.0);
        let g = s.snapshot().gear;
        s.shift(ShiftDirection::Down);
        run(&mut s, 8.0, 200.0, 110.0);
        assert_eq!(s.snapshot().gear, g - 1, "the rider's choice sticks for a while");
        run(&mut s, 8.0, 200.0, 110.0);
        assert!(s.snapshot().gear > g - 1, "then auto shifting resumes");

        s.set_mode(ControlMode::Erg);
        let g = s.snapshot().gear;
        run(&mut s, 10.0, 200.0, 120.0);
        assert_eq!(s.snapshot().gear, g, "ERG mode never auto-shifts");

        s.set_target_cadence(500.0);
        assert_eq!(s.snapshot().target_cadence_rpm, MAX_TARGET_CADENCE);
    }

    #[test]
    fn switching_routes_restarts_the_ride_and_climbs_finish() {
        let mut s = RideSession::default();
        run(&mut s, 20.0, 200.0, 90.0);
        assert!(s.snapshot().distance_m > 50.0);
        assert!(s.snapshot().elapsed_s > 19.0);
        s.set_route(Some(Route::builtin("sa-calobra").unwrap()));
        let snap = s.snapshot();
        assert_eq!(snap.distance_m, 0.0);
        assert!(snap.elapsed_s < 0.01, "ride clock restarts: {}", snap.elapsed_s);
        assert!(!snap.finished);
        // Teleport to the end: the climb is finished, the lap position stays at the end.
        s.distance_m = 20_000.0;
        let snap = s.snapshot();
        assert!(snap.finished);
        assert!((snap.route_position_m - Route::builtin("sa-calobra").unwrap().length_m()).abs() < 1e-9);
        s.set_route(Some(Route::demo()));
        s.distance_m = 20_000.0;
        assert!(!s.snapshot().finished, "loops never finish");
    }

    #[test]
    fn workout_steps_through_erg_targets_and_pauses_when_coasting() {
        let mut s = RideSession::default();
        let w = Workout {
            name: "test".into(),
            steps: vec![
                WorkoutStep {
                    watts: 120.0,
                    seconds: 10.0,
                },
                WorkoutStep {
                    watts: 250.0,
                    seconds: 20.0,
                },
                WorkoutStep {
                    watts: 100.0,
                    seconds: 10.0,
                },
            ],
            ramp: false,
        };
        s.start_workout(w);
        assert_eq!(s.snapshot().mode, ControlMode::Erg);
        assert_eq!(s.tick(0.25), Some(TrainerCommand::TargetPower { watts: 120 }));
        // Not pedalling: the clock waits.
        for _ in 0..40 {
            s.tick(0.25);
        }
        let snap = s.snapshot().workout.unwrap();
        assert!(snap.paused);
        assert_eq!(snap.elapsed_s, 0.0);
        // Pedal through the first step into the second.
        run(&mut s, 12.0, 150.0, 85.0);
        let snap = s.snapshot().workout.unwrap();
        assert!(!snap.paused);
        assert_eq!(snap.step, 1);
        assert_eq!(snap.step_watts, 250.0);
        assert!((snap.step_elapsed_s - 2.0).abs() < 0.3, "{}", snap.step_elapsed_s);
        assert_eq!(snap.next_watts, Some(100.0));
        assert_eq!(s.snapshot().erg_target_w, 250.0);
        run(&mut s, 30.0, 150.0, 85.0);
        let snap = s.snapshot().workout.unwrap();
        assert!(snap.done);
        assert_eq!(snap.step, 2);
        assert_eq!(snap.elapsed_s, 40.0);
        s.stop_workout();
        assert!(s.snapshot().workout.is_none());
        assert_eq!(s.snapshot().mode, ControlMode::Sim);
    }

    #[test]
    fn workout_bias_and_skip() {
        let mut s = RideSession::default();
        s.start_workout(Workout {
            name: "w".into(),
            steps: vec![
                WorkoutStep {
                    watts: 150.0,
                    seconds: 60.0,
                },
                WorkoutStep {
                    watts: 250.0,
                    seconds: 60.0,
                },
            ],
            ramp: false,
        });
        s.set_workout_bias(10.0);
        assert_eq!(s.snapshot().erg_target_w, 160.0);
        assert_eq!(s.workout().unwrap().bias_w, 10.0);
        assert!(s.skip_workout_step());
        assert_eq!(s.snapshot().erg_target_w, 260.0);
        assert_eq!(s.workout().unwrap().step, 1);
        assert!(!s.skip_workout_step(), "no step after the last");
        s.set_workout_bias(-20.0);
        assert_eq!(s.snapshot().erg_target_w, 230.0);
        // A new workout starts without the bias.
        s.start_workout(Workout {
            name: "x".into(),
            steps: vec![WorkoutStep {
                watts: 100.0,
                seconds: 60.0,
            }],
            ramp: false,
        });
        assert_eq!(s.snapshot().erg_target_w, 100.0);
        assert!(!s.skip_workout_step());
    }

    #[test]
    fn offline_trainer_holds_the_ride() {
        let mut s = RideSession::default();
        run(&mut s, 20.0, 200.0, 90.0);
        let before = s.snapshot();
        assert!(before.distance_m > 50.0);
        s.set_trainer_offline(true);
        // Stale samples keep arriving from nowhere; the ride must not advance.
        run(&mut s, 30.0, 200.0, 90.0);
        let held = s.snapshot();
        assert!(held.trainer_offline);
        assert!(
            (held.distance_m - before.distance_m).abs() < 1e-6,
            "no distance while offline"
        );
        assert!((held.elapsed_s - before.elapsed_s).abs() < 1e-6, "ride clock held");
        assert!(held.virtual_speed_kmh < 1.0, "the bike rolled out");
        s.set_trainer_offline(false);
        run(&mut s, 10.0, 200.0, 90.0);
        let back = s.snapshot();
        assert!(!back.trainer_offline);
        assert!(back.distance_m > before.distance_m + 10.0);
        assert!(
            (back.elapsed_s - before.elapsed_s - 10.0).abs() < 0.3,
            "{}",
            back.elapsed_s - before.elapsed_s
        );
    }

    #[test]
    fn without_virtual_gearing_the_trainer_gets_the_road_grade() {
        let mut s = RideSession::default();
        s.set_road_grade(6.0);
        riding(&mut s, 200.0, 90.0);
        let geared = grade(s.tick(0.25));
        assert!(
            (geared - 6.0).abs() > 0.2,
            "virtual gear 12 is not the trainer's own drive: {geared}"
        );
        s.set_virtual_gearing(false);
        assert_eq!(grade(s.tick(0.25)), 6.0);
        assert!(!s.shift(ShiftDirection::Up), "shifts do nothing");
        s.set_auto_shift(true);
        run(&mut s, 20.0, 200.0, 120.0);
        assert_eq!(s.snapshot().gear, 12, "no automatic shifting either");
        s.set_road_grade(25.0);
        let cmd = s.tick(0.25);
        assert_eq!(grade(cmd), 20.0, "clamped to the trainer's range");
        assert!(matches!(cmd, Some(TrainerCommand::Simulation(t)) if t.clamped.is_some()));
        assert!(!s.snapshot().virtual_gearing);
    }

    #[test]
    fn ride_totals_and_samples_add_up() {
        let mut s = RideSession::default();
        s.set_route(Some(Route::demo()));
        s.on_heart_rate(150.0);
        run(&mut s, 60.0, 200.0, 90.0);
        let st = s.snapshot().stats;
        assert!((st.avg_power_w.unwrap() - 200.0).abs() < 1.0, "{st:?}");
        assert_eq!(st.max_power_w, 200.0);
        assert!((st.normalized_power_w.unwrap() - 200.0).abs() < 1.0, "{st:?}");
        assert!((st.energy_kj - 12.0).abs() < 0.2, "{st:?}");
        assert!(st.avg_cadence_rpm.unwrap() > 89.0);
        assert!(st.moving_s > 50.0 && st.moving_s <= 60.0, "{st:?}");
        assert!(st.distance_m > 100.0 && (st.distance_m - s.snapshot().distance_m).abs() < 0.01);
        assert!(
            st.ascent_m > 0.0 || st.descent_m > 0.0,
            "the demo route is hilly: {st:?}"
        );
        let report = s.report();
        assert_eq!(report.route, "Lakeside loop");
        assert!(
            report.samples.len() >= 59 && report.samples.len() <= 61,
            "{}",
            report.samples.len()
        );
        assert!((report.samples[10].t_s - 10.0).abs() < 0.3);
        assert_eq!(report.samples[10].power_w, Some(200.0));
        // Heart rate expired long ago: averaged only while it was fresh.
        assert!(st.avg_heart_rate_bpm.unwrap() > 149.0);
        assert!(s.snapshot().heart_rate_bpm.is_none());
        // A new ride starts from zero.
        s.reset_ride();
        assert_eq!(s.snapshot().stats, RideStats::default());
        assert!(s.report().samples.is_empty());
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

    #[test]
    fn a_standing_bike_waits_for_the_first_pedal_stroke() {
        let mut s = RideSession::default();
        s.set_road_grade(-8.0);
        for _ in 0..40 {
            s.tick(0.25);
        }
        assert_eq!(s.snapshot().virtual_speed_kmh, 0.0, "no trainer: no rolling off");
        // A hand on the flywheel: a few watts, no cadence.
        for _ in 0..40 {
            s.on_trainer_sample(TrainerSample {
                power_w: Some(7.0),
                cadence_rpm: None,
                speed_kmh: Some(30.0),
            });
            s.tick(0.25);
        }
        assert_eq!(s.snapshot().virtual_speed_kmh, 0.0, "7 W is not pedalling");
        assert_eq!(s.snapshot().distance_m, 0.0);
        // Pedalling moves it, and once rolling it coasts when the pedals stop.
        for _ in 0..20 {
            riding(&mut s, 150.0, 80.0);
            s.tick(0.25);
        }
        let rolling = s.snapshot().virtual_speed_kmh;
        assert!(rolling > 10.0, "{rolling}");
        for _ in 0..40 {
            s.tick(0.25);
        }
        assert!(
            s.snapshot().virtual_speed_kmh > rolling,
            "coasting down an 8 % hill gets faster"
        );
        // Power alone counts too, for a trainer that reports no cadence.
        let mut p = RideSession::default();
        for _ in 0..20 {
            p.on_trainer_sample(TrainerSample {
                power_w: Some(150.0),
                cadence_rpm: None,
                speed_kmh: None,
            });
            p.tick(0.25);
        }
        assert!(p.snapshot().virtual_speed_kmh > 5.0);
    }

    #[test]
    fn rider_mass_changes_the_power_a_climb_needs() {
        let mut s = RideSession::new(SessionConfig::default());
        s.set_road_grade(8.0);
        assert_eq!(s.rider().rider_mass_kg, 75.0);
        let light = virtual_gear_power(s.rider(), 80.0, 2.0, 8.0);
        s.set_rider_mass(95.0);
        let heavy = virtual_gear_power(s.rider(), 80.0, 2.0, 8.0);
        // 20 kg more on an 8 % climb at the same speed: clearly more watts, and the clamp holds.
        assert!(heavy > light * 1.15, "{heavy} vs {light}");
        s.set_rider_mass(10.0);
        assert_eq!(s.rider().rider_mass_kg, 30.0);
    }
}
