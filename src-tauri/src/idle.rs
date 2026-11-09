//! Keeps the screen on while riding. Pedalling and controller buttons are no keyboard or
//! mouse input, so the desktop's idle timer ran out mid-ride and the screensaver or the
//! lock covered the game. On Wayland the window's surface gets an idle inhibitor (the
//! `idle-inhibit` protocol, which compositors and idle daemons honour while the window is
//! visible); WebKit's own wake lock is refused in the web view.

#[cfg(target_os = "linux")]
mod imp {
    use std::sync::Mutex;

    use gtk::prelude::*;
    use wayland_client::backend::{Backend, ObjectId};
    use wayland_client::globals::{registry_queue_init, GlobalListContents};
    use wayland_client::protocol::{wl_registry, wl_surface::WlSurface};
    use wayland_client::{delegate_noop, Connection, Dispatch, Proxy, QueueHandle};
    use wayland_protocols::wp::idle_inhibit::zv1::client::zwp_idle_inhibit_manager_v1::ZwpIdleInhibitManagerV1;
    use wayland_protocols::wp::idle_inhibit::zv1::client::zwp_idle_inhibitor_v1::ZwpIdleInhibitorV1;

    struct State;

    impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
        fn event(
            _: &mut Self,
            _: &wl_registry::WlRegistry,
            _: wl_registry::Event,
            _: &GlobalListContents,
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }
    delegate_noop!(State: ignore ZwpIdleInhibitManagerV1);
    delegate_noop!(State: ignore ZwpIdleInhibitorV1);

    struct Held {
        conn: Connection,
        inhibitor: ZwpIdleInhibitorV1,
    }

    // Wayland proxies are thread-safe handles; GTK objects are not kept.
    static HELD: Mutex<Option<Held>> = Mutex::new(None);

    /// Turns the inhibitor on or off. Must run on the GTK main thread.
    pub fn set(window: &tauri::WebviewWindow, on: bool) -> Result<(), String> {
        let mut held = HELD.lock().unwrap();
        if !on {
            if let Some(h) = held.take() {
                h.inhibitor.destroy();
                let _ = h.conn.flush();
            }
            return Ok(());
        }
        if held.is_some() {
            return Ok(());
        }
        let gtk_window = window.gtk_window().map_err(|e| e.to_string())?;
        let gdk_window = gtk_window.window().ok_or("window not realized")?;
        let display = gdk_window.display();
        if !display.type_().name().contains("Wayland") {
            return Err("not a Wayland session".into());
        }
        // SAFETY: GDK hands out its own live wl_display and the window's wl_surface; both
        // outlive the inhibitor (it is destroyed before the window closes or with the process).
        unsafe {
            let wl_display = gdk_wayland_sys::gdk_wayland_display_get_wl_display(display.as_ptr() as *mut _);
            let wl_surface = gdk_wayland_sys::gdk_wayland_window_get_wl_surface(gdk_window.as_ptr() as *mut _);
            if wl_display.is_null() || wl_surface.is_null() {
                return Err("no Wayland surface".into());
            }
            let conn = Connection::from_backend(Backend::from_foreign_display(wl_display as *mut _));
            let id = ObjectId::from_ptr(WlSurface::interface(), wl_surface as *mut _).map_err(|e| e.to_string())?;
            let surface = WlSurface::from_id(&conn, id).map_err(|e| e.to_string())?;
            let (globals, queue) = registry_queue_init::<State>(&conn).map_err(|e| e.to_string())?;
            let manager: ZwpIdleInhibitManagerV1 = globals
                .bind(&queue.handle(), 1..=1, ())
                .map_err(|e| format!("no idle-inhibit support: {e}"))?;
            let inhibitor = manager.create_inhibitor(&surface, &queue.handle(), ());
            conn.flush().map_err(|e| e.to_string())?;
            *held = Some(Held { conn, inhibitor });
        }
        Ok(())
    }
}

/// Keeps the screen on (`on`) or lets it sleep again. Best effort: logs why it could not.
pub fn keep_awake(window: &tauri::WebviewWindow, on: bool) {
    #[cfg(target_os = "linux")]
    {
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            if let Err(e) = imp::set(&w, on) {
                log::warn!("keeping the screen on: {e}");
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (window, on);
}
