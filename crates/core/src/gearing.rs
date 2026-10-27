//! Virtual gearing.
//!
//! The trainer has one physical gear (chainring over the Zwift Cog), so all
//! shifting happens here: each virtual gear is just a ratio (chainring teeth /
//! cog teeth) that turns cadence into virtual wheel speed.

use serde::{Deserialize, Serialize};

pub const DEFAULT_GEAR_COUNT: usize = 24;
/// Easiest default gear, about 34×38: for steep climbs.
pub const DEFAULT_LOWEST_RATIO: f64 = 0.9;
/// Hardest default gear, about 55×11: for sprints and descents.
pub const DEFAULT_HIGHEST_RATIO: f64 = 5.0;

/// An ordered list of gear ratios, easiest first.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GearSet {
    ratios: Vec<f64>,
}

impl GearSet {
    /// Ratios spaced evenly on a log scale, so every shift changes effort by
    /// the same percentage (about 7.7% with the defaults).
    pub fn geometric(count: usize, lowest: f64, highest: f64) -> Self {
        assert!(count >= 2, "a gear set needs at least two gears");
        assert!(
            lowest > 0.0 && highest > lowest,
            "ratios must be positive and increasing"
        );
        let step = (highest / lowest).powf(1.0 / (count - 1) as f64);
        let ratios = (0..count).map(|i| lowest * step.powi(i as i32)).collect();
        Self { ratios }
    }

    /// Builds a set from explicit ratios. They must be positive and strictly increasing.
    pub fn from_ratios(ratios: Vec<f64>) -> Option<Self> {
        let ok = ratios.len() >= 2 && ratios[0] > 0.0 && ratios.windows(2).all(|w| w[1] > w[0]);
        ok.then_some(Self { ratios })
    }

    pub fn len(&self) -> usize {
        self.ratios.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ratios.is_empty()
    }

    pub fn ratio(&self, index: usize) -> f64 {
        self.ratios[index.min(self.ratios.len() - 1)]
    }

    pub fn ratios(&self) -> &[f64] {
        &self.ratios
    }
}

impl Default for GearSet {
    fn default() -> Self {
        Self::geometric(DEFAULT_GEAR_COUNT, DEFAULT_LOWEST_RATIO, DEFAULT_HIGHEST_RATIO)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShiftDirection {
    /// Harder gear (higher ratio).
    Up,
    /// Easier gear (lower ratio).
    Down,
}

/// The rider's current position in a [`GearSet`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Gearbox {
    set: GearSet,
    index: usize,
}

impl Gearbox {
    pub fn new(set: GearSet, start_index: usize) -> Self {
        let index = start_index.min(set.len() - 1);
        Self { set, index }
    }

    /// Shifts one gear; returns false at either end of the range.
    pub fn shift(&mut self, dir: ShiftDirection) -> bool {
        match dir {
            ShiftDirection::Up if self.index + 1 < self.set.len() => self.index += 1,
            ShiftDirection::Down if self.index > 0 => self.index -= 1,
            _ => return false,
        }
        true
    }

    /// Zero-based gear index.
    pub fn index(&self) -> usize {
        self.index
    }

    /// One-based gear number, as shown to the rider.
    pub fn gear_number(&self) -> usize {
        self.index + 1
    }

    pub fn ratio(&self) -> f64 {
        self.set.ratio(self.index)
    }

    pub fn set(&self) -> &GearSet {
        &self.set
    }
}

impl Default for Gearbox {
    fn default() -> Self {
        let set = GearSet::default();
        let middle = set.len() / 2 - 1;
        Self::new(set, middle)
    }
}

/// Wheel speed (m/s) for a cadence in a given ratio.
pub fn wheel_speed_mps(cadence_rpm: f64, ratio: f64, wheel_circumference_m: f64) -> f64 {
    cadence_rpm.max(0.0) / 60.0 * ratio * wheel_circumference_m
}

/// The ratio implied by a measured wheel speed and cadence, if the rider is pedalling.
///
/// Used to find the trainer's real drive ratio from its own speed and cadence
/// reports, since that depends on which chainring sits on the Cog.
pub fn implied_ratio(speed_mps: f64, cadence_rpm: f64, wheel_circumference_m: f64) -> Option<f64> {
    (cadence_rpm >= 30.0 && speed_mps > 0.5).then(|| speed_mps * 60.0 / (cadence_rpm * wheel_circumference_m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_set_has_24_increasing_gears_with_even_steps() {
        let set = GearSet::default();
        assert_eq!(set.len(), 24);
        assert!((set.ratio(0) - 0.9).abs() < 1e-9);
        assert!((set.ratio(23) - 5.0).abs() < 1e-9);
        let steps: Vec<f64> = set.ratios().windows(2).map(|w| w[1] / w[0]).collect();
        for s in &steps {
            assert!((s - steps[0]).abs() < 1e-9);
            assert!(*s > 1.07 && *s < 1.085, "step {s}");
        }
    }

    #[test]
    fn shifting_stops_at_the_ends() {
        let mut gb = Gearbox::new(GearSet::default(), 0);
        assert!(!gb.shift(ShiftDirection::Down));
        assert_eq!(gb.gear_number(), 1);
        for _ in 0..23 {
            assert!(gb.shift(ShiftDirection::Up));
        }
        assert_eq!(gb.gear_number(), 24);
        assert!(!gb.shift(ShiftDirection::Up));
        assert!(gb.shift(ShiftDirection::Down));
        assert_eq!(gb.index(), 22);
    }

    #[test]
    fn default_gearbox_starts_mid_range() {
        let gb = Gearbox::default();
        assert_eq!(gb.gear_number(), 12);
        assert!(gb.ratio() > 2.0 && gb.ratio() < 2.5);
    }

    #[test]
    fn from_ratios_rejects_bad_input() {
        assert!(GearSet::from_ratios(vec![1.0]).is_none());
        assert!(GearSet::from_ratios(vec![1.0, 1.0]).is_none());
        assert!(GearSet::from_ratios(vec![0.0, 1.0]).is_none());
        assert!(GearSet::from_ratios(vec![2.0, 1.0]).is_none());
        assert!(GearSet::from_ratios(vec![1.0, 2.0, 3.5]).is_some());
    }

    #[test]
    fn wheel_speed_matches_hand_calculation() {
        // 90 rpm in 50×14 on a 2.105 m wheel: 1.5 rev/s × 3.571 × 2.105 = 11.28 m/s.
        let v = wheel_speed_mps(90.0, 50.0 / 14.0, 2.105);
        assert!((v - 11.276).abs() < 0.01, "{v}");
        assert_eq!(wheel_speed_mps(-5.0, 3.0, 2.1), 0.0);
    }

    #[test]
    fn implied_ratio_round_trips_and_ignores_coasting() {
        let r = 34.0 / 14.0;
        let v = wheel_speed_mps(85.0, r, 2.105);
        assert!((implied_ratio(v, 85.0, 2.105).unwrap() - r).abs() < 1e-9);
        assert!(implied_ratio(v, 0.0, 2.105).is_none());
        assert!(implied_ratio(0.0, 85.0, 2.105).is_none());
    }
}
