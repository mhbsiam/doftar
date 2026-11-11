//! Extra windows, made when a tab is dragged out of the tab strip.

use crate::lock::Locked;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewWindow};

/// Tab for each new window, held until its page asks for it.
static PENDING: Mutex<Option<HashMap<String, serde_json::Value>>> = Mutex::new(None);
static NEXT: AtomicUsize = AtomicUsize::new(1);

/// Open a window with `tab`. Its top-left corner is at (`x`, `y`) in screen points. It has the size of `window`.
#[tauri::command]
pub async fn open_tab_window(
    app: AppHandle,
    window: WebviewWindow,
    tab: serde_json::Value,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let mut cfg = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("no window config")?;
    let label = format!("tab-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    cfg.label = label.clone();
    cfg.center = false;
    cfg.x = Some(x);
    cfg.y = Some(y);
    cfg.width = size.width;
    cfg.height = size.height;
    cfg.visible = false;

    PENDING
        .locked()
        .get_or_insert_with(HashMap::new)
        .insert(label.clone(), tab);
    let win = crate::webview::build(&app, cfg).inspect_err(|_| forget(&label))?;
    // The page shows itself after painting. This covers a page that fails to load.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        let _ = win.show();
    });
    Ok(())
}

#[tauri::command]
pub fn take_window_init(window: WebviewWindow) -> Option<serde_json::Value> {
    take(window.label())
}

/// A window of this app under a screen point. The point is in the window's own coordinates (logical pixels from its top-left corner).
#[derive(serde::Serialize, Debug)]
pub struct WindowHit {
    label: String,
    x: f64,
    y: f64,
}

/// The app window under (`x`, `y`) in screen points, only if it is the frontmost window there. A window of another app on top hides it.
#[tauri::command(async)]
pub fn tab_window_at(app: AppHandle, x: f64, y: f64) -> Option<WindowHit> {
    #[cfg(target_os = "macos")]
    {
        let wins: Vec<(String, usize)> = app
            .webview_windows()
            .into_iter()
            .filter(|(label, _)| {
                ![crate::viewer::LABEL, crate::reader::LABEL, crate::pdf::LABEL, crate::video::LABEL]
                    .contains(&label.as_str())
            })
            .filter_map(|(label, w)| w.ns_window().ok().map(|p| (label, p as usize)))
            .collect();
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(unsafe { hit_test(&wins, x, y) });
        })
        .ok()?;
        rx.recv_timeout(Duration::from_secs(1)).ok().flatten()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, x, y);
        None
    }
}

/// Run on the main thread. `wins` holds the NSWindow pointer of each window.
#[cfg(target_os = "macos")]
unsafe fn hit_test(wins: &[(String, usize)], x: f64, y: f64) -> Option<WindowHit> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSScreen, NSWindow};
    use objc2_foundation::NSPoint;

    let mtm = MainThreadMarker::new()?;
    // Screen points run top-down from the primary display. AppKit points run bottom-up.
    let primary = NSScreen::screens(mtm).firstObject()?;
    let point = NSPoint::new(x, primary.frame().size.height - y);
    let number = NSWindow::windowNumberAtPoint_belowWindowWithWindowNumber(point, 0, mtm);
    wins.iter().find_map(|(label, ptr)| {
        let w = (*ptr as *const NSWindow).as_ref()?;
        if w.windowNumber() != number {
            return None;
        }
        let f = w.frame();
        Some(WindowHit {
            label: label.clone(),
            x: point.x - f.origin.x,
            y: f.origin.y + f.size.height - point.y,
        })
    })
}

pub fn stash(label: &str, init: serde_json::Value) {
    PENDING
        .locked()
        .get_or_insert_with(HashMap::new)
        .insert(label.to_string(), init);
}

pub fn take(label: &str) -> Option<serde_json::Value> {
    PENDING.locked().as_mut()?.remove(label)
}

pub fn forget(label: &str) {
    if let Some(m) = PENDING.locked().as_mut() {
        m.remove(label);
    }
}
