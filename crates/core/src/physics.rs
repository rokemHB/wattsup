//! Road-load physics for a rider on a bike.
//!
//! Standard steady-state model: gravity + rolling resistance + aerodynamic drag,
//! with power at the pedals reduced by drivetrain losses. Units are SI unless a
//! name says otherwise; grades are in percent (rise over run × 100).

use serde::{Deserialize, Serialize};

/// Standard gravity in m/s².
pub const G: f64 = 9.80665;

/// Everything about the rider and bike that the physics needs.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct RiderParams {
    pub rider_mass_kg: f64,
    pub bike_mass_kg: f64,
    /// Drag area (drag coefficient × frontal area) in m². ~0.32 on the hoods.
    pub cda_m2: f64,
    /// Coefficient of rolling resistance. ~0.004 for good road tyres.
    pub crr: f64,
    /// Air density in kg/m³ (1.225 at sea level, 15 °C).
    pub air_density: f64,
    /// Fraction of pedal power that reaches the wheel.
    pub drivetrain_efficiency: f64,
    /// Rolling circumference of the (virtual) rear wheel in metres. 2.105 = 700×25c.
    pub wheel_circumference_m: f64,
}

impl Default for RiderParams {
    fn default() -> Self {
        Self {
            rider_mass_kg: 75.0,
            bike_mass_kg: 8.0,
            cda_m2: 0.32,
            crr: 0.004,
            air_density: 1.225,
            drivetrain_efficiency: 0.976,
            wheel_circumference_m: 2.105,
        }
    }
}

impl RiderParams {
    pub fn total_mass_kg(&self) -> f64 {
        self.rider_mass_kg + self.bike_mass_kg
    }
}

/// Angle of a slope in radians for a grade in percent.
pub fn grade_angle(grade_pct: f64) -> f64 {
    (grade_pct / 100.0).atan()
}

/// Gravity plus rolling resistance along the road, in newtons. Negative downhill.
pub fn gravity_rolling_force(mass_kg: f64, grade_pct: f64, crr: f64) -> f64 {
    let a = grade_angle(grade_pct);
    mass_kg * G * (a.sin() + crr * a.cos())
}

/// Aerodynamic drag in newtons for ground speed `v` and headwind `wind` (m/s).
/// Keeps its sign, so a strong tailwind pushes.
pub fn aero_force(cda_m2: f64, air_density: f64, v: f64, wind: f64) -> f64 {
    let air = v + wind;
    0.5 * air_density * cda_m2 * air * air.abs()
}

/// Total resisting force at the wheel at speed `v` (m/s) on `grade_pct`, no wind.
pub fn road_force(p: &RiderParams, v: f64, grade_pct: f64) -> f64 {
    gravity_rolling_force(p.total_mass_kg(), grade_pct, p.crr) + aero_force(p.cda_m2, p.air_density, v, 0.0)
}

/// Pedal power (W) needed to hold speed `v` on `grade_pct`.
pub fn power_for_speed(p: &RiderParams, v: f64, grade_pct: f64) -> f64 {
    road_force(p, v, grade_pct) * v / p.drivetrain_efficiency
}

