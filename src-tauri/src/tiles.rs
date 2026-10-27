//! A caching fetcher for map data the world streams at runtime: elevation
//! chunks from the IGN web coverage service and aerial photo tiles from the
//! IGN WMTS. Everything fetched once lands in the app's cache directory, so
//! a road ridden twice costs no second download and a ride works offline
//! afterwards.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager};

/// Hosts the app is willing to download from.
const ALLOWED_HOSTS: [&str; 3] = ["servicios.idee.es", "www.ign.es", "copernicus-dem-30m.s3.amazonaws.com"];
const USER_AGENT: &str = "WattsUp (https://github.com/rokemHB/wattsup)";

pub struct Tiles {
    cache: PathBuf,
    counter: AtomicU64,
    client: reqwest::Client,
}

impl Tiles {
    pub fn new(app: &AppHandle) -> Self {
        let cache = app
            .path()
            .app_cache_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("wattsup"))
            .join("tiles");
        let _ = std::fs::create_dir_all(&cache);
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(120))
            .build()
            .expect("http client");
        Self {
            cache,
            client,
            counter: AtomicU64::new(0),
        }
    }

    fn path_for(&self, url: &str) -> PathBuf {
        let hash = Sha256::digest(url.as_bytes());
        let ext = if url.contains("image/tiff") {
            "tif"
        } else if url.contains("jpeg") || url.ends_with(".jpg") {
            "jpg"
        } else {
            "bin"
        };
        self.cache.join(format!("{:x}.{ext}", hash))
    }

    /// The bytes behind `url`, from the cache or the network (with retries:
    /// the IGN servers answer 502 now and then).
    pub async fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
        let host = reqwest::Url::parse(url)
            .map_err(|e| e.to_string())?
            .host_str()
            .map(str::to_string)
            .ok_or("no host")?;
        if !ALLOWED_HOSTS.contains(&host.as_str()) {
            return Err(format!("host {host} is not a map data source"));
        }
        let path = self.path_for(url);
        if let Ok(bytes) = tokio::fs::read(&path).await {
            if !bytes.is_empty() {
                return Ok(bytes);
            }
        }
        let mut delay = Duration::from_millis(800);
        let mut last = String::new();
        for _ in 0..6 {
            match self.client.get(url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
                    if bytes.is_empty() {
                        last = "empty response".into();
                    } else {
                        // A private temp name: two tiles sharing a WMTS tile fetch it at the same time.
                        let n = self.counter.fetch_add(1, Ordering::Relaxed);
                        let tmp = path.with_extension(format!("part{n}"));
                        tokio::fs::write(&tmp, &bytes).await.map_err(|e| e.to_string())?;
                        if tokio::fs::rename(&tmp, &path).await.is_err() {
                            let _ = tokio::fs::remove_file(&tmp).await;
                        }
                        return Ok(bytes);
                    }
                }
                Ok(resp) => last = format!("http {}", resp.status()),
                Err(e) => last = e.to_string(),
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(20));
        }
        Err(format!("{url}: {last}"))
    }
}

/// Fetches a map data URL into the cache (for downloading a region ahead of
/// time) and answers with its size, so nothing is copied to the web view.
#[tauri::command]
pub async fn cache_fetch(app: AppHandle, url: String) -> Result<u64, String> {
    let tiles = app.state::<Tiles>();
    Ok(tiles.fetch(&url).await?.len() as u64)
}

/// Raw bytes of a map data URL, cached on disk. The web view gets an ArrayBuffer.
#[tauri::command]
pub async fn fetch_cached(app: AppHandle, url: String) -> Result<Response, String> {
    let tiles = app.state::<Tiles>();
    let bytes = tiles.fetch(&url).await?;
    Ok(Response::new(bytes))
}
