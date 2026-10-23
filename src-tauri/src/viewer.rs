//! Doftar's image viewer: one window that shows an image and steps through
//! the other images in its folder.

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, WebviewWindow, Window};

use crate::thumbs::{cache_key, is_dataless, preview_dir, touch, wait_or_kill, SIPS};
use crate::fly::{Landing, Picture};
use crate::zoom::CssRect;

pub const LABEL: &str = "viewer";

/// What the viewer opens; keep in step with `VIEWER_EXTS` in src/util/kinds.ts.
const EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif", "tif", "tiff", "heic",
    "heif", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2",
];
/// Converted to PNG so transparency survives; the rest become JPEG.
const PNG_EXTS: &[&str] = &["png", "gif", "webp", "bmp", "ico", "tif", "tiff"];
/// A RAW file from a big sensor takes a while to decode.
const CONVERT_TIMEOUT: Duration = Duration::from_secs(20);

/// Held while the window is looked up, made or marked ready, so an open never
/// slips between the page starting to listen and taking what it missed.
static OPENING: Mutex<()> = Mutex::new(());
/// Set once the page listens for `viewer:open`; until then opens wait in `windows`.
static READY: AtomicBool = AtomicBool::new(false);
/// Bumped on every open, so a close's fallback hide never hides a reopened window.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Set while the page holds edits that aren't saved; closing then asks first.
static DIRTY: AtomicBool = AtomicBool::new(false);
static NEXT_TMP: AtomicU64 = AtomicU64::new(1);

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ViewerOpen {
    path: String,
    /// The folder's paths in the order Doftar lists them, when opened from a listing.
    order: Option<Vec<String>>,
    /// Its thumbnail is flying in: the page says once the image is drawn.
    flown: bool,
}

fn ext_of(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_image(p: &Path) -> bool {
    EXTS.contains(&ext_of(p).as_str())
}

/// Makes the (hidden) viewer window. Callers hold `OPENING`.
fn build(app: &AppHandle) -> Result<WebviewWindow, String> {
    let mut cfg = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("no window config")?;
    cfg.label = LABEL.to_string();
    cfg.width = 1000.0;
    cfg.height = 720.0;
    cfg.min_width = Some(420.0);
    cfg.min_height = Some(320.0);
    cfg.center = true;
    cfg.visible = false;
    cfg.transparent = false;
    cfg.window_effects = None;
    crate::webview::build(app, cfg)
}

/// Makes the viewer window ahead of time, hidden, so the first image opens
/// without waiting for a webview to start.
pub fn prewarm(app: &AppHandle) {
    let _guard = OPENING.lock().unwrap();
    if app.get_webview_window(LABEL).is_none() {
        let _ = build(app);
    }
}

/// Shows `path` in the viewer window, making the window if it isn't there.
/// `from` is where the calling page draws the image's icon: its thumbnail
/// flies from there into the window. Returns whether it does, so the page
/// knows to hide the icon until it hears `viewer:flown`.
#[tauri::command]
pub async fn open_image_viewer(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
    order: Option<Vec<String>>,
    from: Option<CssRect>,
) -> Result<bool, String> {
    let thumb = from
        .filter(|_| !crate::zoom::reduce_motion())
        .and_then(|_| crate::fly::thumb_for(&path));
    let size = thumb.as_ref().and_then(|_| crate::fly::image_size(Path::new(&path)));
    let flown = thumb.is_some();
    crate::fly::set_opener(LABEL, from.map(|_| window.label().to_string()));
    let msg =
        serde_json::to_value(ViewerOpen { path, order, flown }).map_err(|e| e.to_string())?;
    let _guard = OPENING.lock().unwrap();
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let win = match app.get_webview_window(LABEL) {
        Some(win) => win,
        None => build(&app)?,
    };
    // Flies the thumbnail in, or else zooms the window up from near the icon.
    let arrive = {
        let (w, source) = (win.clone(), window.clone());
        move |show: bool| {
            if let (Some(thumb), Some(from)) = (&thumb, from) {
                let picture = Picture::File(thumb.clone());
                if crate::fly::fly_in(&w, &source, from, &picture, Landing::Image(size)) {
                    return;
                }
                let _ = source.emit_to(source.label(), "viewer:flown", ());
            }
            if let Some(from) = from {
                crate::zoom::aim(&w, &source, from);
            }
            if show {
                crate::zoom::show(&w);
            }
        }
    };
    if READY.load(Ordering::SeqCst) {
        win.emit_to(LABEL, "viewer:open", msg).map_err(|e| e.to_string())?;
        let _ = win.run_on_main_thread(move || arrive(true));
    } else {
        // The page shows itself once it has painted this image.
        crate::windows::stash(LABEL, msg);
        let _ = win.run_on_main_thread(move || arrive(false));
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            let current = GENERATION.load(Ordering::SeqCst) == generation;
            if current && !win.is_visible().unwrap_or(true) {
                let w = win.clone();
                let _ = win.run_on_main_thread(move || crate::zoom::show(&w));
            }
        });
    }
    Ok(flown)
}

