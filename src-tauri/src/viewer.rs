//! Image viewer: one window that shows an image and steps through the other images in its folder.

use crate::lock::Locked;
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

/// Keep in step with `VIEWER_EXTS` in src/util/kinds.ts.
const EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif", "tif", "tiff", "heic",
    "heif", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2",
];
/// Converted to PNG so transparency survives. The rest become JPEG.
const PNG_EXTS: &[&str] = &["png", "gif", "webp", "bmp", "ico", "tif", "tiff"];
/// A RAW file from a big sensor decodes slowly.
const CONVERT_TIMEOUT: Duration = Duration::from_secs(20);

/// Held while the window is looked up, made or marked ready. An open cannot then slip between the page listening and taking the opens it missed.
static OPENING: Mutex<()> = Mutex::new(());
/// Set when the page listens for `viewer:open`. Until then opens wait in `windows`.
static READY: AtomicBool = AtomicBool::new(false);
/// Increase on every open. A close's fallback hide then never hides a reopened window.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Set while the page has unsaved edits. Closing then asks first.
static DIRTY: AtomicBool = AtomicBool::new(false);
static NEXT_TMP: AtomicU64 = AtomicU64::new(1);

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ViewerOpen {
    path: String,
    order: Option<Vec<String>>,
    /// The thumbnail flies in. The page says when the image is drawn.
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

pub fn prewarm(app: &AppHandle) {
    let _guard = OPENING.locked();
    if app.get_webview_window(LABEL).is_none() {
        let _ = build(app);
    }
}

/// `from` is where the calling page draws the image icon. Returns true if the thumbnail flies in, so the page hides the icon until `viewer:flown`.
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
    let _guard = OPENING.locked();
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let win = match app.get_webview_window(LABEL) {
        Some(win) => win,
        None => build(&app)?,
    };
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
        // The page shows the window after it paints this image.
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

/// Returns an image that was asked for before the page listened. Async, so it does not wait on the main thread while `build` holds the lock there.
#[tauri::command(async)]
pub fn viewer_ready() -> Option<serde_json::Value> {
    let _guard = OPENING.locked();
    READY.store(true, Ordering::SeqCst);
    crate::windows::take(LABEL)
}

#[tauri::command]
pub fn viewer_set_dirty(dirty: bool) {
    DIRTY.store(dirty, Ordering::SeqCst);
}

pub fn is_dirty() -> bool {
    DIRTY.load(Ordering::SeqCst)
}

/// Hides the window, so the next image opens at once.
/// The image flies back into its thumbnail if the listing still shows it. Otherwise the window zooms out.
/// AppKit animates both, so they stay smooth when the page is busy.
/// Unsaved edits make the page ask first. It closes again after save or discard.
/// An image opened during the zoom keeps the window up. Runs on the main thread.
pub fn close_requested(win: &Window) {
    if DIRTY.load(Ordering::SeqCst) {
        let _ = win.emit_to(LABEL, "viewer:confirm-close", ());
        return;
    }
    crate::fly::cancel();
    // A close is a new turn too, so a pending fallback show from the last open cannot bring the window back.
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let still_closing = move || GENERATION.load(Ordering::SeqCst) == generation;
    // The page drops the image only now, so it does not vanish during the zoom.
    let hidden = |w: &Window| {
        let _ = w.emit_to(LABEL, "viewer:hidden", ());
    };
    let picture = crate::fly::shown_path(LABEL)
        .and_then(|p| crate::fly::thumb_for(&p))
        .map(Picture::File);
    if !crate::fly::fly_back(win, picture, Landing::Image(None), still_closing, hidden) {
        crate::zoom::hide(win, still_closing, hidden);
    }
}

/// The window went away. The page starts over when the window is made again.
pub fn forget() {
    READY.store(false, Ordering::SeqCst);
    DIRTY.store(false, Ordering::SeqCst);
}

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

/// A copy of `path` that the webview can show, made with `sips`. Used for RAW files, HEIC that WebKit cannot decode, and files outside the asset scope.
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
