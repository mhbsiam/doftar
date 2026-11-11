//! Video and audio player window. WebKit's player plays the file through the asset protocol.
//! The window is made hidden at launch and hidden on close, so a video opens without waiting for a webview.

use crate::lock::Locked;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, WebviewWindow, Window};

use crate::zoom::CssRect;

pub const LABEL: &str = "video";

/// Keep in step with `VIDEO_EXTS` and `AUDIO_EXTS` in src/util/kinds.ts and the asset scope in tauri.conf.json.
const EXTS: &[&str] = &["mp4", "m4v", "mov", "webm", "mp3", "m4a", "aac", "wav", "flac", "aif", "aiff"];

/// Held while the window is looked up, made or marked ready. An open cannot then slip between the page listening and taking the opens it missed.
static OPENING: Mutex<()> = Mutex::new(());
/// Set when the page listens for `video:open`. Until then opens wait in `windows`.
static READY: AtomicBool = AtomicBool::new(false);
/// Increase on every open and close. A close's zoom then never hides a reopened window, and a fallback show never shows a closed one.
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn is_video(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTS.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

/// Callers hold `OPENING`.
fn build(app: &AppHandle) -> Result<WebviewWindow, String> {
    let mut cfg = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("no window config")?;
    cfg.label = LABEL.to_string();
    cfg.width = 960.0;
    cfg.height = 600.0;
    cfg.min_width = Some(360.0);
    cfg.min_height = Some(240.0);
    cfg.center = true;
    cfg.visible = false;
    cfg.transparent = false;
    cfg.window_effects = None;
    crate::webview::build(app, cfg)
}

pub fn prewarm(app: &AppHandle) {
    let _guard = OPENING.locked();
    if app.get_webview_window(LABEL).is_none() {
        let _ = build(app);
    }
}

/// `from` is where the calling page draws the file icon. The window zooms up from near it.
/// `order` is the folder's tracks, for next and previous. The page plays only what the asset scope allows.
#[tauri::command]
pub async fn open_video(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
    from: Option<CssRect>,
    order: Option<Vec<String>>,
) -> Result<(), String> {
    if crate::watcher::is_ejecting(&path) {
        return Err("volume is being ejected".to_string());
    }
    let p = Path::new(&path);
    if !p.is_absolute() || !is_video(p) {
        return Err("Doftar's player doesn't play this kind of file".into());
    }
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if crate::thumbs::is_dataless(&meta) {
        return Err("the file is not downloaded".into());
    }
    let msg = serde_json::json!({ "path": path, "order": order });
    let _guard = OPENING.locked();
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let win = match app.get_webview_window(LABEL) {
        Some(win) => win,
        None => build(&app)?,
    };
    let arrive = {
        let w = win.clone();
        move |show: bool| {
            if let Some(from) = from {
                crate::zoom::aim(&w, &window, from);
            }
            if show {
                crate::zoom::show(&w);
            }
        }
    };
    if READY.load(Ordering::SeqCst) {
        win.emit_to(LABEL, "video:open", msg).map_err(|e| e.to_string())?;
        let _ = win.run_on_main_thread(move || arrive(true));
    } else {
        // The page shows the window when it takes this. The thread covers a page that never does.
        crate::windows::stash(LABEL, msg);
        let w = win.clone();
        let _ = w.run_on_main_thread(move || arrive(false));
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            let current = GENERATION.load(Ordering::SeqCst) == generation;
            if current && !win.is_visible().unwrap_or(true) {
                let w = win.clone();
                let _ = win.run_on_main_thread(move || crate::zoom::show(&w));
            }
        });
    }
    Ok(())
}

/// Returns a video that was asked for before the page listened. Async, so it does not wait on the main thread while `build` holds the lock there.
#[tauri::command(async)]
pub fn video_ready() -> Option<serde_json::Value> {
    let _guard = OPENING.locked();
    READY.store(true, Ordering::SeqCst);
    crate::windows::take(LABEL)
}

/// Zooms the window out and hides it. The page then stops the video and releases the file.
/// A video opened meanwhile keeps the window up. Runs on the main thread.
pub fn close_requested(win: &Window) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let still_closing = move || GENERATION.load(Ordering::SeqCst) == generation;
    crate::zoom::hide(win, still_closing, |w| {
        let _ = w.emit_to(LABEL, "video:hidden", ());
    });
}

/// The window went away. The page starts over when the window is made again.
pub fn forget() {
    READY.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plays_only_what_webkit_plays() {
        assert!(is_video(Path::new("/a/clip.MP4")));
        assert!(is_video(Path::new("/a/clip.webm")));
        assert!(is_video(Path::new("/a/song.FLAC")));
        assert!(!is_video(Path::new("/a/song.ogg")));
        assert!(!is_video(Path::new("/a/clip.mkv")));
        assert!(!is_video(Path::new("/a/clip")));
    }
}