/// Called by the page once it listens for `viewer:open`; returns an image
/// asked for before then. Async so it never waits on the main thread while
/// `build` holds the lock there.
#[tauri::command(async)]
pub fn viewer_ready() -> Option<serde_json::Value> {
    let _guard = OPENING.lock().unwrap();
    READY.store(true, Ordering::SeqCst);
    crate::windows::take(LABEL)
}

/// The page has (or no longer has) edits that aren't saved.
#[tauri::command]
pub fn viewer_set_dirty(dirty: bool) {
    DIRTY.store(dirty, Ordering::SeqCst);
}

/// Closing hides the window instead, so the next image opens at once. The
/// image flies back into its thumbnail when the listing still shows it, and
/// otherwise the window zooms out; AppKit animates either, so it is smooth
/// however busy the page is. Unsaved edits make the page ask first;
/// it closes again once they are saved or discarded. An image opened while
/// it zooms out keeps it up. Runs on the main thread.
pub fn close_requested(win: &Window) {
    if DIRTY.load(Ordering::SeqCst) {
        let _ = win.emit_to(LABEL, "viewer:confirm-close", ());
        return;
    }
    crate::fly::cancel();
    // A close is a new turn too, so a pending fallback show from the last
    // open doesn't bring the window back up.
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let still_closing = move || GENERATION.load(Ordering::SeqCst) == generation;
    // The page drops the image only now, so it never vanishes mid-zoom.
    let hidden = |w: &Window| {
        let _ = w.emit_to(LABEL, "viewer:hidden", ());
    };
    // Back into its thumbnail, when the listing it came from still shows it.
    let picture = crate::fly::shown_path(LABEL)
        .and_then(|p| crate::fly::thumb_for(&p))
        .map(Picture::File);
    if !crate::fly::fly_back(win, picture, Landing::Image(None), still_closing, hidden) {
        crate::zoom::hide(win, still_closing, hidden);
    }
}

/// The window went away (its page will start over when it is made again).
pub fn forget() {
    READY.store(false, Ordering::SeqCst);
    DIRTY.store(false, Ordering::SeqCst);
}

/// The images directly in `dir` (not hidden ones), unsorted.
#[tauri::command(async)]
pub fn list_images(dir: String) -> Result<Vec<String>, String> {
    if crate::watcher::is_ejecting(&dir) {
        return Err("volume is being ejected".to_string());
    }
    let rd = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    Ok(rd
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let hidden = e.file_name().to_string_lossy().starts_with('.');
            if hidden || !is_image(&path) || !fs::metadata(&path).is_ok_and(|m| m.is_file()) {
                return None;
            }
            Some(path.to_string_lossy().into_owned())
        })
        .collect())
}

