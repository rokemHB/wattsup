//! Turning virtual gear + virtual road into a trainer command.
//!
//! The trainer only knows its own physical drive: the rider's chainring over
//! the 14-tooth Zwift Cog. To make a virtual gear feel right, the force the
//! trainer applies at its flywheel must give the same pedal torque that the
//! virtual gear would need on the virtual road:
//!
//! ```text
//! crank torque = wheel force × wheel radius × gear ratio      (power is conserved)
//! ⇒ trainer force = road force(virtual speed, road grade) × virtual ratio / trainer ratio
//! ```
//!
//! The same relation makes the rider's power through the trainer equal the
//! power the virtual bike needs, which a test below checks. That force is sent as an FTMS simulation grade (SIM mode). The trainer's
//! fast internal loop then keeps resistance right through every pedal stroke,
//! while this code re-sends the grade a few times per second as speed, cadence
//! or gear change. The README ("How virtual gearing works") says why SIM beats ERG for shifting.

use serde::{Deserialize, Serialize};

use crate::gearing::wheel_speed_mps;
use crate::physics::{road_force, RiderParams, G};

/// What the trainer itself believes about its rider and drive.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrainerProfile {
    /// Chainring teeth / cog teeth actually on the trainer (e.g. 34/14 on the Zwift Cog).
    pub drive_ratio: f64,
    /// Rider + bike mass the trainer uses in its own SIM model. FTMS cannot send
    /// weight; Wahoo trainers reportedly default to 75 kg.
    pub assumed_mass_kg: f64,
    /// Rolling resistance coefficient we send along with the grade.
    pub sim_crr: f64,
    /// Wind resistance coefficient (kg/m) we send. 0 turns the trainer's own
    /// aero model off, because aero is already in our road force.
    pub sim_cw: f64,
    /// The flattest grade we ever send (trainers cap descents, ~-10% on a KICKR).
    pub min_grade_pct: f64,
    /// The steepest grade we ever send (~+20% on a KICKR CORE 2).
    pub max_grade_pct: f64,
}

