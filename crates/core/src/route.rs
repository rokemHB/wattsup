//! Routes: the virtual road the rider moves along.
//!
//! A route is a polyline sampled at even spacing from a few control points
//! (Catmull-Rom spline), with an elevation per point. The session reads the
//! road grade from it as distance accumulates; the UI draws it. Keeping the
//! geometry here, not in the UI, means a later multiplayer server can run the
//! same world.

use serde::{Deserialize, Serialize};

/// One sample on the route. `x` and `z` are ground coordinates in metres,
/// `y` is elevation. `distance_m` is the distance ridden to reach the point.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoutePoint {
    pub distance_m: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Route {
    pub name: String,
    /// Evenly spaced, first point at distance 0.
    pub points: Vec<RoutePoint>,
    /// The last point joins the first: ride laps.
    pub closed: bool,
    /// Id of the real-world terrain this route lies in (`ui/public/worlds/<id>.json`),
    /// or `None` for a procedural world.
    #[serde(default)]
    pub world: Option<String>,
    /// Flown, not ridden (the electric plane over the Tramuntana): the points' heights are the
    /// plane's altitude, the engine flies it level ([`Route::grade_at`] is 0) and
    /// [`FLIGHT_SPEED_FACTOR`] times as fast as a bike.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub flight: bool,
}

/// How much faster than a bike the plane goes for the same watts.
pub const FLIGHT_SPEED_FACTOR: f64 = 3.0;

/// Ids accepted by [`Route::builtin`].
pub const BUILTIN_ROUTES: [&str; 6] = [
    "sa-calobra",
    "malaga-colmenar",
    "lakeside",
    "flat",
    "tramuntana-flight",
    "tramuntana-flight-back",
];

/// What a route chooser needs to know, without the points.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RouteInfo {
    pub id: String,
    pub name: String,
    pub length_m: f64,
    /// Metres of climbing over the whole route.
    pub climb_m: f64,
    pub closed: bool,
    pub world: Option<String>,
    /// Flown by the electric plane, not ridden.
    #[serde(default)]
    pub flight: bool,
}

/// A hand-placed control point: ground position and elevation, in metres.
#[derive(Clone, Copy, Debug)]
pub struct ControlPoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// Window over which the grade is measured, so sampling noise does not
/// become resistance noise. Half-width in metres.
const GRADE_WINDOW_M: f64 = 15.0;

impl Route {
    /// Samples a smooth path through `control` every `spacing_m`.
    pub fn from_control_points(name: &str, control: &[ControlPoint], spacing_m: f64, closed: bool) -> Self {
        assert!(control.len() >= 4, "a route needs at least four control points");
        assert!(spacing_m > 0.0);
        let n = control.len();
        let segments = if closed { n } else { n - 1 };
        // Dense pass first, then resample by arc length.
        let mut dense: Vec<ControlPoint> = Vec::new();
        for s in 0..segments {
            let idx = |k: isize| -> ControlPoint {
                let i = s as isize + k;
                if closed {
                    control[i.rem_euclid(n as isize) as usize]
                } else {
                    control[i.clamp(0, n as isize - 1) as usize]
                }
            };
            let (p0, p1, p2, p3) = (idx(-1), idx(0), idx(1), idx(2));
            let steps = 64;
            for k in 0..steps {
                let t = k as f64 / steps as f64;
                dense.push(ControlPoint {
                    x: catmull_rom(p0.x, p1.x, p2.x, p3.x, t),
                    y: catmull_rom(p0.y, p1.y, p2.y, p3.y, t),
                    z: catmull_rom(p0.z, p1.z, p2.z, p3.z, t),
                });
            }
        }
        if closed {
            dense.push(control[0]);
        } else {
            dense.push(control[n - 1]);
        }

        let mut points = vec![RoutePoint {
            distance_m: 0.0,
            x: dense[0].x,
            y: dense[0].y,
            z: dense[0].z,
        }];
        let mut travelled = 0.0;
        let mut next = spacing_m;
        for w in dense.windows(2) {
            let (a, b) = (w[0], w[1]);
            let seg = ((b.x - a.x).powi(2) + (b.z - a.z).powi(2)).sqrt();
            while travelled + seg >= next && seg > 0.0 {
                let t = (next - travelled) / seg;
                points.push(RoutePoint {
                    distance_m: next,
                    x: a.x + (b.x - a.x) * t,
                    y: a.y + (b.y - a.y) * t,
                    z: a.z + (b.z - a.z) * t,
                });
                next += spacing_m;
            }
            travelled += seg;
        }
        Self {
            name: name.to_string(),
            points,
            closed,
            world: None,
            flight: false,
        }
    }

