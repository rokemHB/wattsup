//! The FTP ramp test: after a warm-up the ERG target climbs by a fixed step every minute
//! until the rider can no longer hold it; FTP is then 75 % of the best one-minute power
//! (the ramp protocol most indoor cycling apps use). [`RampTracker`] watches the power
//! during a workout marked `ramp` and says when and how it ended.

use serde::{Deserialize, Serialize};

/// Below this share of the target...
pub const FAIL_SHARE: f64 = 0.85;
/// ...for this many seconds in a row, the rider has given out.
pub const FAIL_SECONDS: f64 = 10.0;
/// FTP as a share of the best one-minute power on a ramp.
pub const FTP_SHARE: f64 = 0.75;
/// A step counts as reached once held this long (its first seconds still carry the last one's power).
pub const STEP_HELD_S: f64 = 15.0;

/// How a ramp test ended.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RampResult {
    /// The rider's functional threshold power, watts (rounded); 0 after less than a minute of ramp.
    pub ftp_w: f64,
    /// Best average power over sixty seconds, watts.
    pub best_minute_w: f64,
    /// The highest step target the rider held for [`STEP_HELD_S`], watts.
    pub last_step_w: f64,
    /// Seconds from the end of the warm-up to the end of the test.
    pub ramp_s: f64,
}

/// Follows a ramp test second by second.
#[derive(Clone, Debug, Default)]
pub struct RampTracker {
    /// Power of each whole second ridden so far in the ramp (warm-up excluded), newest last.
    seconds: Vec<f64>,
    acc_ws: f64,
    acc_s: f64,
    below_s: f64,
    best_minute_w: f64,
    last_step_w: f64,
    /// The step being held, and for how long.
    step_w: f64,
    step_held_s: f64,
}

impl RampTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds `dt` seconds at `power_w` against the step target `target_w`. `in_ramp` is false
    /// during the warm-up, which neither counts nor ends the test. Returns the result once
    /// the rider has stayed below [`FAIL_SHARE`] of the target for [`FAIL_SECONDS`].
    pub fn feed(&mut self, dt: f64, power_w: f64, target_w: f64, in_ramp: bool) -> Option<RampResult> {
        if !in_ramp || dt <= 0.0 {
            return None;
        }
        self.acc_ws += power_w * dt;
        self.acc_s += dt;
        while self.acc_s >= 1.0 {
            // Split the tick at the second's end: the remainder belongs to the next one.
            let over = self.acc_s - 1.0;
            let whole = self.acc_ws - power_w * over;
            self.seconds.push(whole);
            self.acc_ws = power_w * over;
            self.acc_s = over;
            if self.seconds.len() >= 60 {
                let n = self.seconds.len();
                let minute = self.seconds[n - 60..].iter().sum::<f64>() / 60.0;
                self.best_minute_w = self.best_minute_w.max(minute);
            }
        }
        if target_w != self.step_w {
            self.step_w = target_w;
            self.step_held_s = 0.0;
        }
        if power_w < FAIL_SHARE * target_w {
            self.below_s += dt;
        } else {
            self.below_s = 0.0;
            self.step_held_s += dt;
            if self.step_held_s >= STEP_HELD_S {
                self.last_step_w = self.last_step_w.max(target_w);
            }
        }
        (self.below_s >= FAIL_SECONDS).then(|| self.result())
    }

    /// The result as it stands (the test ended some other way: the rider stopped it, or rode
    /// every step).
    pub fn result(&self) -> RampResult {
        // Under a minute of ramp there is no best minute and no FTP to give: the mean power.
        let full = self.seconds.len() >= 60;
        let best = if full {
            self.best_minute_w
        } else if self.seconds.is_empty() {
            0.0
        } else {
            self.seconds.iter().sum::<f64>() / self.seconds.len() as f64
        };
        RampResult {
            ftp_w: if full { (best * FTP_SHARE).round() } else { 0.0 },
            best_minute_w: best.round(),
            last_step_w: self.last_step_w,
            ramp_s: self.seconds.len() as f64 + self.acc_s,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rides a ramp from 100 W up by 20 W a minute, holding every step up to `limit_w` and
    /// then dropping to `fade_w`.
    fn ride(limit_w: f64, fade_w: f64) -> (RampResult, f64) {
        let mut t = RampTracker::new();
        let dt = 0.25;
        let mut clock = 0.0;
        loop {
            let target = 100.0 + 20.0 * (clock / 60.0f64).floor();
            let power = if target <= limit_w { target } else { fade_w };
            if let Some(r) = t.feed(dt, power, target, true) {
                return (r, clock);
            }
            clock += dt;
            assert!(clock < 3600.0, "never ended");
        }
    }

    #[test]
    fn ftp_is_three_quarters_of_the_best_minute() {
        // Holds up to 340 W (13 steps), then gives out.
        let (r, clock) = ride(340.0, 150.0);
        assert_eq!(r.best_minute_w, 340.0);
        assert_eq!(r.ftp_w, 255.0);
        assert_eq!(r.last_step_w, 340.0);
        // Ended ten seconds into the 360 W step.
        assert!((clock - (13.0 * 60.0 + 10.0)).abs() < 0.5, "{clock}");
    }

    #[test]
    fn a_short_dip_does_not_end_it_and_the_warm_up_does_not_count() {
        let mut t = RampTracker::new();
        // Ten minutes of warm-up far below target: nothing happens.
        for _ in 0..2400 {
            assert!(t.feed(0.25, 50.0, 100.0, false).is_none());
        }
        // Eight seconds of soft pedalling in the ramp, then back on: still going.
        for _ in 0..32 {
            assert!(t.feed(0.25, 60.0, 200.0, true).is_none());
        }
        for _ in 0..400 {
            assert!(t.feed(0.25, 200.0, 200.0, true).is_none());
        }
        assert_eq!(t.result().last_step_w, 200.0);
        assert!(t.result().ramp_s > 100.0);
    }
}