/// Steady speed (m/s) a rider reaches with constant `power_w` on `grade_pct`.
///
/// On descents power-vs-speed dips below zero before rising again; the
/// physical answer is the fastest root, so the search starts at the dip.
pub fn steady_speed_for_power(p: &RiderParams, power_w: f64, grade_pct: f64) -> f64 {
    const V_MAX: f64 = 40.0;
    let f = |v: f64| power_for_speed(p, v, grade_pct) - power_w.max(0.0);
    // Lowest point of the power curve (0 on flat ground and climbs).
    let mut lo = 0.0;
    let mut min = f(0.0);
    let mut v = 0.0;
    while v < V_MAX {
        v += 0.1;
        let y = f(v);
        if y < min {
            min = y;
            lo = v;
        }
    }
    if f(lo) >= 0.0 {
        return lo;
    }
    let mut hi = V_MAX;
    if f(hi) < 0.0 {
        return V_MAX;
    }
    for _ in 0..60 {
        let mid = 0.5 * (lo + hi);
        if f(mid) < 0.0 {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

/// Advances bike speed by `dt` seconds under pedal power `power_w`.
///
/// Propulsive force is P/v, capped at low speed so a standing start does not
/// divide by zero. The bike never rolls backwards.
pub fn step_speed(p: &RiderParams, v: f64, power_w: f64, grade_pct: f64, dt: f64) -> f64 {
    const V_FLOOR: f64 = 1.0;
    let drive = power_w.max(0.0) * p.drivetrain_efficiency / v.max(V_FLOOR);
    let accel = (drive - road_force(p, v, grade_pct)) / p.total_mass_kg();
    (v + accel * dt).max(0.0)
}

pub fn mps_to_kmh(v: f64) -> f64 {
    v * 3.6
}

pub fn kmh_to_mps(v: f64) -> f64 {
    v / 3.6
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol
    }

    #[test]
    fn flat_power_at_known_speeds() {
        // Classic reference: ~83 kg system, CdA 0.32 needs roughly 200 W for
        // 32-33 km/h on the flat and roughly 330 W for 40 km/h.
        let p = RiderParams::default();
        let p32 = power_for_speed(&p, kmh_to_mps(32.0), 0.0);
        let p40 = power_for_speed(&p, kmh_to_mps(40.0), 0.0);
        assert!(close(p32, 185.0, 20.0), "32 km/h needs {p32} W");
        assert!(close(p40, 335.0, 25.0), "40 km/h needs {p40} W");
    }

    #[test]
    fn climbing_is_dominated_by_gravity() {
        let p = RiderParams::default();
        // 8% at 12 km/h: gravity alone is 83*9.81*sin(atan .08)*3.33 ≈ 216 W.
        let w = power_for_speed(&p, kmh_to_mps(12.0), 8.0);
        assert!(close(w, 240.0, 15.0), "8% at 12 km/h needs {w} W");
    }

    #[test]
    fn steady_speed_inverts_power_for_speed() {
        let p = RiderParams::default();
        for grade in [-6.0, -2.0, 0.0, 3.0, 10.0] {
            for watts in [50.0, 150.0, 250.0, 400.0] {
                let v = steady_speed_for_power(&p, watts, grade);
                let back = power_for_speed(&p, v, grade);
                assert!(
                    close(back, watts, 0.5),
                    "grade {grade}: {watts} W -> {v} m/s -> {back} W"
                );
            }
        }
    }

    #[test]
    fn coasting_downhill_has_terminal_speed() {
        let p = RiderParams::default();
        let v = steady_speed_for_power(&p, 0.0, -6.0);
        // Gravity ≈ 48.4 N, rolling ≈ 3.3 N → aero must balance ~45 N.
        assert!(close(mps_to_kmh(v), 55.0, 5.0), "terminal {} km/h", mps_to_kmh(v));
        assert_eq!(steady_speed_for_power(&p, 0.0, 0.0), 0.0);
    }

    #[test]
    fn step_speed_converges_to_steady_state() {
        let p = RiderParams::default();
        let mut v = 0.0;
        for _ in 0..(600 * 10) {
            v = step_speed(&p, v, 200.0, 1.0, 0.1);
        }
        let target = steady_speed_for_power(&p, 200.0, 1.0);
        assert!(close(v, target, 0.01), "{v} vs {target}");
    }

    #[test]
    fn step_speed_never_goes_backwards() {
        let p = RiderParams::default();
        assert_eq!(step_speed(&p, 0.0, 0.0, 15.0, 1.0), 0.0);
        assert!(step_speed(&p, 0.5, 0.0, 15.0, 1.0) >= 0.0);
    }

    #[test]
    fn tailwind_pushes() {
        assert!(aero_force(0.32, 1.225, 2.0, -5.0) < 0.0);
        assert!(aero_force(0.32, 1.225, 10.0, 0.0) > 0.0);
    }
}
