//! Road networks: a graph of roads with sampled geometry and elevation, and
//! a navigator that turns the rider's choices at junctions into a linear
//! [`Route`] the session can ride. Built by `tools/build_network.py`.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::route::{Route, RoutePoint};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sign {
    pub edge: usize,
    #[serde(rename = "ref")]
    pub road_ref: Option<String>,
    pub to: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NetworkNode {
    pub x: f64,
    pub z: f64,
    pub y: f64,
    #[serde(default)]
    pub signs: Option<Vec<Sign>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NetworkEdge {
    pub a: usize,
    pub b: usize,
    #[serde(rename = "ref")]
    pub road_ref: Option<String>,
    pub name: Option<String>,
    /// 0 primary, 1 secondary, 2 tertiary, 3 unclassified.
    pub kind: u8,
    /// First point and number of points in the network's point array.
    pub start: usize,
    pub count: usize,
    pub length_m: f64,
    /// The road runs through a tunnel: no corridor is cut and a tube is drawn around it.
    #[serde(default)]
    pub tunnel: bool,
    /// Confirmation signs along the edge (the renderer places them).
    #[serde(default)]
    pub markers: Vec<Marker>,
}

/// A confirmation sign between junctions: at edge-local point `at`, for riders
/// heading toward `b` (or `a`), the next towns with their distance in km.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Marker {
    pub at: usize,
    pub toward_b: bool,
    pub to: Vec<(String, f64)>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Place {
    pub name: String,
    pub kind: String,
    pub x: f64,
    pub z: f64,
}

#[derive(Clone, Debug, Deserialize)]
struct NetworkFile {
    name: String,
    origin: Origin,
    nodes: Vec<NetworkNode>,
    edges: Vec<NetworkEdge>,
    #[serde(default)]
    places: Vec<Place>,
    points: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Origin {
    pub lat: f64,
    pub lon: f64,
}

#[derive(Clone, Debug)]
pub struct Network {
    pub name: String,
    pub origin: Origin,
    pub nodes: Vec<NetworkNode>,
    pub edges: Vec<NetworkEdge>,
    pub places: Vec<Place>,
    /// x, y (elevation), z per point.
    pub points: Vec<[f32; 3]>,
    /// Edge ids touching each node.
    pub adjacency: Vec<Vec<usize>>,
}

/// What a map screen needs: everything but the points, which come separately as bytes.
#[derive(Clone, Debug, Serialize)]
pub struct NetworkInfo {
    pub name: String,
    pub origin: Origin,
    pub nodes: Vec<NetworkNode>,
    pub edges: Vec<NetworkEdge>,
    pub places: Vec<Place>,
    pub points: usize,
}

static MALLORCA: OnceLock<Option<Network>> = OnceLock::new();

impl Network {
    /// Parses the two files `build_network.py` writes.
    pub fn parse(json: &str, points: &[u8]) -> Result<Self, String> {
        let file: NetworkFile = serde_json::from_str(json).map_err(|e| e.to_string())?;
        if points.len() != file.points * 12 {
            return Err(format!(
                "point data has {} bytes, expected {}",
                points.len(),
                file.points * 12
            ));
        }
        let pts = points
            .chunks_exact(12)
            .map(|c| {
                let f = |i: usize| f32::from_le_bytes([c[i], c[i + 1], c[i + 2], c[i + 3]]);
                [f(0), f(4), f(8)]
            })
            .collect();
        let mut adjacency = vec![Vec::new(); file.nodes.len()];
        for (i, e) in file.edges.iter().enumerate() {
            adjacency[e.a].push(i);
            adjacency[e.b].push(i);
        }
        Ok(Self {
            name: file.name,
            origin: file.origin,
            nodes: file.nodes,
            edges: file.edges,
            places: file.places,
            points: pts,
            adjacency,
        })
    }

    /// The network shipped for a world id, parsed once.
    pub fn builtin(world: &str) -> Option<&'static Network> {
        match world {
            "mallorca" => MALLORCA
                .get_or_init(|| {
                    Self::parse(
                        include_str!("../worlds/mallorca/network.json"),
                        include_bytes!("../worlds/mallorca/network.bin"),
                    )
                    .map_err(|e| log_err(&e))
                    .ok()
                })
                .as_ref(),
            _ => None,
        }
    }

    pub fn info(&self) -> NetworkInfo {
        NetworkInfo {
            name: self.name.clone(),
            origin: self.origin,
            nodes: self.nodes.clone(),
            edges: self.edges.clone(),
            places: self.places.clone(),
            points: self.points.len(),
        }
    }

    /// Point bytes as the file holds them, for a UI that draws the roads.
    pub fn point_bytes(&self) -> Vec<u8> {
        self.points
            .iter()
            .flat_map(|p| p.iter().flat_map(|v| v.to_le_bytes()))
            .collect()
    }

    /// The nearest road point to a ground position: edge and index within it.
    pub fn nearest(&self, x: f64, z: f64) -> Option<(usize, usize)> {
        let mut best = (f64::INFINITY, 0, 0);
        for (ei, e) in self.edges.iter().enumerate() {
            for i in 0..e.count {
                let p = self.points[e.start + i];
                let d = (p[0] as f64 - x).powi(2) + (p[2] as f64 - z).powi(2);
                if d < best.0 {
                    best = (d, ei, i);
                }
            }
        }
        (best.0.is_finite()).then_some((best.1, best.2))
    }

    pub fn other_end(&self, edge: usize, node: usize) -> usize {
        let e = &self.edges[edge];
        if e.a == node {
            e.b
        } else {
            e.a
        }
    }

    /// Bearing (radians, x east, z south) of an edge leaving `node`, measured over its first 30 m.
    pub fn heading_out(&self, edge: usize, node: usize) -> f64 {
        let e = &self.edges[edge];
        let forward = e.a == node;
        let n = e.count;
        let k = 3.min(n - 1);
        let (p0, p1) = if forward {
            (self.points[e.start], self.points[e.start + k])
        } else {
            (self.points[e.start + n - 1], self.points[e.start + n - 1 - k])
        };
        ((p1[2] - p0[2]) as f64).atan2((p1[0] - p0[0]) as f64)
    }

    /// Bearing of an edge arriving at `node`.
    pub fn heading_in(&self, edge: usize, node: usize) -> f64 {
        let from = self.other_end(edge, node);
        // Arriving heading = direction of travel at the node = opposite of leaving back the way we came.
        self.heading_out(edge, node) + std::f64::consts::PI
            - (self.heading_out(edge, node) - self.heading_out(edge, from) + std::f64::consts::PI)
                .rem_euclid(2.0 * std::f64::consts::PI)
            + std::f64::consts::PI
    }

    /// The edge a rider would naturally continue on at `node`, coming from `from_edge`:
    /// the same road number if it continues, else the straightest option.
    pub fn default_continuation(&self, node: usize, from_edge: usize) -> Option<usize> {
        let arriving = self.arrival_heading(from_edge, node);
        let same_ref = self.edges[from_edge].road_ref.clone();
        self.adjacency[node]
            .iter()
            .copied()
            .filter(|&e| e != from_edge)
            .map(|e| {
                let turn = angle_diff(self.heading_out(e, node), arriving).abs();
                let bonus = if same_ref.is_some() && self.edges[e].road_ref == same_ref {
                    1.0
                } else {
                    0.0
                };
                (turn - bonus, e)
            })
            .min_by(|a, b| a.0.partial_cmp(&b.0).unwrap())
            .map(|(_, e)| e)
    }

    /// Direction of travel when arriving at `node` along `edge`.
    pub fn arrival_heading(&self, edge: usize, node: usize) -> f64 {
        let e = &self.edges[edge];
        let n = e.count;
        let k = 3.min(n - 1);
        let (p0, p1) = if e.b == node {
            (self.points[e.start + n - 1 - k], self.points[e.start + n - 1])
        } else {
            (self.points[e.start + k], self.points[e.start])
        };
        ((p1[2] - p0[2]) as f64).atan2((p1[0] - p0[0]) as f64)
    }
}

fn log_err(e: &str) -> String {
    eprintln!("network: {e}");
    e.to_string()
}

/// Signed difference a - b in (-π, π].
fn angle_diff(a: f64, b: f64) -> f64 {
    let d = (a - b).rem_euclid(2.0 * std::f64::consts::PI);
    if d > std::f64::consts::PI {
        d - 2.0 * std::f64::consts::PI
    } else {
        d
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Turn {
    SharpLeft,
    Left,
    Straight,
    Right,
    SharpRight,
    UTurn,
}

impl Turn {
    /// From the signed turn angle in degrees (positive = right, in an x-east z-south frame).
    pub fn from_degrees(deg: f64) -> Self {
        let a = deg.abs();
        if a < 25.0 {
            Turn::Straight
        } else if a > 160.0 {
            Turn::UTurn
        } else if a > 110.0 {
            if deg > 0.0 {
                Turn::SharpRight
            } else {
                Turn::SharpLeft
            }
        } else if deg > 0.0 {
            Turn::Right
        } else {
            Turn::Left
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TurnOption {
    pub edge: usize,
    pub turn: Turn,
    pub angle_deg: f64,
    #[serde(rename = "ref")]
    pub road_ref: Option<String>,
    pub to: Vec<String>,
    pub chosen: bool,
}

/// The next junction a planned route takes, however far ahead: for a navigation display.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Maneuver {
    /// Route distance at which the junction lies.
    pub at_m: f64,
    pub turn: Turn,
    #[serde(rename = "ref")]
    pub road_ref: Option<String>,
    /// Sign destinations of the road taken.
    pub to: Vec<String>,
}

/// The next junction ahead of the rider.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Junction {
    pub node: usize,
    /// Route distance at which the junction lies.
    pub at_m: f64,
    /// Options from left to right.
    pub options: Vec<TurnOption>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Leg {
    edge: usize,
    /// Riding from `a` to `b`.
    forward: bool,
    /// Index of the first point ridden on this edge (only the first leg starts mid-edge).
    from_index: usize,
    /// Index of the last point ridden on this edge (only a planned route's last leg ends mid-edge).
    to_index: usize,
}

impl Leg {
    fn full(net: &Network, edge: usize, forward: bool) -> Self {
        let n = net.edges[edge].count;
        Self {
            edge,
            forward,
            from_index: if forward { 0 } else { n - 1 },
            to_index: if forward { n - 1 } else { 0 },
        }
    }

    /// The points of this leg in riding order.
    fn points<'a>(&self, net: &'a Network) -> Box<dyn Iterator<Item = &'a [f32; 3]> + 'a> {
        let e = &net.edges[self.edge];
        let pts = &net.points[e.start..e.start + e.count];
        if self.forward {
            Box::new(pts[self.from_index..=self.to_index].iter())
        } else {
            Box::new(pts[self.to_index..=self.from_index].iter().rev())
        }
    }

    /// Whether the leg runs all the way to the edge's end node (where a junction may be).
    fn ends_at_node(&self, net: &Network) -> bool {
        self.to_index
            == if self.forward {
                net.edges[self.edge].count - 1
            } else {
                0
            }
    }
}

/// One edge of a route planned on the map, with the local point indices it is ridden between (inclusive).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct PlannedLeg {
    pub edge: usize,
    pub forward: bool,
    pub from: usize,
    pub to: usize,
}

/// Turns legs through the network into the route the session rides, and
/// extends or re-plans it as the rider goes.
#[derive(Clone, Debug)]
pub struct Navigator {
    world: String,
    legs: Vec<Leg>,
    /// Route spacing in metres.
    spacing: f64,
    /// A route planned on the map: it ends where it ends instead of growing ahead of the rider.
    planned: bool,
    name: Option<String>,
}

/// Keep at least this much road planned ahead of the rider.
pub const PLAN_AHEAD_M: f64 = 6000.0;

impl Navigator {
    /// Starts on `edge` at point `index`, riding toward `b` if `forward`.
    pub fn start(world: &str, net: &Network, edge: usize, index: usize, forward: bool) -> Self {
        let n = net.edges[edge].count;
        let mut nav = Self {
            world: world.to_string(),
            legs: vec![Leg {
                edge,
                forward,
                from_index: index,
                to_index: if forward { n - 1 } else { 0 },
            }],
            spacing: 5.0,
            planned: false,
            name: None,
        };
        nav.extend(net, PLAN_AHEAD_M * 2.0);
        nav
    }

    /// A route planned on the map: `legs` must index the network and join end to start.
    /// The ride finishes at the last leg's end instead of growing ahead of the rider.
    pub fn planned(world: &str, net: &Network, name: &str, legs: &[PlannedLeg]) -> Result<Self, String> {
        if legs.is_empty() {
            return Err("an empty route".into());
        }
        let mut out = Vec::with_capacity(legs.len());
        for (k, l) in legs.iter().enumerate() {
            let e = net.edges.get(l.edge).ok_or_else(|| format!("no edge {}", l.edge))?;
            if l.from >= e.count || l.to >= e.count || (l.forward && l.from > l.to) || (!l.forward && l.to > l.from) {
                return Err(format!(
                    "leg {k} runs {}..{} on an edge of {} points",
                    l.from, l.to, e.count
                ));
            }
            let leg = Leg {
                edge: l.edge,
                forward: l.forward,
                from_index: l.from,
                to_index: l.to,
            };
            if let Some(prev) = out.last() {
                let prev: &Leg = prev;
                let end = *prev.points(net).last().unwrap();
                let start = *leg.points(net).next().unwrap();
                let gap = ((end[0] - start[0]) as f64).hypot((end[2] - start[2]) as f64);
                if gap > 1.0 {
                    return Err(format!("leg {k} starts {gap:.0} m from where leg {} ends", k - 1));
                }
            }
            out.push(leg);
        }
        if out.iter().map(|l| l.points(net).count()).sum::<usize>() < 2 {
            return Err("a route of a single point".into());
        }
        Ok(Self {
            world: world.to_string(),
            legs: out,
            spacing: 5.0,
            planned: true,
            name: Some(name.to_string()),
        })
    }

    pub fn is_planned(&self) -> bool {
        self.planned
    }

    pub fn world(&self) -> &str {
        &self.world
    }

    fn leg_end_node(&self, net: &Network, leg: &Leg) -> usize {
        let e = &net.edges[leg.edge];
        if leg.forward {
            e.b
        } else {
            e.a
        }
    }

    /// Appends default continuations until at least `ahead_m` of road is planned beyond the current end.
    fn extend(&mut self, net: &Network, ahead_m: f64) {
        let mut added = 0.0;
        while added < ahead_m {
            let last = *self.legs.last().unwrap();
            if self.planned || !last.ends_at_node(net) {
                break; // the planned destination
            }
            let node = self.leg_end_node(net, &last);
            let Some(next) = net.default_continuation(node, last.edge) else {
                break; // dead end
            };
            let forward = net.edges[next].a == node;
            self.legs.push(Leg::full(net, next, forward));
            added += net.edges[next].length_m;
            if self.legs.len() > 400 {
                break;
            }
        }
    }

    /// Raw polyline of all legs, in order.
    fn polyline(&self, net: &Network) -> Vec<[f32; 3]> {
        let mut out: Vec<[f32; 3]> = Vec::new();
        for (li, leg) in self.legs.iter().enumerate() {
            for (k, p) in leg.points(net).enumerate() {
                if li > 0 && k == 0 {
                    continue; // the junction node is already the previous leg's last point
                }
                out.push(*p);
            }
        }
        out
    }

    /// The route for the session: the planned legs resampled evenly.
    pub fn route(&self, net: &Network) -> Route {
        let poly = self.polyline(net);
        let name = self.name.clone().unwrap_or_else(|| {
            self.legs
                .first()
                .and_then(|l| net.edges[l.edge].road_ref.clone())
                .unwrap_or_else(|| net.name.clone())
        });
        Route::from_polyline(&name, &poly, self.spacing, Some(self.world.clone()))
    }

    /// Route distance at which each leg ends (the junction after it).
    fn leg_ends(&self, net: &Network) -> Vec<f64> {
        let mut ends = Vec::with_capacity(self.legs.len());
        let mut d = 0.0;
        for leg in &self.legs {
            let slice: Vec<[f32; 3]> = leg.points(net).copied().collect();
            for w in slice.windows(2) {
                d += ((w[1][0] - w[0][0]) as f64).hypot((w[1][2] - w[0][2]) as f64);
            }
            ends.push(d);
        }
        ends
    }

    /// Makes sure the plan reaches well beyond `distance_m`. Returns true when the route changed.
    pub fn keep_ahead(&mut self, net: &Network, distance_m: f64) -> bool {
        if self.planned {
            return false;
        }
        let planned = self.leg_ends(net).last().copied().unwrap_or(0.0);
        if planned - distance_m < PLAN_AHEAD_M {
            let before = self.legs.len();
            self.extend(net, PLAN_AHEAD_M * 2.0);
            return self.legs.len() != before;
        }
        false
    }

    /// The next junction (a node with a choice) ahead of `distance_m`, within `lookahead_m`.
    pub fn junction(&self, net: &Network, distance_m: f64, lookahead_m: f64) -> Option<Junction> {
        for (li, at) in self.leg_ends(net).into_iter().enumerate() {
            if at < distance_m - 5.0 {
                continue;
            }
            if at - distance_m > lookahead_m {
                return None;
            }
            if let Some(j) = self.junction_after(net, li, at) {
                return Some(j);
            }
        }
        None
    }

    /// The next junction the planned route goes through, at any distance; `None` on a free
    /// ride or when only the destination lies ahead.
    pub fn next_maneuver(&self, net: &Network, distance_m: f64) -> Option<Maneuver> {
        if !self.planned {
            return None;
        }
        for (li, at) in self.leg_ends(net).into_iter().enumerate() {
            if at < distance_m - 5.0 {
                continue;
            }
            let Some(j) = self.junction_after(net, li, at) else {
                continue;
            };
            let chosen = j.options.iter().find(|o| o.chosen)?;
            return Some(Maneuver {
                at_m: j.at_m,
                turn: chosen.turn,
                road_ref: chosen.road_ref.clone(),
                to: chosen.to.clone(),
            });
        }
        None
    }

    /// The junction at the end of leg `li` (at route distance `at`), if there is anything to choose there.
    fn junction_after(&self, net: &Network, li: usize, at: f64) -> Option<Junction> {
        let leg = &self.legs[li];
        if !leg.ends_at_node(net) {
            return None; // a planned route's destination, or the point of a U-turn
        }
        let node = self.leg_end_node(net, leg);
        if net.adjacency[node].len() < 3 {
            return None;
        }
        let arriving = net.arrival_heading(leg.edge, node);
        let planned_next = self.legs.get(li + 1).map(|l| l.edge);
        let signs = net.nodes[node].signs.as_deref().unwrap_or(&[]);
        let mut options: Vec<TurnOption> = net.adjacency[node]
            .iter()
            .copied()
            .filter(|&e| e != leg.edge)
            .map(|e| {
                let deg = angle_diff(net.heading_out(e, node), arriving).to_degrees();
                let sign = signs.iter().find(|s| s.edge == e);
                TurnOption {
                    edge: e,
                    turn: Turn::from_degrees(deg),
                    angle_deg: (deg * 10.0).round() / 10.0,
                    road_ref: sign
                        .and_then(|s| s.road_ref.clone())
                        .or_else(|| net.edges[e].road_ref.clone()),
                    to: sign.map(|s| s.to.clone()).unwrap_or_default(),
                    chosen: planned_next == Some(e),
                }
            })
            .collect();
        options.sort_by(|a, b| a.angle_deg.partial_cmp(&b.angle_deg).unwrap());
        // Dual carriageways and slip roads split into pieces that all read the same;
        // there is nothing to decide there, so look further ahead.
        let first = &options[0];
        if options.iter().all(|o| o.road_ref == first.road_ref && o.to == first.to) {
            return None;
        }
        Some(Junction {
            node,
            at_m: at,
            options,
        })
    }

    /// Leaving a planned route turns the rest of it into a free ride, named after the road again.
    fn leave_plan(&mut self) {
        self.planned = false;
        self.name = None;
    }

    /// Turns the rider around where they are: the road behind becomes the road ahead.
    /// On a planned route this ends the plan (the way back is a free ride).
    pub fn turn_around(&mut self, net: &Network, distance_m: f64) {
        let ends = self.leg_ends(net);
        let li = (0..self.legs.len())
            .find(|&i| ends[i] >= distance_m)
            .unwrap_or(self.legs.len() - 1);
        let leg = self.legs[li];
        let leg_start = if li == 0 { 0.0 } else { ends[li - 1] };
        // The point of this leg nearest the rider (points are a few metres apart).
        let pts: Vec<[f32; 3]> = leg.points(net).copied().collect();
        let mut d = 0.0;
        let mut k = 0;
        let mut best = f64::MAX;
        for i in 0..pts.len() {
            if i > 0 {
                d += ((pts[i][0] - pts[i - 1][0]) as f64).hypot((pts[i][2] - pts[i - 1][2]) as f64);
            }
            let gap = (leg_start + d - distance_m).abs();
            if gap < best {
                best = gap;
                k = i;
            }
        }
        let index = if leg.forward {
            leg.from_index + k
        } else {
            leg.from_index - k
        };
        let n = net.edges[leg.edge].count;
        self.legs.truncate(li + 1);
        self.legs[li].to_index = index;
        self.legs.push(Leg {
            edge: leg.edge,
            forward: !leg.forward,
            from_index: index,
            to_index: if leg.forward { 0 } else { n - 1 },
        });
        self.leave_plan();
        self.extend(net, PLAN_AHEAD_M * 2.0);
    }

    /// Takes `edge` at the next junction ahead of `distance_m`. Returns false if that is not an option there.
    pub fn choose(&mut self, net: &Network, distance_m: f64, edge: usize) -> bool {
        let ends = self.leg_ends(net);
        let Some(li) = (0..self.legs.len()).find(|&i| {
            ends[i] >= distance_m - 5.0
                && self.legs[i].ends_at_node(net)
                && net.adjacency[self.leg_end_node(net, &self.legs[i])].len() >= 3
        }) else {
            return false;
        };
        let node = self.leg_end_node(net, &self.legs[li]);
        if !net.adjacency[node].contains(&edge) || edge == self.legs[li].edge {
            return false;
        }
        if self.planned && self.legs.get(li + 1).map(|l| l.edge) == Some(edge) {
            return true; // the planned way: nothing changes
        }
        // Leaving a planned route at a junction turns the rest of it into a free ride.
        if self.planned {
            self.leave_plan();
        }
        self.legs.truncate(li + 1);
        let forward = net.edges[edge].a == node;
        self.legs.push(Leg::full(net, edge, forward));
        self.extend(net, PLAN_AHEAD_M * 2.0);
        true
    }
}

impl Route {
    /// A route along a polyline, resampled every `spacing` metres with linear elevation.
    pub fn from_polyline(name: &str, poly: &[[f32; 3]], spacing: f64, world: Option<String>) -> Self {
        let mut points = Vec::new();
        if poly.is_empty() {
            return Self {
                name: name.into(),
                points,
                closed: false,
                world,
            };
        }
        points.push(RoutePoint {
            distance_m: 0.0,
            x: poly[0][0] as f64,
            y: poly[0][1] as f64,
            z: poly[0][2] as f64,
        });
        let mut travelled = 0.0;
        let mut next = spacing;
        for w in poly.windows(2) {
            let (a, b) = (w[0], w[1]);
            let seg = ((b[0] - a[0]) as f64).hypot((b[2] - a[2]) as f64);
            while seg > 0.0 && travelled + seg >= next {
                let t = (next - travelled) / seg;
                points.push(RoutePoint {
                    distance_m: next,
                    x: a[0] as f64 + (b[0] - a[0]) as f64 * t,
                    y: a[1] as f64 + (b[1] - a[1]) as f64 * t,
                    z: a[2] as f64 + (b[2] - a[2]) as f64 * t,
                });
                next += spacing;
            }
            travelled += seg;
        }
        Self {
            name: name.into(),
            points,
            closed: false,
            world,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A T-junction: a straight road from west to east through node 1, and a branch north from node 1.
    ///      2
    ///      |
    /// 0 -- 1 -- 3
    fn t_network() -> Network {
        let mut points = Vec::new();
        let mut edges = Vec::new();
        let mut add = |a: usize, b: usize, from: [f32; 2], to: [f32; 2], r: Option<&str>| {
            let start = points.len();
            let n = 11;
            for i in 0..n {
                let t = i as f32 / (n - 1) as f32;
                points.push([from[0] + (to[0] - from[0]) * t, 10.0, from[1] + (to[1] - from[1]) * t]);
            }
            edges.push(NetworkEdge {
                a,
                b,
                road_ref: r.map(String::from),
                name: None,
                kind: 1,
                start,
                count: n,
                length_m: 100.0,
                tunnel: false,
                markers: vec![],
            });
        };
        add(0, 1, [0.0, 0.0], [100.0, 0.0], Some("Ma-10"));
        add(1, 3, [100.0, 0.0], [200.0, 0.0], Some("Ma-10"));
        add(1, 2, [100.0, 0.0], [100.0, -100.0], Some("Ma-2"));
        let nodes = vec![
            NetworkNode {
                x: 0.0,
                z: 0.0,
                y: 10.0,
                signs: None,
            },
            NetworkNode {
                x: 100.0,
                z: 0.0,
                y: 10.0,
                signs: Some(vec![Sign {
                    edge: 2,
                    road_ref: Some("Ma-2".into()),
                    to: vec!["Sóller".into()],
                }]),
            },
            NetworkNode {
                x: 100.0,
                z: -100.0,
                y: 10.0,
                signs: None,
            },
            NetworkNode {
                x: 200.0,
                z: 0.0,
                y: 10.0,
                signs: None,
            },
        ];
        let mut adjacency = vec![Vec::new(); 4];
        for (i, e) in edges.iter().enumerate() {
            adjacency[e.a].push(i);
            adjacency[e.b].push(i);
        }
        Network {
            name: "t".into(),
            origin: Origin { lat: 0.0, lon: 0.0 },
            nodes,
            edges,
            places: vec![],
            points,
            adjacency,
        }
    }

    #[test]
    fn default_continuation_prefers_the_same_road() {
        let net = t_network();
        assert_eq!(net.default_continuation(1, 0), Some(1));
        // Coming up the branch, both ways along the Ma-10 are 90° turns; either is fine.
        assert!(matches!(net.default_continuation(1, 2), Some(0) | Some(1)));
    }

    #[test]
    fn navigator_plans_ahead_and_turns_on_request() {
        let net = t_network();
        let mut nav = Navigator::start("t", &net, 0, 0, true);
        let route = nav.route(&net);
        assert!((route.length_m() - 200.0).abs() < 6.0, "{}", route.length_m());
        assert_eq!(route.world.as_deref(), Some("t"));
        let j = nav.junction(&net, 20.0, 500.0).expect("a junction ahead");
        assert_eq!(j.node, 1);
        assert!((j.at_m - 100.0).abs() < 1e-6);
        assert_eq!(j.options.len(), 2);
        let left = j.options.iter().find(|o| o.edge == 2).unwrap();
        assert_eq!(left.turn, Turn::Left, "{left:?}");
        assert_eq!(left.to, vec!["Sóller".to_string()]);
        assert!(!left.chosen);
        let straight = j.options.iter().find(|o| o.edge == 1).unwrap();
        assert_eq!(straight.turn, Turn::Straight);
        assert!(straight.chosen);
        // Turn left: the route now goes north from the junction.
        assert!(nav.choose(&net, 20.0, 2));
        let route = nav.route(&net);
        let last = route.points.last().unwrap();
        assert!(last.z < -90.0 && (last.x - 100.0).abs() < 1.0, "{last:?}");
        assert!(
            nav.junction(&net, 20.0, 500.0)
                .unwrap()
                .options
                .iter()
                .find(|o| o.edge == 2)
                .unwrap()
                .chosen
        );
        // Past the junction there is nothing more to choose.
        assert!(nav.junction(&net, 150.0, 500.0).is_none());
        assert!(!nav.choose(&net, 150.0, 1));
    }

    #[test]
    fn nearest_point_and_mid_edge_start() {
        let net = t_network();
        assert_eq!(net.nearest(52.0, 3.0), Some((0, 5)));
        let nav = Navigator::start("t", &net, 0, 5, true);
        let route = nav.route(&net);
        assert!((route.points[0].x - 50.0).abs() < 1e-6);
        assert!((route.length_m() - 150.0).abs() < 6.0);
        let back = Navigator::start("t", &net, 0, 5, false);
        assert!((back.route(&net).length_m() - 50.0).abs() < 6.0, "dead end behind");
    }

    #[test]
    fn a_backward_start_begins_at_the_chosen_point() {
        let net = t_network();
        // Edge 0 runs from node 0 at x=0 to node 1 at x=100 in 11 points; start at its 8th point riding back toward node 0.
        let nav = Navigator::start("t", &net, 0, 7, false);
        let route = nav.route(&net);
        let first = route.points[0];
        assert!((first.x - 70.0).abs() < 0.1, "{}", first.x);
        assert!(route.points[1].x < first.x, "walks toward node 0");
        assert!((nav.leg_ends(&net)[0] - 70.0).abs() < 0.1, "{}", nav.leg_ends(&net)[0]);
    }

    #[test]
    fn a_planned_route_ends_at_its_destination() {
        let net = t_network();
        // From the middle of edge 0 through the junction and 50 m up the branch (edge 2 runs from node 1 north).
        let legs = [
            PlannedLeg {
                edge: 0,
                forward: true,
                from: 5,
                to: 10,
            },
            PlannedLeg {
                edge: 2,
                forward: true,
                from: 0,
                to: 5,
            },
        ];
        let mut nav = Navigator::planned("t", &net, "to the north", &legs).unwrap();
        assert!(nav.is_planned());
        let route = nav.route(&net);
        assert_eq!(route.name, "to the north");
        assert!(!route.closed);
        assert!((route.length_m() - 100.0).abs() < 6.0, "{}", route.length_m());
        let last = route.points.last().unwrap();
        assert!((last.x - 100.0).abs() < 1.0 && (last.z + 50.0).abs() < 1.0, "{last:?}");
        // It does not grow, and the junction shows the planned turn as chosen.
        assert!(!nav.keep_ahead(&net, 90.0));
        let j = nav.junction(&net, 10.0, 500.0).expect("junction ahead");
        assert!(j.options.iter().find(|o| o.edge == 2).unwrap().chosen);
        // No junction at the destination (it is mid-edge).
        assert!(nav.junction(&net, 60.0, 500.0).is_none());
        // The navigation display knows the next planned turn from anywhere on the route.
        let m = nav.next_maneuver(&net, 10.0).expect("a maneuver");
        assert_eq!(
            (m.turn, m.at_m as i64, m.road_ref.as_deref()),
            (Turn::Left, 50, Some("Ma-2"))
        );
        assert_eq!(m.to, vec!["Sóller".to_string()]);
        assert!(nav.next_maneuver(&net, 60.0).is_none(), "only the destination ahead");
        // Taking the planned way at the junction changes nothing.
        assert!(nav.choose(&net, 10.0, 2));
        assert!(nav.is_planned());
        // Turning off the plan makes it a free ride again, named after the road.
        assert!(nav.choose(&net, 10.0, 1));
        assert!(!nav.is_planned());
        assert!(nav.next_maneuver(&net, 10.0).is_none());
        let route = nav.route(&net);
        assert!(route.length_m() > 100.0);
        assert_eq!(route.name, "Ma-10");
        // Bad plans are refused.
        assert!(Navigator::planned("t", &net, "x", &[]).is_err());
        assert!(Navigator::planned(
            "t",
            &net,
            "x",
            &[PlannedLeg {
                edge: 9,
                forward: true,
                from: 0,
                to: 1
            }]
        )
        .is_err());
        assert!(
            Navigator::planned(
                "t",
                &net,
                "x",
                &[
                    PlannedLeg {
                        edge: 0,
                        forward: true,
                        from: 0,
                        to: 3
                    },
                    PlannedLeg {
                        edge: 1,
                        forward: true,
                        from: 0,
                        to: 3
                    }
                ]
            )
            .is_err(),
            "legs must join"
        );
    }

    #[test]
    fn turning_around_rides_the_same_road_back() {
        let net = t_network();
        // Free ride east along the Ma-10 from node 0; 35 m along, turn around.
        let mut nav = Navigator::start("t", &net, 0, 0, true);
        nav.turn_around(&net, 35.0);
        assert!(!nav.is_planned());
        let route = nav.route(&net);
        // The route runs to the nearest road point (30 m) and back to node 0: 60 m, then a dead end.
        assert!((route.length_m() - 60.0).abs() < 6.0, "{}", route.length_m());
        let p = |d: f64| {
            let i = ((d / 5.0).round() as usize).min(route.points.len() - 1);
            (route.points[i].x, route.points[i].z)
        };
        assert!((p(30.0).0 - 30.0).abs() < 1.0, "{:?}", p(30.0));
        assert!((p(55.0).0 - 5.0).abs() < 1.0, "the way back: {:?}", p(55.0));
        // No junction behind: the way back to node 0 has no choice.
        assert!(nav.junction(&net, 35.0, 500.0).is_none());

        // On a planned route a U-turn ends the plan; past the junction, the road back has the
        // junction ahead again, this time arriving from the branch.
        let mut net = t_network();
        net.nodes[1].signs.as_mut().unwrap().push(Sign {
            edge: 1,
            road_ref: Some("Ma-10".into()),
            to: vec!["Lluc".into()],
        });
        let legs = [
            PlannedLeg {
                edge: 0,
                forward: true,
                from: 0,
                to: 10,
            },
            PlannedLeg {
                edge: 2,
                forward: true,
                from: 0,
                to: 8,
            },
        ];
        let mut nav = Navigator::planned("t", &net, "north", &legs).unwrap();
        nav.turn_around(&net, 140.0);
        assert!(!nav.is_planned());
        let j = nav.junction(&net, 141.0, 500.0).expect("the junction, from the branch");
        assert_eq!(j.node, 1);
        assert!((j.at_m - 180.0).abs() < 1.0, "{}", j.at_m);
        assert!(
            nav.route(&net).length_m() > 250.0,
            "a free ride continues past the junction"
        );
    }

    #[test]
    fn identical_options_are_not_a_junction() {
        let mut net = t_network();
        // Make the branch read exactly like the main road: same ref, same destinations.
        net.edges[2].road_ref = Some("Ma-10".into());
        net.nodes[1].signs = Some(vec![
            Sign {
                edge: 1,
                road_ref: Some("Ma-10".into()),
                to: vec!["Lluc".into()],
            },
            Sign {
                edge: 2,
                road_ref: Some("Ma-10".into()),
                to: vec!["Lluc".into()],
            },
        ]);
        let nav = Navigator::start("t", &net, 0, 0, true);
        assert!(nav.junction(&net, 20.0, 500.0).is_none());
    }

    #[test]
    fn turns_from_angles() {
        assert_eq!(Turn::from_degrees(5.0), Turn::Straight);
        assert_eq!(Turn::from_degrees(60.0), Turn::Right);
        assert_eq!(Turn::from_degrees(-60.0), Turn::Left);
        assert_eq!(Turn::from_degrees(130.0), Turn::SharpRight);
        assert_eq!(Turn::from_degrees(175.0), Turn::UTurn);
    }

    #[test]
    fn mallorca_network_loads() {
        let net = Network::builtin("mallorca").expect("shipped network");
        assert!(net.edges.len() > 500, "{}", net.edges.len());
        let km: f64 = net.edges.iter().map(|e| e.length_m).sum::<f64>() / 1000.0;
        assert!(km > 300.0, "{km} km");
        assert!(net.edges.iter().any(|e| e.road_ref.as_deref() == Some("Ma-10")));
        assert!(net.nodes.iter().any(|n| n.signs.is_some()));
    }
}