impl Default for TrainerProfile {
    fn default() -> Self {
        Self {
            drive_ratio: 34.0 / 14.0,
            assumed_mass_kg: 75.0,
            sim_crr: 0.004,
            sim_cw: 0.0,
            min_grade_pct: -10.0,
            max_grade_pct: 20.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Clamp {
    /// Wanted less resistance than the trainer's lowest grade allows.
    Low,
    /// Wanted more resistance than the trainer's highest grade allows.
    High,
}

/// A simulation-mode target, plus what we would have sent without limits.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct SimTarget {
    pub grade_pct: f64,
    pub crr: f64,
    pub cw_kg_per_m: f64,
    pub wind_mps: f64,
    /// Grade the gear maths asked for before clamping to the trainer's range.
    pub desired_grade_pct: f64,
    pub clamped: Option<Clamp>,
}

/// Grade (percent) at which a mass `mass_kg` meets `force_n` of gravity +
/// rolling resistance: solves `m g (sin a + crr cos a) = F` exactly.
pub fn grade_for_force(force_n: f64, mass_kg: f64, crr: f64) -> f64 {
    // sin a + c cos a = R sin(a + φ) with R = √(1 + c²), φ = atan c.
    let r = (1.0 + crr * crr).sqrt();
    let x = (force_n / (mass_kg * G) / r).clamp(-1.0, 1.0);
    let angle = x.asin() - crr.atan();
    // Stay clear of vertical so tan() stays finite.
    angle.clamp(-1.5, 1.5).tan() * 100.0
}

/// SIM-mode target for riding `gear_ratio` at `cadence_rpm` on `road_grade_pct`.
///
/// `trainer_speed_mps` is the speed the trainer reports; it only matters when
/// `profile.sim_cw` is non-zero, to subtract the drag the trainer adds itself.
pub fn virtual_gear_sim(
    rider: &RiderParams,
    profile: &TrainerProfile,
    cadence_rpm: f64,
    gear_ratio: f64,
    road_grade_pct: f64,
    trainer_speed_mps: f64,
) -> SimTarget {
    let virtual_speed = wheel_speed_mps(cadence_rpm, gear_ratio, rider.wheel_circumference_m);
    let wheel_force = road_force(rider, virtual_speed, road_grade_pct);
    let mut trainer_force = wheel_force * gear_ratio / profile.drive_ratio;
    trainer_force -= profile.sim_cw * trainer_speed_mps * trainer_speed_mps;

    let desired = grade_for_force(trainer_force, profile.assumed_mass_kg, profile.sim_crr);
    let (grade, clamped) = if desired > profile.max_grade_pct {
        (profile.max_grade_pct, Some(Clamp::High))
    } else if desired < profile.min_grade_pct {
        (profile.min_grade_pct, Some(Clamp::Low))
    } else {
        (desired, None)
    };
    SimTarget {
        grade_pct: grade,
        crr: profile.sim_crr,
        cw_kg_per_m: profile.sim_cw,
        wind_mps: 0.0,
        desired_grade_pct: desired,
        clamped,
    }
}

/// Pedal power the virtual gear would need right now.
///
/// The ERG-based alternative to [`virtual_gear_sim`], for trainers whose SIM
/// mode misbehaves: send this as a target power and the trainer holds it.
pub fn virtual_gear_power(rider: &RiderParams, cadence_rpm: f64, gear_ratio: f64, road_grade_pct: f64) -> f64 {
    let v = wheel_speed_mps(cadence_rpm, gear_ratio, rider.wheel_circumference_m);
    (road_force(rider, v, road_grade_pct) * v / rider.drivetrain_efficiency).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gearing::GearSet;
    use crate::physics::gravity_rolling_force;

    fn wide_profile() -> TrainerProfile {
        TrainerProfile {
            min_grade_pct: -100.0,
            max_grade_pct: 100.0,
            ..TrainerProfile::default()
        }
    }

    #[test]
    fn grade_for_force_inverts_gravity_rolling_force() {
        for grade in [-15.0, -3.0, 0.0, 0.5, 6.0, 25.0] {
            let f = gravity_rolling_force(80.0, grade, 0.005);
            let back = grade_for_force(f, 80.0, 0.005);
            assert!((back - grade).abs() < 1e-9, "{grade} -> {f} N -> {back}");
        }
    }

    #[test]
    fn same_gear_as_trainer_means_same_grade_when_masses_match() {
        // Virtual gear equal to the physical drive and the trainer's mass equal
        // to ours: the trainer should simply see the road grade (no aero at 0 rpm).
        let rider = RiderParams::default();
        let profile = TrainerProfile {
            assumed_mass_kg: rider.total_mass_kg(),
            sim_crr: rider.crr,
            ..wide_profile()
        };
        let t = virtual_gear_sim(&rider, &profile, 0.0, profile.drive_ratio, 5.0, 0.0);
        assert!((t.grade_pct - 5.0).abs() < 1e-9, "{t:?}");
        assert_eq!(t.clamped, None);
    }

    #[test]
    fn harder_gear_means_more_resistance() {
        let rider = RiderParams::default();
        let profile = wide_profile();
        let set = GearSet::default();
        for (cadence, grade) in [(90.0, 0.0), (70.0, 8.0), (0.0, 4.0)] {
            let grades: Vec<f64> = set
                .ratios()
                .iter()
                .map(|&r| virtual_gear_sim(&rider, &profile, cadence, r, grade, 0.0).grade_pct)
                .collect();
            assert!(
                grades.windows(2).all(|w| w[1] > w[0]),
                "{cadence} rpm at {grade}%: {grades:?}"
            );
            let powers: Vec<f64> = set
                .ratios()
                .iter()
                .map(|&r| virtual_gear_power(&rider, cadence, r, grade))
                .collect();
            assert!(powers.windows(2).all(|w| w[1] >= w[0]), "{powers:?}");
        }
    }

    #[test]
    fn one_shift_changes_resistance_by_a_noticeable_step() {
        // On a climb (gravity-dominated) one shift is roughly one gear step (~7.7%) of force.
        let rider = RiderParams::default();
        let profile = wide_profile();
        let set = GearSet::default();
        let f = |i: usize| {
            let t = virtual_gear_sim(&rider, &profile, 0.0, set.ratio(i), 6.0, 0.0);
            gravity_rolling_force(profile.assumed_mass_kg, t.grade_pct, t.crr)
        };
        let step = f(10) / f(9);
        assert!((step - set.ratio(10) / set.ratio(9)).abs() < 1e-6, "{step}");
    }

    #[test]
    fn rider_power_through_trainer_matches_virtual_road_power() {
        // What the trainer makes the rider produce (force × trainer speed) must
        // equal what the virtual bike needs (road force × virtual speed).
        let rider = RiderParams::default();
        let profile = wide_profile();
        let circ = rider.wheel_circumference_m;
        for (cadence, gear, grade) in [(90.0, 3.2, 0.0), (75.0, 1.1, 7.0), (100.0, 4.5, -1.0), (60.0, 2.0, 3.0)] {
            let t = virtual_gear_sim(&rider, &profile, cadence, gear, grade, 0.0);
            let trainer_force = gravity_rolling_force(profile.assumed_mass_kg, t.grade_pct, t.crr);
            let trainer_power = trainer_force * wheel_speed_mps(cadence, profile.drive_ratio, circ);
            let road_power = virtual_gear_power(&rider, cadence, gear, grade) * rider.drivetrain_efficiency;
            assert!(
                (trainer_power - road_power).abs() < 1e-6,
                "{cadence} rpm gear {gear} at {grade}%: {trainer_power} vs {road_power}"
            );
        }
    }

    #[test]
    fn clamps_to_trainer_range_and_reports_it() {
        let rider = RiderParams::default();
        let profile = TrainerProfile::default();
        let set = GearSet::default();
        let steep = virtual_gear_sim(&rider, &profile, 60.0, set.ratio(23), 15.0, 0.0);
        assert_eq!(steep.clamped, Some(Clamp::High));
        assert_eq!(steep.grade_pct, profile.max_grade_pct);
        assert!(steep.desired_grade_pct > profile.max_grade_pct);
        let descent = virtual_gear_sim(&rider, &profile, 0.0, set.ratio(23), -12.0, 0.0);
        assert_eq!(descent.clamped, Some(Clamp::Low));
        assert_eq!(descent.grade_pct, profile.min_grade_pct);
    }

    #[test]
    fn trainer_aero_is_subtracted_when_cw_is_sent() {
        let rider = RiderParams::default();
        let without = virtual_gear_sim(&rider, &wide_profile(), 90.0, 3.0, 0.0, 10.0);
        let with = virtual_gear_sim(
            &rider,
            &TrainerProfile {
                sim_cw: 0.51,
                ..wide_profile()
            },
            90.0,
            3.0,
            0.0,
            10.0,
        );
        assert!(with.grade_pct < without.grade_pct);
        let profile = TrainerProfile {
            sim_cw: 0.51,
            ..wide_profile()
        };
        let f_with = gravity_rolling_force(profile.assumed_mass_kg, with.grade_pct, profile.sim_crr) + 0.51 * 100.0;
        let f_without = gravity_rolling_force(profile.assumed_mass_kg, without.grade_pct, profile.sim_crr);
        assert!((f_with - f_without).abs() < 1e-6);
    }
}