    /// Metres of climbing over the whole route.
    pub fn climb_m(&self) -> f64 {
        self.points.windows(2).map(|w| (w[1].y - w[0].y).max(0.0)).sum()
    }

    pub fn info(&self, id: &str) -> RouteInfo {
        RouteInfo {
            id: id.to_string(),
            name: self.name.clone(),
            length_m: self.length_m(),
            climb_m: self.climb_m(),
            closed: self.closed,
            world: self.world.clone(),
            flight: self.flight,
        }
    }

    /// All routes shipped with the app.
    pub fn builtin_list() -> Vec<RouteInfo> {
        BUILTIN_ROUTES
            .iter()
            .filter_map(|id| Self::builtin(id).map(|r| r.info(id)))
            .collect()
    }

    /// A route shipped with the app, by id (see [`BUILTIN_ROUTES`]).
    pub fn builtin(id: &str) -> Option<Self> {
        match id {
            "lakeside" => Some(Self::demo()),
            "flat" => Some(Self::flat()),
            "sa-calobra" => {
                Some(serde_json::from_str(include_str!("../routes/sa-calobra.json")).expect("valid built-in route"))
            }
            "malaga-colmenar" => Some(
                serde_json::from_str(include_str!("../routes/malaga-colmenar.json")).expect("valid built-in route"),
            ),
            "tramuntana-flight" => Some(
                serde_json::from_str(include_str!("../routes/tramuntana-flight.json")).expect("valid built-in route"),
            ),
            "tramuntana-flight-back" => Some(
                serde_json::from_str(include_str!("../routes/tramuntana-flight-back.json"))
                    .expect("valid built-in route"),
            ),
            _ => None,
        }
    }

    pub fn length_m(&self) -> f64 {
        self.points.last().map_or(0.0, |p| p.distance_m)
    }

    /// Distance within the current lap, and the lap number (0-based).
    pub fn lap_position(&self, distance_m: f64) -> (f64, u32) {
        let len = self.length_m();
        if len <= 0.0 {
            return (0.0, 0);
        }
        if self.closed {
            let lap = (distance_m / len).floor().max(0.0);
            (distance_m - lap * len, lap as u32)
        } else {
            (distance_m.clamp(0.0, len), 0)
        }
    }

    /// Elevation at a distance along the route (linear between samples).
    pub fn elevation_at(&self, distance_m: f64) -> f64 {
        let (d, _) = self.lap_position(distance_m);
        let (i, t) = self.index_at(d);
        let a = self.points[i].y;
        let b = self.points[(i + 1).min(self.points.len() - 1)].y;
        a + (b - a) * t
    }

    /// Position (x, y, z) at a distance along the route (linear between samples).
    pub fn position_at(&self, distance_m: f64) -> (f64, f64, f64) {
        if self.points.is_empty() {
            return (0.0, 0.0, 0.0);
        }
        let (d, _) = self.lap_position(distance_m);
        let (i, t) = self.index_at(d);
        let a = &self.points[i];
        let b = &self.points[(i + 1).min(self.points.len() - 1)];
        (a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t)
    }

    /// Road grade in percent at a distance, averaged over a short window.
    pub fn grade_at(&self, distance_m: f64) -> f64 {
        if self.points.len() < 2 || self.flight {
            return 0.0;
        }
        let len = self.length_m();
        let (d, _) = self.lap_position(distance_m);
        // Closed routes wrap the window round the lap; open ones stop at the ends.
        let (lo, hi) = if self.closed {
            (
                (d - GRADE_WINDOW_M).rem_euclid(len),
                (d + GRADE_WINDOW_M).rem_euclid(len),
            )
        } else {
            ((d - GRADE_WINDOW_M).max(0.0), (d + GRADE_WINDOW_M).min(len))
        };
        let rise = self.elevation_at(lo) - self.elevation_at(hi);
        let run = if self.closed { 2.0 * GRADE_WINDOW_M } else { hi - lo };
        if run <= 0.0 {
            0.0
        } else {
            -rise / run * 100.0
        }
    }

