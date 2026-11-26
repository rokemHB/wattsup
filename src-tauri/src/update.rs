//! "A new version is out": asks GitHub for the latest published release and compares its
//! version with this build's. Nothing is downloaded or installed; the menu shows a notice and
//! the rider fetches the new installer from the release page in the browser.

use std::time::Duration;

use serde::Serialize;

const LATEST: &str = "https://api.github.com/repos/rokemHB/wattsup/releases/latest";
/// The only pages `open_release_page` opens.
const RELEASES: &str = "https://github.com/rokemHB/wattsup/releases";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UpdateInfo {
    /// This build's version.
    pub current: String,
    /// The latest release's version, when it is newer than this build.
    pub newer: Option<String>,
    /// That release's page.
    pub url: Option<String>,
}

/// The parts of a version that order releases: (major, minor, patch). A pre-release suffix
/// ("-beta.1") is ignored; GitHub's "latest" never points at a pre-release anyway.
fn parse(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let v = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(v)
}

/// What the menu should show, from this build's version and the latest release's tag and page.
pub fn compare(current: &str, tag: &str, url: &str) -> UpdateInfo {
    let newer = matches!((parse(current), parse(tag)), (Some(c), Some(l)) if l > c);
    UpdateInfo {
        current: current.to_string(),
        newer: newer.then(|| tag.trim_start_matches('v').to_string()),
        url: (newer && url.starts_with(RELEASES)).then(|| url.to_string()),
    }
}

pub async fn check() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION");
    let client = reqwest::Client::builder()
        .user_agent(concat!("WattsUp/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(LATEST)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GitHub answered {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let body: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let tag = body["tag_name"].as_str().ok_or("no tag_name")?;
    let url = body["html_url"].as_str().unwrap_or(RELEASES);
    Ok(compare(current, tag, url))
}

/// Opens a page of the project's releases in the default browser.
pub fn open(url: &str) -> Result<(), String> {
    if !url.starts_with(RELEASES) || url.chars().any(|c| c.is_whitespace() || c == '"') {
        return Err(format!("not a release page: {url}"));
    }
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "https://github.com/rokemHB/wattsup/releases/tag/v0.2.0";

    #[test]
    fn parses_versions() {
        assert_eq!(parse("0.1.0"), Some((0, 1, 0)));
        assert_eq!(parse("v1.12.3"), Some((1, 12, 3)));
        assert_eq!(parse("v0.2.0-beta.1"), Some((0, 2, 0)));
        assert_eq!(parse("0.2"), None);
        assert_eq!(parse("0.2.0.1"), None);
        assert_eq!(parse("latest"), None);
    }

    #[test]
    fn a_newer_release_is_offered() {
        let info = compare("0.1.0", "v0.2.0", PAGE);
        assert_eq!(info.newer.as_deref(), Some("0.2.0"));
        assert_eq!(info.url.as_deref(), Some(PAGE));
        // Numbers, not strings: 0.10 is after 0.9.
        assert!(compare("0.9.0", "v0.10.0", PAGE).newer.is_some());
    }

    #[test]
    fn the_same_or_an_older_release_is_not() {
        assert_eq!(compare("0.2.0", "v0.2.0", PAGE).newer, None);
        assert_eq!(compare("0.3.0", "v0.2.0", PAGE).newer, None);
        assert_eq!(compare("0.2.0", "nonsense", PAGE).newer, None);
    }

    #[test]
    fn only_release_pages_are_opened() {
        assert!(compare("0.1.0", "v0.2.0", "https://example.com/x").url.is_none());
        assert!(open("https://example.com/").is_err());
        assert!(open("https://github.com/rokemHB/wattsup/releases\" & calc").is_err());
    }
}
