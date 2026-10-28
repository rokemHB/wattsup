//! A ride as a TCX file (Garmin Training Center XML), the format Strava and most
//! other services import with power, cadence and heart rate. Positions come from
//! the samples' route x, z and the world's origin, in the same flat frame the UI
//! uses for the terrain (`Frame` in `ui/src/world/streaming.ts`).

use std::fmt::Write;

use crate::rides::RideRecord;

/// Metres per degree of latitude and of longitude at the equator; the same as the UI's frame.
const EARTH_LAT_M: f64 = 110_574.0;
const EARTH_LON_M: f64 = 111_320.0;

/// A world origin: the latitude and longitude of the frame's (0, 0).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Origin {
    pub lat: f64,
    pub lon: f64,
}

impl Origin {
    fn lat_lon(&self, x: f64, z: f64) -> (f64, f64) {
        let kx = EARTH_LON_M * self.lat.to_radians().cos();
        (self.lat - z / EARTH_LAT_M, self.lon + x / kx)
    }
}

/// The ride as TCX. With an origin the track points carry positions; without, Strava
/// still takes the ride as a trainer activity.
pub fn to_tcx(record: &RideRecord, origin: Option<Origin>) -> String {
    let s = &record.summary;
    let st = &s.stats;
    let start = s.started_at_ms;
    let mut out = String::with_capacity(200 + record.samples.len() * 400);
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str(
        "<TrainingCenterDatabase xmlns=\"http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2\" \
         xmlns:ns3=\"http://www.garmin.com/xmlschemas/ActivityExtension/v2\" \
         xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" \
         xsi:schemaLocation=\"http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 \
         http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd\">\n",
    );
    out.push_str("  <Activities>\n    <Activity Sport=\"Biking\">\n");
    let _ = writeln!(out, "      <Id>{}</Id>", iso8601(start));
    let _ = writeln!(out, "      <Lap StartTime=\"{}\">", iso8601(start));
    let _ = writeln!(out, "        <TotalTimeSeconds>{:.1}</TotalTimeSeconds>", s.elapsed_s);
    let _ = writeln!(out, "        <DistanceMeters>{:.1}</DistanceMeters>", st.distance_m);
    let _ = writeln!(out, "        <MaximumSpeed>{:.3}</MaximumSpeed>", max_speed_mps(record));
    // Work in kJ is close to kcal burnt for a cyclist (about 24 % efficiency).
    let _ = writeln!(out, "        <Calories>{}</Calories>", st.energy_kj.round() as i64);
    if let Some(avg) = st.avg_heart_rate_bpm {
        let _ = writeln!(
            out,
            "        <AverageHeartRateBpm><Value>{}</Value></AverageHeartRateBpm>",
            avg.round() as i64
        );
        let _ = writeln!(
            out,
            "        <MaximumHeartRateBpm><Value>{}</Value></MaximumHeartRateBpm>",
            st.max_heart_rate_bpm.round() as i64
        );
    }
    out.push_str("        <Intensity>Active</Intensity>\n");
    if let Some(c) = st.avg_cadence_rpm {
        let _ = writeln!(out, "        <Cadence>{}</Cadence>", c.round() as i64);
    }
    out.push_str("        <TriggerMethod>Manual</TriggerMethod>\n        <Track>\n");
    for p in &record.samples {
        out.push_str("          <Trackpoint>\n");
        let _ = writeln!(
            out,
            "            <Time>{}</Time>",
            iso8601(start + (p.t_s * 1000.0) as u64)
        );
        if let (Some([x, z]), Some(o)) = (p.xz, origin) {
            let (lat, lon) = o.lat_lon(x, z);
            let _ = writeln!(
                out,
                "            <Position><LatitudeDegrees>{lat:.7}</LatitudeDegrees><LongitudeDegrees>{lon:.7}</LongitudeDegrees></Position>"
            );
        }
        let _ = writeln!(out, "            <AltitudeMeters>{:.1}</AltitudeMeters>", p.elevation_m);
        let _ = writeln!(out, "            <DistanceMeters>{:.1}</DistanceMeters>", p.distance_m);
        if let Some(hr) = p.heart_rate_bpm {
            let _ = writeln!(
                out,
                "            <HeartRateBpm><Value>{}</Value></HeartRateBpm>",
                hr.round() as i64
            );
        }
        if let Some(c) = p.cadence_rpm {
            let _ = writeln!(out, "            <Cadence>{}</Cadence>", c.round() as i64);
        }
        let _ = writeln!(
            out,
            "            <Extensions><ns3:TPX><ns3:Speed>{:.3}</ns3:Speed><ns3:Watts>{}</ns3:Watts></ns3:TPX></Extensions>",
            p.speed_kmh / 3.6,
            p.power_w.unwrap_or(0.0).round() as i64
        );
        out.push_str("          </Trackpoint>\n");
    }
    out.push_str("        </Track>\n");
    if let Some(avg) = st.avg_power_w {
        let _ = writeln!(
            out,
            "        <Extensions><ns3:LX><ns3:AvgWatts>{}</ns3:AvgWatts><ns3:MaxWatts>{}</ns3:MaxWatts></ns3:LX></Extensions>",
            avg.round() as i64,
            st.max_power_w.round() as i64
        );
    }
    out.push_str("      </Lap>\n");
    let _ = writeln!(
        out,
        "      <Notes>{} · WattsUp{}</Notes>",
        escape(&s.route),
        s.workout
            .as_deref()
            .map(|w| format!(" · {}", escape(w)))
            .unwrap_or_default()
    );
    out.push_str("      <Creator xsi:type=\"Device_t\"><Name>WattsUp</Name><UnitId>0</UnitId><ProductID>0</ProductID></Creator>\n");
    out.push_str("    </Activity>\n  </Activities>\n");
    out.push_str("  <Author xsi:type=\"Application_t\"><Name>WattsUp</Name><Build><Version><VersionMajor>0</VersionMajor><VersionMinor>1</VersionMinor></Version></Build><LangID>en</LangID><PartNumber>000-00000-00</PartNumber></Author>\n");
    out.push_str("</TrainingCenterDatabase>\n");
    out
}

