//! Rides kept on disk: one JSON file per ride with its one-second samples, and an
//! index of summaries for the list. Local files for now; a server can come later.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use wattsup_core::session::{RideReport, RideSample, RideStats};

/// A ride as the list shows it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RideSummary {
    pub id: String,
    /// Unix time of the start in milliseconds.
    pub started_at_ms: u64,
    pub route: String,
    pub world: Option<String>,
    pub workout: Option<String>,
    pub finished: bool,
    pub elapsed_s: f64,
    pub stats: RideStats,
}

/// A whole ride: the summary plus its samples.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RideRecord {
    pub summary: RideSummary,
    pub samples: Vec<RideSample>,
}

/// The rides folder.
#[derive(Clone, Debug)]
pub struct RideStore {
    dir: PathBuf,
}

const INDEX: &str = "index.json";

impl RideStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Files one ride: `<id>.json`, and the index.
    pub fn save(&self, report: RideReport, started_at_ms: u64) -> Result<RideSummary, String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("rides folder: {e}"))?;
        let summary = RideSummary {
            id: format!("ride-{started_at_ms}"),
            started_at_ms,
            route: report.route,
            world: report.world,
            workout: report.workout,
            finished: report.finished,
            elapsed_s: report.elapsed_s,
            stats: report.stats,
        };
        let record = RideRecord {
            summary: summary.clone(),
            samples: report.samples,
        };
        let json = serde_json::to_string(&record).map_err(|e| e.to_string())?;
        std::fs::write(self.path(&summary.id), json).map_err(|e| format!("writing the ride: {e}"))?;
        let mut index: Vec<RideSummary> = self.list().into_iter().filter(|r| r.id != summary.id).collect();
        index.push(summary.clone());
        self.write_index(&index)?;
        Ok(summary)
    }

    /// All rides, newest first.
    pub fn list(&self) -> Vec<RideSummary> {
        let mut rides: Vec<RideSummary> = std::fs::read_to_string(self.dir.join(INDEX))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| self.rebuild_index());
        rides.sort_by_key(|r| std::cmp::Reverse(r.started_at_ms));
        rides
    }

    pub fn load(&self, id: &str) -> Result<RideRecord, String> {
        let s = std::fs::read_to_string(self.path(id)).map_err(|e| format!("ride {id}: {e}"))?;
        serde_json::from_str(&s).map_err(|e| format!("ride {id}: {e}"))
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        std::fs::remove_file(self.path(id)).map_err(|e| format!("ride {id}: {e}"))?;
        let index: Vec<RideSummary> = self.list().into_iter().filter(|r| r.id != id).collect();
        self.write_index(&index)
    }

    fn path(&self, id: &str) -> PathBuf {
        // Ids are ours ("ride-<ms>"); anything else must not reach the file system.
        let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        self.dir.join(format!("{safe}.json"))
    }

    fn write_index(&self, index: &[RideSummary]) -> Result<(), String> {
        let json = serde_json::to_string(index).map_err(|e| e.to_string())?;
        std::fs::write(self.dir.join(INDEX), json).map_err(|e| format!("writing the ride index: {e}"))
    }

    /// The index from the ride files, for a missing or broken index.
    fn rebuild_index(&self) -> Vec<RideSummary> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut rides = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(id) = name.strip_suffix(".json").filter(|id| id.starts_with("ride-")) {
                if let Ok(record) = self.load(id) {
                    rides.push(record.summary);
                }
            }
        }
        let _ = self.write_index(&rides);
        rides
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(route: &str) -> RideReport {
        RideReport {
            route: route.into(),
            world: None,
            workout: None,
            finished: true,
            elapsed_s: 100.0,
            stats: RideStats {
                distance_m: 1000.0,
                ..RideStats::default()
            },
            samples: vec![RideSample {
                t_s: 0.0,
                distance_m: 0.0,
                elevation_m: 5.0,
                grade_pct: 1.0,
                speed_kmh: 30.0,
                power_w: Some(200.0),
                cadence_rpm: None,
                heart_rate_bpm: None,
            }],
        }
    }

    #[test]
    fn rides_round_trip_through_the_folder() {
        let dir = std::env::temp_dir().join(format!("wattsup-rides-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = RideStore::new(&dir);
        assert!(store.list().is_empty());
        let a = store.save(report("A"), 1000).unwrap();
        let b = store.save(report("B"), 2000).unwrap();
        assert_eq!(a.id, "ride-1000");
        let ids: Vec<_> = store.list().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["ride-2000", "ride-1000"], "newest first");
        let loaded = store.load(&b.id).unwrap();
        assert_eq!(loaded.summary, b);
        assert_eq!(loaded.samples.len(), 1);
        // A lost index is rebuilt from the files.
        std::fs::remove_file(dir.join(INDEX)).unwrap();
        assert_eq!(store.list().len(), 2);
        store.delete(&a.id).unwrap();
        assert_eq!(store.list().len(), 1);
        assert!(store.load(&a.id).is_err());
        assert!(store.load("../../etc/passwd").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