/// A copy of `path` the webview can show, made with `sips`: for RAW files,
/// HEIC where WebKit can't decode it, and files outside the asset scope.
#[tauri::command]
pub async fn viewer_image(path: String) -> Result<String, String> {
    if crate::watcher::is_ejecting(&path) {
        return Err("volume is being ejected".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        let dir = preview_dir("viewer", &meta).ok_or_else(|| "no cache directory".to_string())?;
        convert(&dir, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn convert(cache: &Path, path: &str) -> Result<String, String> {
    let src = Path::new(path);
    if !src.is_absolute() || !is_image(src) {
        return Err("unsupported image type".into());
    }
    let meta = fs::metadata(src).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if is_dataless(&meta) {
        return Err("file is not downloaded".into());
    }
    let png = PNG_EXTS.contains(&ext_of(src).as_str());
    let key = cache_key(src, &meta, 0);
    let out = cache.join(format!("{key}.{}", if png { "png" } else { "jpg" }));
    if out.exists() {
        touch(&out);
        return Ok(out.to_string_lossy().into_owned());
    }
    fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let tmp = cache.join(format!(
        "{key}.{}-{}.tmp",
        std::process::id(),
        NEXT_TMP.fetch_add(1, Ordering::Relaxed)
    ));
    let mut cmd = Command::new(SIPS);
    if png {
        cmd.args(["-s", "format", "png"]);
    } else {
        cmd.args(["-s", "format", "jpeg", "-s", "formatOptions", "90"]);
    }
    let mut child = cmd
        .arg(src)
        .arg("--out")
        .arg(&tmp)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    if !wait_or_kill(&mut child, CONVERT_TIMEOUT) || !tmp.exists() {
        let _ = fs::remove_file(&tmp);
        return Err("could not decode image".into());
    }
    fs::rename(&tmp, &out).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(out.to_string_lossy().into_owned())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08, 0x08, 0x06, 0x00, 0x00, 0x00, 0xc4,
        0x0f, 0xbe, 0x8b, 0x00, 0x00, 0x00, 0x12, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x38,
        0x61, 0x63, 0xf3, 0x1f, 0x1f, 0x66, 0x18, 0x19, 0x0a, 0x00, 0x0f, 0xbe, 0x8f, 0xc1, 0x56,
        0x80, 0x1f, 0xf8, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("doftar-viewer-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn lists_only_visible_images() {
        let dir = scratch("list");
        for name in ["a.png", "B.JPG", "c.heic", ".hidden.png", "notes.txt"] {
            fs::write(dir.join(name), PNG).unwrap();
        }
        fs::create_dir(dir.join("folder.png")).unwrap();
        let mut found: Vec<String> = list_images(dir.to_string_lossy().into_owned())
            .unwrap()
            .into_iter()
            .map(|p| Path::new(&p).file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        found.sort();
        assert_eq!(found, ["B.JPG", "a.png", "c.heic"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn converts_once_and_reuses_the_copy() {
        let dir = scratch("convert");
        let cache = dir.join("cache");
        let src = dir.join("pic.tiff");
        fs::write(&src, PNG).unwrap();
        let out = convert(&cache, src.to_str().unwrap()).unwrap();
        assert!(out.ends_with(".png"));
        assert!(fs::read(&out).unwrap().starts_with(&[0x89, b'P', b'N', b'G']));
        assert_eq!(convert(&cache, src.to_str().unwrap()).unwrap(), out);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_what_it_cannot_show() {
        let dir = scratch("bad");
        let cache = dir.join("cache");
        assert!(convert(&cache, "relative/pic.png").is_err());
        let txt = dir.join("notes.txt");
        fs::write(&txt, "hi").unwrap();
        assert!(convert(&cache, txt.to_str().unwrap()).is_err());
        let broken = dir.join("broken.jpg");
        fs::write(&broken, b"not an image").unwrap();
        assert!(convert(&cache, broken.to_str().unwrap()).is_err());
        assert!(!cache.exists() || fs::read_dir(&cache).unwrap().all(|e| {
            !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")
        }));
        fs::remove_dir_all(&dir).unwrap();
    }
}