/// A file name for the export: the date and the route, safe on every file system.
pub fn file_name(record: &RideRecord) -> String {
    let date = &iso8601(record.summary.started_at_ms)[..16].replace(':', "-");
    let mut route = String::new();
    for c in record.summary.route.chars() {
        if c.is_alphanumeric() {
            route.push(c);
        } else if !route.ends_with('-') {
            route.push('-');
        }
    }
    format!("WattsUp-{date}-{}.tcx", route.trim_matches('-'))
}

fn max_speed_mps(record: &RideRecord) -> f64 {
    record.samples.iter().map(|p| p.speed_kmh / 3.6).fold(0.0, f64::max)
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Unix milliseconds as `2026-10-28T21:05:07Z`.
pub fn iso8601(unix_ms: u64) -> String {
    let secs = unix_ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Days since 1970-01-01 to a calendar date (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rides::RideSummary;
    use wattsup_core::session::{RideSample, RideStats};

    #[test]
    fn dates_and_positions() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(1_793_221_507_000), "2026-10-28T21:05:07Z");
        assert_eq!(iso8601(951_782_400_000), "2000-02-29T00:00:00Z");
        let o = Origin { lat: 39.7, lon: 2.7 };
        let (lat, lon) = o.lat_lon(0.0, 0.0);
        assert_eq!((lat, lon), (39.7, 2.7));
        let (lat, lon) = o.lat_lon(1000.0, -1000.0);
        assert!(
            (lat - 39.70904).abs() < 1e-4 && (lon - 2.71168).abs() < 1e-4,
            "{lat} {lon}"
        );
    }

    #[test]
    fn a_ride_becomes_tcx() {
        let sample = |t: f64| RideSample {
            t_s: t,
            distance_m: 8.0 * t,
            elevation_m: 100.0 + t,
            grade_pct: 5.0,
            speed_kmh: 28.8,
            power_w: Some(201.4),
            cadence_rpm: Some(88.0),
            heart_rate_bpm: Some(140.0),
            xz: Some([100.0 * t, -50.0 * t]),
        };
        let record = RideRecord {
            summary: RideSummary {
                id: "ride-1793221507000".into(),
                started_at_ms: 1_793_221_507_000,
                route: "Sa Calobra & back".into(),
                world: Some("mallorca".into()),
                workout: None,
                finished: true,
                elapsed_s: 2.0,
                stats: RideStats {
                    moving_s: 2.0,
                    distance_m: 16.0,
                    ascent_m: 2.0,
                    descent_m: 0.0,
                    avg_power_w: Some(201.4),
                    max_power_w: 210.0,
                    normalized_power_w: None,
                    avg_heart_rate_bpm: Some(140.0),
                    max_heart_rate_bpm: 142.0,
                    avg_cadence_rpm: Some(88.0),
                    avg_speed_kmh: 28.8,
                    energy_kj: 0.4,
                },
            },
            samples: vec![sample(0.0), sample(1.0), sample(2.0)],
        };
        let tcx = to_tcx(&record, Some(Origin { lat: 39.7, lon: 2.7 }));
        assert!(tcx.starts_with("<?xml"));
        assert!(tcx.contains("<Id>2026-10-28T21:05:07Z</Id>"));
        assert!(tcx.contains("<Time>2026-10-28T21:05:09Z</Time>"));
        assert_eq!(tcx.matches("<Trackpoint>").count(), 3);
        assert!(tcx.contains("<LatitudeDegrees>39.7000000</LatitudeDegrees>"));
        assert!(tcx.contains("<ns3:Watts>201</ns3:Watts>"));
        assert!(tcx.contains("<ns3:AvgWatts>201</ns3:AvgWatts><ns3:MaxWatts>210</ns3:MaxWatts>"));
        assert!(tcx.contains("<Notes>Sa Calobra &amp; back · WattsUp</Notes>"));
        assert!(tcx.contains("<HeartRateBpm><Value>140</Value></HeartRateBpm>"));
        assert_eq!(file_name(&record), "WattsUp-2026-10-28T21-05-Sa-Calobra-back.tcx");
        // Without an origin there are no positions, and the rest stands.
        let plain = to_tcx(&record, None);
        assert!(!plain.contains("<Position>") && plain.matches("<Trackpoint>").count() == 3);
    }
}