    fn index_at(&self, d: f64) -> (usize, f64) {
        let spacing = self.points.get(1).map_or(1.0, |p| p.distance_m);
        let raw = d / spacing;
        let i = (raw.floor() as usize).min(self.points.len().saturating_sub(2));
        (i, (raw - i as f64).clamp(0.0, 1.0))
    }

    /// A flat 5 km loop for workouts: nothing to shift for, nothing to look at.
    pub fn flat() -> Self {
        let c = |x: f64, z: f64| ControlPoint { x, y: 12.0, z };
        let control = [
            c(0.0, 0.0),
            c(700.0, -80.0),
            c(1400.0, 100.0),
            c(1700.0, 500.0),
            c(1500.0, 900.0),
            c(900.0, 1050.0),
            c(200.0, 950.0),
            c(-200.0, 500.0),
        ];
        let mut route = Self::from_control_points("Flat road", &control, 5.0, true);
        route.points.iter_mut().for_each(|p| p.y = 12.0);
        route
    }

    /// The built-in demo course: a 6 km lakeside loop with one real climb.
    pub fn demo() -> Self {
        let c = |x: f64, z: f64, y: f64| ControlPoint { x, y, z };
        // Clockwise loop, roughly 1.6 × 1.2 km. Elevation in metres.
        let control = [
            c(0.0, 0.0, 10.0),
            c(400.0, -60.0, 12.0),
            c(800.0, -40.0, 18.0),
            c(1150.0, 120.0, 40.0),
            c(1350.0, 420.0, 75.0),
            c(1300.0, 700.0, 105.0),
            c(1050.0, 900.0, 118.0),
            c(700.0, 1000.0, 95.0),
            c(350.0, 1050.0, 60.0),
            c(50.0, 900.0, 35.0),
            c(-150.0, 600.0, 22.0),
            c(-200.0, 300.0, 14.0),
        ];
        Self::from_control_points("Lakeside loop", &control, 5.0, true)
    }
}

