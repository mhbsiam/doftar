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
    let p = crate::paths::real(&path);
    if !p.is_absolute() || !is_video(&(p)) {
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

/// URL scheme for the player and the preview pane. Pages ask for it with `convertFileSrc(path, "media")`.
pub const SCHEME: &str = "media";
/// Bytes sent for a range with no end, as Tauri's asset protocol does.
const CHUNK: u64 = 1000 * 1024;
/// Most bytes held in memory for one bounded range.
const MAX_SPAN: u64 = 64 * 1024 * 1024;

/// The asset protocol cuts every range at 1000 KB. AVFoundation asks for a track's sample table in one range and drops the track if the reply is short.
/// A long video then plays with no sound. This scheme sends a bounded range whole. It allows the same paths as the asset scope, for player files only.
/// Remove this when Tauri's asset protocol sends a whole bounded range.
pub fn serve<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let scope = ctx.app_handle().asset_protocol_scope();
    tauri::async_runtime::spawn_blocking(move || {
        let response = media_response(&request, |p| scope.is_allowed(p)).unwrap_or_else(|e| {
            eprintln!("Doftar: media protocol: {e}");
            status(500)
        });
        responder.respond(response);
    });
}

type Response = tauri::http::Response<Vec<u8>>;

fn status(code: u16) -> Response {
    tauri::http::Response::builder().status(code).body(Vec::new()).unwrap()
}

fn media_response(request: &tauri::http::Request<Vec<u8>>, allowed: impl Fn(&Path) -> bool) -> std::io::Result<Response> {
    use std::io::{Read, Seek, SeekFrom};
    use tauri::http::header::*;

    let raw = request.uri().path();
    let path = percent_encoding::percent_decode_str(raw.strip_prefix('/').unwrap_or(raw)).decode_utf8_lossy();
    let Ok(safe) = tauri::path::SafePathBuf::new(path.as_ref().into()) else {
        return Ok(status(403));
    };
    if !is_video(safe.as_ref()) || !allowed(safe.as_ref()) {
        return Ok(status(403));
    }
    let mut file = match fs::File::open(&safe) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(status(404)),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => return Ok(status(403)),
        Err(e) => return Err(e),
    };
    let len = file.metadata()?.len();
    let mut magic = Vec::new();
    (&mut file).take(8192).read_to_end(&mut magic)?;
    let mime = tauri::utils::mime_type::MimeType::parse(&magic, &path);
    let resp = tauri::http::Response::builder()
        .header(CONTENT_TYPE, mime)
        .header(ACCEPT_RANGES, "bytes");
    if request.method() == tauri::http::Method::HEAD {
        return Ok(resp.header(CONTENT_LENGTH, len).body(Vec::new()).unwrap());
    }
    // A request with no range gets the first chunk as a range, so a large file is never read whole.
    let header = request.headers().get(RANGE).and_then(|r| r.to_str().ok()).unwrap_or("bytes=0-");
    let unsatisfiable = |resp: tauri::http::response::Builder| {
        resp.status(416).header(CONTENT_RANGE, format!("bytes */{len}")).body(Vec::new()).unwrap()
    };
    let Some((start, end)) = span(header, len) else {
        return Ok(unsatisfiable(resp));
    };
    let mut buf = Vec::with_capacity((end + 1 - start) as usize);
    file.seek(SeekFrom::Start(start))?;
    file.take(end + 1 - start).read_to_end(&mut buf)?;
    // The file got shorter after its size was read.
    if buf.is_empty() {
        return Ok(unsatisfiable(resp));
    }
    Ok(resp
        .status(206)
        .header(CONTENT_RANGE, format!("bytes {start}-{}/{len}", start + buf.len() as u64 - 1))
        .header(CONTENT_LENGTH, buf.len())
        .body(buf)
        .unwrap())
}

/// The inclusive byte span to send for a single `Range` header, or None if it can't be met.
/// A bounded range comes back whole up to `MAX_SPAN`. A range with no end gets `CHUNK` bytes.
fn span(header: &str, len: u64) -> Option<(u64, u64)> {
    let (from, to) = header.strip_prefix("bytes=")?.split_once('-')?;
    let (from, to) = (from.trim(), to.trim());
    let (start, end) = match (from, to) {
        ("", n) => (len.saturating_sub(n.parse().ok()?), len.checked_sub(1)?),
        (s, "") => {
            let s: u64 = s.parse().ok()?;
            (s, s.saturating_add(CHUNK - 1))
        }
        (s, e) => (s.parse().ok()?, e.parse().ok()?),
    };
    let end = end.min(len.checked_sub(1)?).min(start.saturating_add(MAX_SPAN - 1));
    (start <= end).then_some((start, end))
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
        assert!(is_video(&(crate::paths::real("/a/clip.MP4"))));
        assert!(is_video(&(crate::paths::real("/a/clip.webm"))));
        assert!(is_video(&(crate::paths::real("/a/song.FLAC"))));
        assert!(!is_video(&(crate::paths::real("/a/song.ogg"))));
        assert!(!is_video(&(crate::paths::real("/a/clip.mkv"))));
        assert!(!is_video(&(crate::paths::real("/a/clip"))));
    }

    #[test]
    fn sends_a_bounded_range_whole() {
        // The audio sample table of a 96-minute video. The asset protocol cut it at 1000 KB and the sound went away.
        assert_eq!(span("bytes=1477618-2555461", 960_111_774), Some((1_477_618, 2_555_461)));
        assert_eq!(span("bytes=0-1", 10), Some((0, 1)));
        assert_eq!(span("bytes=5-", 10), Some((5, 9)));
        assert_eq!(span("bytes=0-", 10_000_000), Some((0, CHUNK - 1)));
        assert_eq!(span("bytes=-4", 10), Some((6, 9)));
        assert_eq!(span("bytes=0-999999999", 1 << 40), Some((0, MAX_SPAN - 1)));
        assert_eq!(span("bytes=10-", 10), None);
        assert_eq!(span("bytes=8-3", 10), None);
        assert_eq!(span("bytes=0-1, 4-5", 10), None);
        assert_eq!(span("bytes=0-", 0), None);
    }

    #[test]
    fn media_reads_only_allowed_player_files() {
        let dir = std::env::temp_dir().join(format!("doftar-media-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("clip.mp4");
        let note = dir.join("note.txt");
        fs::write(&clip, b"0123456789").unwrap();
        fs::write(&note, b"secret").unwrap();
        let get = |path: &Path, range: &str, allow: bool| {
            let uri = format!("media://localhost/{}", percent_encoding::utf8_percent_encode(&path.to_string_lossy(), percent_encoding::NON_ALPHANUMERIC));
            let request = tauri::http::Request::builder().uri(uri).header("range", range).body(Vec::new()).unwrap();
            media_response(&request, |_| allow).unwrap()
        };

        assert_eq!(get(&note, "bytes=0-5", true).status(), 403);
        assert_eq!(get(&clip, "bytes=0-5", false).status(), 403);
        let ok = get(&clip, "bytes=2-5", true);
        assert_eq!(ok.status(), 206);
        assert_eq!(ok.headers()["content-range"], "bytes 2-5/10");
        assert_eq!(ok.body(), b"2345");
        assert_eq!(get(&clip, "bytes=10-", true).status(), 416);
        fs::remove_dir_all(&dir).unwrap();
    }
}
