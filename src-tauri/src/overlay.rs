//! The trainer's small window as an overlay on Hyprland.
//!
//! Wayland lets no client keep itself on top or choose its position, so Tauri's
//! `alwaysOnTop` and `setPosition` do nothing there. On Hyprland the compositor can be
//! asked instead (`hyprctl`): pinning a floating window keeps it on every workspace and
//! above fullscreen windows (a video played fullscreen), and it can be moved to the top
//! right corner of its monitor, below any bar. Hyprland 0.55 and later take Lua dispatchers
//! (`hl.dsp.window.pin(...)`); older ones the classic `pin address:...`: both are tried.
//! Elsewhere (Windows, macOS, X11) the UI positions the window itself and Tauri's
//! always-on-top works.

use std::process::Command;
use std::sync::Mutex;
use std::thread::sleep;
use std::time::Duration;

use serde_json::Value;

/// Where this module last put the window: x, y, height (logical pixels).
static PLACED: Mutex<Option<(i64, i64, i64)>> = Mutex::new(None);

/// Resizes the smallest mapped window of this process (the small window: the main one is hidden
/// meanwhile) to `width` x `height` logical pixels, pins it and, with `place`, moves it to the top
/// right of its monitor. Returns what was done, for the log.
pub fn pin(width: u32, height: u32, place: bool) -> Result<String, String> {
    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_none() {
        return Ok("not on Hyprland".into());
    }
    // The window may not be mapped yet right after it was created.
    let mut window = None;
    for _ in 0..15 {
        window = own_window()?;
        if window.is_some() {
            break;
        }
        sleep(Duration::from_millis(200));
    }
    let window = window.ok_or("no window of this process on Hyprland")?;
    let address = window["address"].as_str().ok_or("window without address")?.to_string();
    let target = format!("address:{address}");

    dispatch(
        &format!("hl.dsp.window.resize({{ x = {width}, y = {height}, window = \"{target}\" }})"),
        &format!("resizewindowpixel exact {width} {height},{target}"),
    )?;
    if !window["pinned"].as_bool().unwrap_or(false) {
        dispatch(
            &format!("hl.dsp.window.pin({{ window = \"{target}\" }})"),
            &format!("pin {target}"),
        )?;
    }
    // Hyprland resizes a floating window about its centre (the app's own resize too, which may
    // have landed already): unless the rider has moved it since, its top left goes back where it
    // was put, the first time into the corner.
    let at = |i: usize| window["at"].get(i).and_then(Value::as_i64);
    let now = (
        at(0).ok_or("window without position")?,
        at(1).ok_or("window without position")?,
        window["size"]
            .get(1)
            .and_then(Value::as_i64)
            .unwrap_or(i64::from(height)),
    );
    let mut placed = PLACED.lock().map_err(|_| "placement lock poisoned")?;
    let (x, y) = if place {
        let monitors = hyprctl_json("monitors")?;
        let monitor = monitors
            .as_array()
            .and_then(|all| all.iter().find(|m| m["id"] == window["monitor"]))
            .ok_or("the window's monitor is not listed")?;
        corner(monitor, i64::from(width)).ok_or("monitor geometry missing")?
    } else {
        kept_place(*placed, now)
    };
    dispatch(
        &format!("hl.dsp.window.move({{ x = {x}, y = {y}, window = \"{target}\" }})"),
        &format!("movewindowpixel exact {x} {y},{target}"),
    )?;
    *placed = Some((x, y, i64::from(height)));
    Ok(format!("{address} {width}x{height}, pinned at {x},{y}"))
}

/// The top left for a window now at `now` (x, y, height) that was last put at `placed`: the
/// same place if only a resize about its centre moved it, else (moved by hand) where it is.
fn kept_place(placed: Option<(i64, i64, i64)>, now: (i64, i64, i64)) -> (i64, i64) {
    let (x, y, h) = now;
    match placed {
        Some((px, py, ph)) if (x - px).abs() <= 2 && (2 * y + h - (2 * py + ph)).abs() <= 4 => (px, py),
        _ => (x, y),
    }
}

/// The top-left position that puts the window into the monitor's top right corner, inside the
/// area bars reserve (`reserved`: left, top, right, bottom), in Hyprland's logical pixels.
fn corner(monitor: &Value, w: i64) -> Option<(i64, i64)> {
    let scale = monitor["scale"].as_f64().filter(|s| *s > 0.0)?;
    let mx = monitor["x"].as_i64()?;
    let my = monitor["y"].as_i64()?;
    let width = (monitor["width"].as_f64()? / scale).round() as i64;
    let reserved = |i: usize| monitor["reserved"].get(i).and_then(Value::as_i64).unwrap_or(0);
    Some((mx + width - reserved(2) - w, my + reserved(1)))
}

/// The smallest mapped client window of this process.
fn own_window() -> Result<Option<Value>, String> {
    let pid = i64::from(std::process::id());
    let clients = hyprctl_json("clients")?;
    let area = |c: &Value| {
        let s = &c["size"];
        s.get(0).and_then(Value::as_i64).unwrap_or(i64::MAX) * s.get(1).and_then(Value::as_i64).unwrap_or(1)
    };
    Ok(clients
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["pid"].as_i64() == Some(pid) && c["mapped"].as_bool() != Some(false))
        .min_by_key(|c| area(c))
        .cloned())
}

fn hyprctl_json(what: &str) -> Result<Value, String> {
    let out = Command::new("hyprctl")
        .args(["-j", what])
        .output()
        .map_err(|e| format!("hyprctl: {e}"))?;
    serde_json::from_slice(&out.stdout).map_err(|e| format!("hyprctl {what}: {e}"))
}

/// Runs a dispatcher in the Lua form, then in the classic form if Hyprland did not take it.
fn dispatch(lua: &str, classic: &str) -> Result<(), String> {
    for args in [vec!["dispatch", lua], {
        let mut v = vec!["dispatch"];
        v.extend(classic.splitn(2, ' '));
        v
    }] {
        let out = Command::new("hyprctl")
            .args(&args)
            .output()
            .map_err(|e| format!("hyprctl: {e}"))?;
        if String::from_utf8_lossy(&out.stdout).trim() == "ok" {
            return Ok(());
        }
    }
    Err(format!("Hyprland took neither `{lua}` nor `{classic}`"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_corner_is_inside_the_bar_and_flush_right() {
        let monitor = json!({ "x": 0, "y": 0, "width": 2560, "scale": 1.6, "reserved": [0, 26, 0, 0] });
        assert_eq!(corner(&monitor, 440), Some((1160, 26)));
        let second = json!({ "x": 1600, "y": 0, "width": 1920, "scale": 1.0, "reserved": [0, 0, 10, 0] });
        assert_eq!(corner(&second, 440), Some((1600 + 1920 - 10 - 440, 0)));
    }

    #[test]
    fn a_refit_keeps_the_top_unless_the_window_was_moved() {
        // Put at 1160,26 at 360 high, shrunk to 182 about its centre: back to the top.
        assert_eq!(kept_place(Some((1160, 26, 360)), (1160, 115, 182)), (1160, 26));
        // Not resized yet: the same.
        assert_eq!(kept_place(Some((1160, 26, 360)), (1160, 26, 360)), (1160, 26));
        // Dragged elsewhere by the rider: stays there.
        assert_eq!(kept_place(Some((1160, 26, 360)), (300, 400, 182)), (300, 400));
        assert_eq!(kept_place(None, (10, 20, 100)), (10, 20));
    }
}