fn catmull_rom(p0: f64, p1: f64, p2: f64, p3: f64, t: f64) -> f64 {
    let t2 = t * t;
    let t3 = t2 * t;
    0.5 * ((2.0 * p1)
        + (-p0 + p2) * t
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_route_is_a_sensible_loop() {
        let r = Route::demo();
        let len = r.length_m();
        assert!(len > 4000.0 && len < 8000.0, "{len}");
        assert!(r.closed);
        let spacing: Vec<f64> = r.points.windows(2).map(|w| w[1].distance_m - w[0].distance_m).collect();
        assert!(spacing.iter().all(|s| (s - 5.0).abs() < 1e-9));
        // Samples really are ~5 m apart on the ground.
        for w in r.points.windows(2) {
            let d = ((w[1].x - w[0].x).powi(2) + (w[1].z - w[0].z).powi(2)).sqrt();
            assert!((d - 5.0).abs() < 0.2, "{d}");
        }
        // Grades stay within what a trainer can simulate.
        let mut max = f64::MIN;
        let mut min = f64::MAX;
        let mut d = 0.0;
        while d < len {
            let g = r.grade_at(d);
            max = max.max(g);
            min = min.min(g);
            d += 10.0;
        }
        assert!(max > 5.0 && max < 15.0, "steepest {max}");
        assert!(min < -4.0 && min > -15.0, "fastest descent {min}");
    }

    #[test]
    fn malaga_colmenar_climbs_over_the_puerto_del_leon() {
        // A 5 km flat warm-up, the A-7000 over the Puerto del León, down to Riogordo.
        let r = Route::builtin("malaga-colmenar").unwrap();
        assert_eq!(r.world.as_deref(), Some("malaga-colmenar"));
        assert!((r.length_m() - 43160.0).abs() < 300.0, "{}", r.length_m());
        let flat = r
            .points
            .iter()
            .filter(|p| p.distance_m < 4900.0)
            .map(|p| p.y)
            .collect::<Vec<_>>();
        assert!(flat.iter().all(|y| (y - flat[0]).abs() < 0.5), "the warm-up is flat");
        let top = r.points.iter().max_by(|a, b| a.y.total_cmp(&b.y)).unwrap();
        assert!(top.y > 900.0 && top.y < 1000.0, "summit at {} m", top.y);
        assert!(
            top.distance_m > 24000.0 && top.distance_m < 26500.0,
            "summit at {} m along",
            top.distance_m
        );
        let end = r.points.last().unwrap().y;
        assert!(end > 380.0 && end < 450.0, "Riogordo at {end} m");
    }

    #[test]
    fn sa_calobra_is_the_real_climb() {
        let r = Route::builtin("sa-calobra").unwrap();
        assert!(!r.closed);
        assert_eq!(r.world.as_deref(), Some("sa-calobra"));
        let len = r.length_m();
        assert!(len > 9000.0 && len < 11000.0, "{len}");
        let (bottom, top) = (r.points[0].y, r.points.last().unwrap().y);
        assert!(top - bottom > 600.0 && top - bottom < 760.0, "{bottom} -> {top}");
        let mut d = 0.0;
        while d < len {
            let g = r.grade_at(d);
            assert!(g > -12.0 && g < 16.0, "{d} m: {g} %");
            d += 25.0;
        }
        assert_eq!(r.lap_position(len + 500.0), (len, 0), "a climb does not lap");
        assert!(Route::builtin("nope").is_none());
        for id in BUILTIN_ROUTES {
            assert!(Route::builtin(id).is_some(), "{id}");
        }
        let list = Route::builtin_list();
        assert_eq!(list.len(), 6);
        assert!(list[3].climb_m < 1.0 && list[3].closed, "{:?}", list[3]);
        assert_eq!(list[0].id, "sa-calobra");
        assert!(
            list[0].climb_m > 650.0 && list[0].climb_m < 760.0,
            "{}",
            list[0].climb_m
        );
        assert!(!list[1].closed && list[1].id == "malaga-colmenar");
        assert!(list[2].closed);
        assert!(list[4].flight && list[5].flight && !list[0].flight);
    }

    #[test]
    fn flights_are_level_and_go_both_ways() {
        let there = Route::builtin("tramuntana-flight").unwrap();
        let back = Route::builtin("tramuntana-flight-back").unwrap();
        assert!(there.flight && there.world.as_deref() == Some("mallorca"));
        assert!((there.length_m() - back.length_m()).abs() < 1.0);
        let (a, b) = (there.points.first().unwrap(), back.points.last().unwrap());
        assert!(
            (a.x - b.x).abs() < 0.1 && (a.z - b.z).abs() < 0.1,
            "the way back ends where the way there starts"
        );
        // Climbing 1 km of altitude on the way, yet flown level.
        assert!(there.climb_m() > 1000.0);
        let mut d = 0.0;
        while d < there.length_m() {
            assert_eq!(there.grade_at(d), 0.0);
            d += 500.0;
        }
    }

    #[test]
    fn laps_wrap_and_elevation_matches_points() {
        let r = Route::demo();
        let len = r.length_m();
        assert_eq!(r.lap_position(len + 100.0), (100.0, 1));
        assert_eq!(r.lap_position(-5.0).1, 0);
        assert!((r.elevation_at(0.0) - 10.0).abs() < 1e-9);
        assert!((r.elevation_at(len) - r.elevation_at(0.0)).abs() < 1e-6, "loop closes");
        assert!((r.elevation_at(2.5) - (r.points[0].y + r.points[1].y) / 2.0).abs() < 1e-9);
    }

    #[test]
    fn straight_ramp_has_constant_grade() {
        let c = |x: f64, y: f64| ControlPoint { x, y, z: 0.0 };
        let r = Route::from_control_points(
            "ramp",
            &[c(0.0, 0.0), c(100.0, 5.0), c(200.0, 10.0), c(300.0, 15.0)],
            5.0,
            false,
        );
        assert!(!r.closed);
        for d in [20.0, 100.0, 250.0] {
            assert!((r.grade_at(d) - 5.0).abs() < 0.2, "{d}: {}", r.grade_at(d));
        }
        assert_eq!(r.lap_position(999.0), (r.length_m(), 0));
    }
}
