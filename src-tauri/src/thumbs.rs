use crate::lock::Locked;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// macOS re-encodes with sips. Linux decodes in process; see `make_image_thumbnail`.
#[cfg(target_os = "macos")]
pub(crate) const SIPS: &str = "/usr/bin/sips";
const MAX_SOURCE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CONCURRENT: usize = 4;
const CACHE_MAX_BYTES: u64 = 256 * 1024 * 1024;
const CACHE_TRIM_TO_BYTES: u64 = 192 * 1024 * 1024;
/// A cache hit refreshes the file time. Thumbnails unused for this long are removed.
const CACHE_MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);

const EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "heic", "heif", "webp",
];

const QL_EXTS: &[&str] = &[
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key", "rtf", "rtfd",
    "mov", "mp4", "m4v", "avi", "mkv", "webm", "mp3", "m4a", "aac", "wav", "flac", "aif", "aiff",
    "svg", "psd", "ai", "eps", "epub",
];
/// The Quick Look types a Linux tool can render. The rest of `QL_EXTS` falls back to an icon.
#[cfg(not(target_os = "macos"))]
const VIDEO_QL: &[&str] = &["mov", "mp4", "m4v", "avi", "mkv", "webm"];
#[cfg(not(target_os = "macos"))]
const AUDIO_QL: &[&str] = &["mp3", "m4a", "aac", "wav", "flac", "aif", "aiff"];
const QL_MAX_CONCURRENT: usize = 2;
const QL_TIMEOUT: Duration = Duration::from_secs(6);
#[cfg(target_os = "macos")]
pub(crate) const SF_DATALESS: u32 = 0x4000_0000;
/// Prefix of an error that can pass, for example a file still in iCloud. The interface tries again later.
pub(crate) const TRANSIENT: &str = "transient: ";

fn transient(msg: impl std::fmt::Display) -> String {
    format!("{TRANSIENT}{msg}")
}

/// Mark the error transient, unless the file is missing or not allowed. A retry does not help there.
fn io_failure(e: std::io::Error) -> String {
    use std::io::ErrorKind::{InvalidInput, NotFound, PermissionDenied};
    match e.kind() {
        NotFound | PermissionDenied | InvalidInput => e.to_string(),
        _ => transient(e),
    }
}

/// A failed spawn of a missing tool is permanent: the retry loop would spin forever on a binary that
/// is not there. Only genuine timeouts and IO hiccups stay transient.
fn spawn_failure(e: std::io::Error) -> String {
    use std::io::ErrorKind::NotFound;
    match e.kind() {
        NotFound => e.to_string(),
        _ => transient(e),
    }
}

struct Gate {
    running: Mutex<usize>,
    cv: Condvar,
    limit: usize,
}
struct Permit<'a>(&'a Gate);

/// Gives each scratch file a unique name. Two renders of one thumbnail then never share a file.
static NEXT_TMP: AtomicU64 = AtomicU64::new(1);

fn tmp_path(cache: &Path, key: &str) -> PathBuf {
    cache.join(format!(
        "{key}.{}.{}.tmp",
        std::process::id(),
        NEXT_TMP.fetch_add(1, Ordering::Relaxed)
    ))
}

static GATE: Gate = Gate {
    running: Mutex::new(0),
    cv: Condvar::new(),
    limit: MAX_CONCURRENT,
};
static QL_GATE: Gate = Gate {
    running: Mutex::new(0),
    cv: Condvar::new(),
    limit: QL_MAX_CONCURRENT,
};

impl Gate {
    fn acquire(&self) -> Permit<'_> {
        let mut n = self.running.locked();
        while *n >= self.limit {
            n = self.cv.wait(n).unwrap_or_else(|e| e.into_inner());
        }
        *n += 1;
        Permit(self)
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        *self.0.running.locked() -= 1;
        self.0.cv.notify_one();
    }
}

pub(crate) fn cache_root() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join("com.doftar.app"))
}

/// Previews of files on other volumes go in `session/<device>/`. cache.rs deletes them when the volume goes or Doftar quits.
pub(crate) fn session_root() -> Option<PathBuf> {
    cache_root().map(|d| d.join("session"))
}

fn startup_devices() -> &'static [u64] {
    static DEVICES: OnceLock<Vec<u64>> = OnceLock::new();
    DEVICES.get_or_init(|| {
        [Some(crate::paths::real("/")), dirs::home_dir()]
            .into_iter()
            .flatten()
            .filter_map(|p| fs::metadata(p).ok())
            .map(|m| m.dev())
            .collect()
    })
}

/// `kind` is "thumbs", "viewer" or "pdf-pages". Startup disk files get the lasting folder. Others get the session folder.
pub(crate) fn preview_dir(kind: &str, meta: &fs::Metadata) -> Option<PathBuf> {
    if startup_devices().contains(&meta.dev()) {
        cache_root().map(|d| d.join(kind))
    } else {
        session_root().map(|d| d.join(meta.dev().to_string()).join(kind))
    }
}

fn cache_dir(path: &str) -> Result<PathBuf, String> {
    // The bridge string can hold private-use chars for raw bytes; stat the real path.
    let meta = fs::metadata(crate::paths::real(path)).map_err(io_failure)?;
    preview_dir("thumbs", &meta).ok_or_else(|| "no cache directory".to_string())
}

pub(crate) fn cache_key(src: &Path, meta: &fs::Metadata, dim: u32) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut h = DefaultHasher::new();
    src.hash(&mut h);
    mtime.hash(&mut h);
    meta.len().hash(&mut h);
    dim.hash(&mut h);
    format!("{:016x}", h.finish())
}

const SCRATCH_MAX_AGE: Duration = Duration::from_secs(60 * 60);

pub(crate) fn prune(dir: &Path) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    let mut files: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    for e in rd.flatten() {
        let Ok(m) = e.metadata() else { continue };
        let used = m.modified().unwrap_or(now);
        let age = now.duration_since(used).unwrap_or_default();
        if !m.is_file() {
            // Remove old `{key}.{pid}.d` scratch dirs. Older builds left them after a crash.
            if m.is_dir()
                && e.file_name().to_string_lossy().ends_with(".d")
                && age > SCRATCH_MAX_AGE
            {
                let _ = fs::remove_dir_all(e.path());
            }
            continue;
        }
        // `.tmp` is the scratch suffix. A crash mid-render also leaves the tool's own output
        // behind, named `{key}.{pid}.{n}.tmp.png` (ffmpeg) or `.tmp-pp.png` (pdftoppm).
        if e.file_name().to_string_lossy().contains(".tmp") && age > SCRATCH_MAX_AGE {
            let _ = fs::remove_file(e.path());
            continue;
        }
        if now.duration_since(used).unwrap_or_default() > CACHE_MAX_AGE {
            let _ = fs::remove_file(e.path());
            continue;
        }
        files.push((used, m.len(), e.path()));
    }
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= CACHE_MAX_BYTES {
        return;
    }
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= CACHE_TRIM_TO_BYTES {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total -= len;
        }
    }
}

/// The icns of a macOS `.app` bundle. Linux has no `.app` bundles, so the lookup never finds one
/// and the thumbnail falls back to the plain icon.
#[cfg(target_os = "macos")]
fn app_icon(app: &Path) -> Option<PathBuf> {
    let info = plist::Value::from_file(app.join("Contents").join("Info.plist")).ok()?;
    let name = info.as_dictionary()?.get("CFBundleIconFile")?.as_string()?;
    if name.is_empty() || name.contains('/') {
        return None;
    }
    let res = app.join("Contents").join("Resources");
    let file = if name.to_ascii_lowercase().ends_with(".icns") {
        res.join(name)
    } else {
        res.join(format!("{name}.icns"))
    };
    file.is_file().then_some(file)
}

#[cfg(not(target_os = "macos"))]
fn app_icon(_app: &Path) -> Option<PathBuf> {
    None
}

#[cfg(target_os = "macos")]
pub(crate) fn wait_or_kill(child: &mut std::process::Child, limit: Duration) -> bool {
    wait_within(child, limit).unwrap_or(false)
}

/// Returns `None` if the child ran past `limit` or could not be waited on. The child is killed.
fn wait_within(child: &mut std::process::Child, limit: Duration) -> Option<bool> {
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.success()),
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// The largest width or height in `src`. Read from the header, without a decode.
#[cfg(target_os = "macos")]
fn pixel_max(src: &Path) -> Option<u32> {
    use objc2_core_foundation::{
        CFDictionary, CFNumber, CFRetained, CFString, CFType, CFURLPathStyle, CFURL,
    };
    use objc2_image_io::{kCGImagePropertyPixelHeight, kCGImagePropertyPixelWidth, CGImageSource};

    let s = CFString::from_str(&src.to_string_lossy());
    let url = CFURL::with_file_system_path(None, Some(&s), CFURLPathStyle::CFURLPOSIXPathStyle, false)?;
    // SAFETY: ImageIO calls with a valid URL. Property dictionaries have CFString keys.
    let source = unsafe { CGImageSource::with_url(&url, None) }?;
    (0..unsafe { source.count() })
        .take(64)
        .filter_map(|i| {
            let props = unsafe { source.properties_at_index(i, None) }?;
            let props: CFRetained<CFDictionary<CFString, CFType>> =
                unsafe { CFRetained::cast_unchecked(props) };
            let num = |key: &CFString| {
                props
                    .get(key)
                    .and_then(|v| v.downcast::<CFNumber>().ok())
                    .and_then(|n| n.as_i64())
            };
            let w = num(unsafe { kCGImagePropertyPixelWidth })?;
            let h = num(unsafe { kCGImagePropertyPixelHeight })?;
            Some(w.max(h))
        })
        .max()
        .and_then(|m| u32::try_from(m).ok())
        .filter(|&m| m > 0)
}

/// The largest width or height in `src`. Read from the header, without a decode.
#[cfg(not(target_os = "macos"))]
fn pixel_max(src: &Path) -> Option<u32> {
    image::ImageReader::open(src)
        .ok()?
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
        .map(|(w, h)| w.max(h))
        .filter(|&m| m > 0)
}

pub(crate) fn is_dataless(meta: &fs::Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt as _;
        meta.st_flags() & SF_DATALESS != 0
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = meta;
        false
    }
}

struct Located {
    src: PathBuf,
    out: PathBuf,
    /// Lowercase extension of the source, without the dot. Only the Linux thumbnailer reads it.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    ext: String,
    dim: u32,
    quick_look: bool,
    png: bool,
}

/// The largest thumbnail, for a picture zoomed in the preview bar.
const MAX_DIM: u32 = 3200;

fn locate(cache: &Path, path: &str, max_dim: u32) -> Result<Located, String> {
    let src = crate::paths::real(path);
    if !src.is_absolute() {
        return Err("path must be absolute".into());
    }
    let is_app = src
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("app"));
    let ext_of = |p: &Path| {
        p.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default()
    };
    if !is_app && QL_EXTS.contains(&ext_of(&(src)).as_str()) {
        let dim = max_dim.clamp(16, MAX_DIM);
        let meta = fs::metadata(&src).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("not a file".into());
        }
        if is_dataless(&meta) {
            return Err(transient("file is not downloaded"));
        }
        let key = format!("ql-{}", cache_key(&(src), &meta, dim));
        return Ok(Located {
            src: src.to_path_buf(),
            out: cache.join(format!("{key}.png")),
            ext: ext_of(&(src)),
            dim,
            quick_look: true,
            png: true,
        });
    }
    let (src, ext) = if is_app {
        let icns = app_icon(&(src)).ok_or_else(|| "no app icon".to_string())?;
        (icns, "png".to_string())
    } else {
        let ext = ext_of(&(src));
        if !EXTS.contains(&ext.as_str()) {
            return Err("unsupported image type".into());
        }
        // No HEIC decoder exists in the image crate, so a retry will never help.
        #[cfg(not(target_os = "macos"))]
        if matches!(ext.as_str(), "heic" | "heif") {
            return Err("HEIC thumbnails need macOS".into());
        }
        (src.to_path_buf(), ext)
    };
    let meta = fs::metadata(&src).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_SOURCE_BYTES {
        return Err("image too large".into());
    }
    if is_dataless(&meta) {
        return Err(transient("file is not downloaded"));
    }
    let dim = max_dim.clamp(16, MAX_DIM);
    let png = matches!(ext.as_str(), "png" | "gif" | "webp" | "tif" | "tiff");
    let key = cache_key(&src, &meta, dim);
    let out = cache.join(format!("{key}.{}", if png { "png" } else { "jpg" }));
    Ok(Located { src, out, ext, dim, quick_look: false, png })
}

/// Refresh the file time so pruning removes unused files first. Skip it if less than a day old.
pub(crate) fn touch(file: &Path) {
    let day = Duration::from_secs(24 * 60 * 60);
    let stale = fs::metadata(file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age > day);
    if stale {
        if let Ok(f) = fs::OpenOptions::new().append(true).open(file) {
            let _ = f.set_modified(SystemTime::now());
        }
    }
}

/// Requests the interface no longer wants.
static CANCELLED: Mutex<Vec<u64>> = Mutex::new(Vec::new());

fn is_cancelled(req: Option<u64>) -> bool {
    req.is_some_and(|id| CANCELLED.locked().contains(&id))
}

#[tauri::command(async)]
pub fn cancel_thumbnail(request_id: u64) {
    let mut list = CANCELLED.locked();
    if list.len() > 512 {
        list.drain(..256); // Ids only grow. The oldest requests are finished.
    }
    list.push(request_id);
}

/// CGImage is immutable and safe on any thread. objc2 does not mark it `Send`.
#[cfg(target_os = "macos")]
struct SentImage(objc2_core_foundation::CFRetained<objc2_core_graphics::CGImage>);
#[cfg(target_os = "macos")]
unsafe impl Send for SentImage {}

/// Use the sandboxed QuickLookThumbnailing service. Spawning `qlmanage` does not work. Waits at most `QL_TIMEOUT`.
#[cfg(target_os = "macos")]
fn ql_render(src: &Path, dim: u32) -> Result<SentImage, String> {
    use block2::RcBlock;
    use objc2::AllocAnyThread;
    use objc2_core_foundation::CGSize;
    use objc2_foundation::{NSError, NSURL};
    use objc2_quick_look_thumbnailing::{
        QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes,
        QLThumbnailGenerator, QLThumbnailRepresentation,
    };
    use std::sync::mpsc;

    let url = NSURL::from_file_path(src).ok_or("invalid path")?;
    let size = CGSize { width: dim as f64, height: dim as f64 };
    // SAFETY: plain constructor calls. The request lives until the generator is done with it.
    let request = unsafe {
        QLThumbnailGenerationRequest::initWithFileAtURL_size_scale_representationTypes(
            QLThumbnailGenerationRequest::alloc(),
            &url,
            size,
            1.0,
            QLThumbnailGenerationRequestRepresentationTypes::Thumbnail,
        )
    };
    let (tx, rx) = mpsc::channel::<Result<SentImage, String>>();
    let handler = RcBlock::new(move |rep: *mut QLThumbnailRepresentation, err: *mut NSError| {
        // SAFETY: Quick Look passes a live representation or a live error. Both are valid during this call.
        let outcome = match unsafe { rep.as_ref() } {
            Some(rep) => Ok(SentImage(unsafe { rep.CGImage() }.into())),
            None => Err(unsafe { err.as_ref() }
                .map(|e| e.localizedDescription().to_string())
                .unwrap_or_else(|| "Quick Look couldn't render a thumbnail".into())),
        };
        let _ = tx.send(outcome);
    });
    // SAFETY: the shared generator is thread-safe. The framework retains the block until it runs.
    let generator = unsafe { QLThumbnailGenerator::sharedGenerator() };
    unsafe { generator.generateBestRepresentationForRequest_completionHandler(&request, &handler) };
    match rx.recv_timeout(QL_TIMEOUT) {
        Ok(res) => res,
        Err(_) => {
            unsafe { generator.cancelRequest(&request) };
            Err(transient("Quick Look took too long to render a thumbnail"))
        }
    }
}

#[cfg(target_os = "macos")]
fn write_png(image: &objc2_core_graphics::CGImage, out: &Path) -> Result<(), String> {
    use objc2_core_foundation::{CFString, CFURLPathStyle, CFURL};
    use objc2_image_io::CGImageDestination;

    let s = CFString::from_str(&out.to_string_lossy());
    let url = CFURL::with_file_system_path(None, Some(&s), CFURLPathStyle::CFURLPOSIXPathStyle, false)
        .ok_or("invalid path")?;
    let ty = CFString::from_str("public.png");
    // SAFETY: ImageIO calls with a valid URL, type identifier and image.
    let dest = unsafe { CGImageDestination::with_url(&url, &ty, 1, None) }
        .ok_or("couldn't write the thumbnail")?;
    unsafe { dest.add_image(image, None) };
    if unsafe { dest.finalize() } {
        Ok(())
    } else {
        Err("couldn't write the thumbnail".into())
    }
}

/// A tool is probed once. A missing one is permanent, so the interface shows an icon
/// instead of retrying forever.
#[cfg(not(target_os = "macos"))]
static FFMPEG: OnceLock<bool> = OnceLock::new();
#[cfg(not(target_os = "macos"))]
static PDFTOPPM: OnceLock<bool> = OnceLock::new();

#[cfg(not(target_os = "macos"))]
fn tool_ready(bin: &str, probe: &[&str], ready: &OnceLock<bool>) -> bool {
    *ready.get_or_init(|| {
        Command::new(bin)
            .args(probe)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    })
}

/// Run `bin` on `args`, wait at most `QL_TIMEOUT`, then report. The child is killed when slow.
/// A nonzero exit or a lost output file is permanent; a timeout is transient, like Quick Look's.
#[cfg(not(target_os = "macos"))]
fn run_tool(bin: &str, args: &[&std::ffi::OsStr], made: &Path) -> Result<(), String> {
    let mut child = Command::new(bin)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(spawn_failure)?;
    match wait_within(&mut child, QL_TIMEOUT) {
        None => {
            let _ = fs::remove_file(made);
            Err(transient(format!("{bin} took too long to render a thumbnail")))
        }
        Some(false) => {
            // A failed run can still leave a broken picture behind. Take it too.
            let _ = fs::remove_file(made);
            Err(format!("{bin} couldn't render a thumbnail"))
        }
        Some(true) if fs::metadata(made).is_ok() => Ok(()),
        Some(true) => Err(format!("{bin} couldn't render a thumbnail")),
    }
}

/// The first frame, scaled to fit `dim x dim` without upscaling, as a PNG.
#[cfg(not(target_os = "macos"))]
fn render_video_frame(src: &Path, dim: u32, tmp: &Path) -> Result<(), String> {
    if !tool_ready("ffmpeg", &["-version"], &FFMPEG) {
        return Err("video thumbnails need ffmpeg".into());
    }
    // min(iw|ih, dim) keeps a small video at its own size; the ratio mode then fits the
    // frame inside the box, keeping its shape. Quoted commas are ffmpeg's, not the shell's.
    let vf = format!("scale=w='min(iw,{dim})':h='min(ih,{dim})':force_original_aspect_ratio=decrease");
    let mut frame = tmp.as_os_str().to_os_string();
    frame.push(".png");
    let ok = run_tool(
        "ffmpeg",
        &[
            "-y".as_ref(),
            "-v".as_ref(),
            "error".as_ref(),
            "-ss".as_ref(),
            "0".as_ref(),
            "-i".as_ref(),
            src.as_os_str(),
            "-frames:v".as_ref(),
            "1".as_ref(),
            "-vf".as_ref(),
            vf.as_ref(),
            "-f".as_ref(),
            "image2".as_ref(),
            frame.as_os_str(),
        ],
        Path::new(&frame),
    );
    if ok.is_err() {
        let _ = fs::remove_file(&frame);
        return ok;
    }
    fs::rename(&frame, tmp).map_err(|e| e.to_string())
}

/// The first page, `dim` wide and as tall as the page is, as a PNG.
#[cfg(not(target_os = "macos"))]
fn render_pdf_page(src: &Path, dim: u32, tmp: &Path) -> Result<(), String> {
    if !tool_ready("pdftoppm", &["-v"], &PDFTOPPM) {
        return Err("PDF thumbnails need pdftoppm".into());
    }
    // `-singlefile` drops the page number, so the output is exactly `<base>.png`.
    let mut base = tmp.as_os_str().to_os_string();
    base.push("-pp");
    let mut made = base.clone();
    made.push(".png");
    let dim = dim.to_string();
    let ok = run_tool(
        "pdftoppm",
        &[
            "-png".as_ref(),
            "-singlefile".as_ref(),
            "-scale-to-x".as_ref(),
            dim.as_ref(),
            "-scale-to-y".as_ref(),
            "-1".as_ref(),
            src.as_os_str(),
            base.as_os_str(),
        ],
        Path::new(&made),
    );
    if ok.is_err() {
        let _ = fs::remove_file(&made);
        return ok;
    }
    fs::rename(&made, tmp).map_err(|e| e.to_string())
}

/// Videos through ffmpeg, PDFs through pdftoppm. Office documents, audio, SVG, EPS and the
/// rest of Quick Look have no renderer here: the permanent error falls back to an icon.
#[cfg(not(target_os = "macos"))]
fn make_ql_thumbnail(loc: &Located, cache: &Path, req: Option<u64>) -> Result<String, String> {
    let out = &loc.out;
    let key = out
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let _permit = QL_GATE.acquire();
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    if is_cancelled(req) {
        return Err("cancelled".into());
    }
    let tmp = tmp_path(cache, &key);
    let rendered = match loc.ext.as_str() {
        ext if VIDEO_QL.contains(&ext) => render_video_frame(&loc.src, loc.dim, &tmp),
        ext if AUDIO_QL.contains(&ext) => Err("audio has no picture preview".into()),
        "pdf" => render_pdf_page(&loc.src, loc.dim, &tmp),
        _ => Err("this document type has no preview on Linux".into()),
    };
    if let Err(e) = rendered {
        let _ = fs::remove_file(&tmp);
        return Err(e); // Render failures are permanent. A retry would fail the same way.
    }
    fs::rename(&tmp, out).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        transient(e) // A cache write error is not a file error. Allow a retry.
    })?;
    Ok(out.to_string_lossy().into_owned())
}

#[cfg(target_os = "macos")]
fn make_ql_thumbnail(loc: &Located, cache: &Path, req: Option<u64>) -> Result<String, String> {
    let out = &loc.out;
    let key = out
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let _permit = QL_GATE.acquire();
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    if is_cancelled(req) {
        return Err("cancelled".into());
    }
    let image = ql_render(&loc.src, loc.dim)?;
    if is_cancelled(req) {
        return Err("cancelled".into());
    }
    let tmp = tmp_path(cache, &key);
    let made = write_png(&image.0, &tmp).and_then(|()| fs::rename(&tmp, out).map_err(|e| e.to_string()));
    if made.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    // A cache write error is not a file error. Allow a retry.
    made.map_err(transient)?;
    Ok(out.to_string_lossy().into_owned())
}

/// Fit `(w, h)` inside `dim x dim`, keeping the shape, and never growing the picture.
#[cfg(not(target_os = "macos"))]
fn scaled_dims(w: u32, h: u32, dim: u32) -> (u32, u32) {
    let m = w.max(h);
    if m == 0 || m <= dim {
        return (w, h);
    }
    let k = f64::from(dim) / f64::from(m);
    (
        (f64::from(w) * k).round().max(1.0) as u32,
        (f64::from(h) * k).round().max(1.0) as u32,
    )
}

/// Decoded pixels, EXIF-oriented to match the viewer, scaled to fit `dim`. A gif contributes
/// its first frame, as on macOS.
#[cfg(not(target_os = "macos"))]
fn decode_scaled(src: &Path, dim: u32) -> Result<image::DynamicImage, String> {
    use image::metadata::Orientation;
    use image::ImageDecoder as _;

    let mut decoder = image::ImageReader::open(src)
        .map_err(io_failure)?
        .with_guessed_format()
        .map_err(io_failure)?
        .into_decoder()
        .map_err(|_| "could not decode image".to_string())?;
    // WebKitGTK honours the EXIF orientation when showing the file, so bake it in here.
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = image::DynamicImage::from_decoder(decoder)
        .map_err(|_| "could not decode image".to_string())?;
    img.apply_orientation(orientation);
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err("could not decode image".into());
    }
    let (nw, nh) = scaled_dims(w, h, dim);
    if (nw, nh) == (w, h) {
        return Ok(img);
    }
    Ok(img.resize_exact(nw, nh, image::imageops::FilterType::Triangle))
}

/// PNG keeps the transparency formats honest; the rest are JPEG at 70, as sips' `formatOptions` was.
#[cfg(not(target_os = "macos"))]
fn encode_thumbnail(img: &image::DynamicImage, png: bool, tmp: &Path) -> Result<(), String> {
    let mut file = fs::File::create(tmp).map_err(io_failure)?;
    let saved = if png {
        img.write_to(&mut file, image::ImageFormat::Png)
    } else {
        img.write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(file, 70))
    };
    saved.map_err(|_| "couldn't write the thumbnail".to_string())
}

/// The image crate decodes in process, so there is no child to time out. A huge file is
/// bounded by the `MAX_SOURCE_BYTES` check in `locate`.
#[cfg(not(target_os = "macos"))]
fn make_image_thumbnail(loc: &Located, cache: &Path, req: Option<u64>) -> Result<String, String> {
    let out = &loc.out;
    let _permit = GATE.acquire();
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    if is_cancelled(req) {
        return Err("cancelled".into());
    }
    let key = out
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = tmp_path(cache, &key);
    // A request bigger than the image must not scale it up, like `-Z` on macOS.
    let dim = pixel_max(&loc.src).map_or(loc.dim, |m| loc.dim.min(m));
    let img = decode_scaled(&loc.src, dim)?;
    encode_thumbnail(&img, loc.png, &tmp)?;
    if let Err(e) = fs::rename(&tmp, out) {
        let _ = fs::remove_file(&tmp);
        return Err(transient(e)); // A cache write error is not a file error. Allow a retry.
    }
    Ok(out.to_string_lossy().into_owned())
}

#[cfg(target_os = "macos")]
fn make_image_thumbnail(loc: &Located, cache: &Path, req: Option<u64>) -> Result<String, String> {
    let out = &loc.out;
    let _permit = GATE.acquire();
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    if is_cancelled(req) {
        return Err("cancelled".into());
    }
    let key = out
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (format, jpeg) = if loc.png { ("png", false) } else { ("jpeg", true) };
    let tmp = tmp_path(cache, &key);
    // `-Z` also scales up. Limit it to the image size.
    let dim = pixel_max(&loc.src).map_or(loc.dim, |m| loc.dim.min(m));
    let mut cmd = Command::new(SIPS);
    cmd.args(["-s", "format", format]);
    if jpeg {
        cmd.args(["-s", "formatOptions", "70"]);
    }
    let mut child = cmd
        .arg("-Z")
        .arg(dim.to_string())
        .arg(&loc.src)
        .arg("--out")
        .arg(&tmp)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        // A missing sips is permanent: the retry loop would spin forever.
        .map_err(spawn_failure)?;
    // sips has no timeout. A stalled network file must not hold a thumbnail slot forever.
    match wait_within(&mut child, QL_TIMEOUT) {
        Some(true) if tmp.exists() => {}
        waited => {
            let _ = fs::remove_file(&tmp);
            return Err(match waited {
                None => transient("image took too long to decode"),
                Some(_) => "could not decode image".into(),
            });
        }
    }
    fs::rename(&tmp, out).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        transient(e)
    })?;
    Ok(out.to_string_lossy().into_owned())
}

fn make_thumbnail_for(
    cache: &Path,
    path: &str,
    max_dim: u32,
    req: Option<u64>,
) -> Result<String, String> {
    let loc = locate(cache, path, max_dim)?;
    if loc.out.exists() {
        touch(&loc.out);
        return Ok(loc.out.to_string_lossy().into_owned());
    }
    if is_cancelled(req) {
        return Err("cancelled".into());
    }
    fs::create_dir_all(cache).map_err(transient)?;
    if loc.quick_look {
        make_ql_thumbnail(&loc, cache, req)
    } else {
        make_image_thumbnail(&loc, cache, req)
    }
}

#[cfg(test)]
fn make_thumbnail(cache: &Path, path: &str, max_dim: u32) -> Result<String, String> {
    make_thumbnail_for(cache, path, max_dim, None)
}

#[tauri::command]
pub async fn thumbnail(path: String, max_dim: u32, request_id: Option<u64>) -> Result<String, String> {
    if crate::watcher::is_ejecting(&path) {
        return Err("volume is being ejected".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dir = cache_dir(&path)?;
        make_thumbnail_for(&dir, &path, max_dim, request_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn cached(path: &str, max_dim: u32) -> Option<PathBuf> {
    let dir = cache_dir(path).ok()?;
    let loc = locate(&dir, path, max_dim).ok()?;
    loc.out.exists().then(|| {
        touch(&loc.out);
        loc.out
    })
}

/// Never makes a thumbnail and never waits for a slot. The interface can ask for all visible rows at once.
#[tauri::command]
pub async fn thumbnail_cached(path: String, max_dim: u32) -> Option<String> {
    if crate::watcher::is_ejecting(&path) {
        return None;
    }
    tauri::async_runtime::spawn_blocking(move || {
        cached(&path, max_dim).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08, 0x08, 0x06, 0x00, 0x00, 0x00, 0xc4,
        0x0f, 0xbe, 0x8b, 0x00, 0x00, 0x00, 0x12, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x38,
        0x61, 0x63, 0xf3, 0x1f, 0x1f, 0x66, 0x18, 0x19, 0x0a, 0x00, 0x0f, 0xbe, 0x8f, 0xc1, 0x56,
        0x80, 0x1f, 0xf8, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("doftar-thumbs-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn cached_lookup_finds_only_thumbnails_that_were_made() {
        let dir = scratch("cached");
        let cache = dir.join("cache");
        let src = dir.join("pic.png");
        fs::write(&src, PNG).unwrap();
        let path = src.to_str().unwrap();

        let loc = locate(&cache, path, 16).unwrap();
        assert!(!loc.out.exists(), "nothing made yet, so a lookup must miss");
        let made = make_thumbnail(&cache, path, 16).unwrap();
        assert_eq!(loc.out.to_string_lossy(), made);
        assert!(locate(&cache, path, 16).unwrap().out.exists());

        fs::write(&src, [PNG, &[0u8][..]].concat()).unwrap();
        assert!(!locate(&cache, path, 16).unwrap().out.exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_cancelled_request_makes_nothing() {
        let dir = scratch("cancel");
        let cache = dir.join("cache");
        let src = dir.join("pic.png");
        fs::write(&src, PNG).unwrap();
        cancel_thumbnail(987_654_321);
        let res = make_thumbnail_for(&cache, src.to_str().unwrap(), 16, Some(987_654_321));
        assert_eq!(res.unwrap_err(), "cancelled");
        assert!(!locate(&cache, src.to_str().unwrap(), 16).unwrap().out.exists());
        assert!(make_thumbnail_for(&cache, src.to_str().unwrap(), 16, Some(1)).is_ok());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn using_a_cached_thumbnail_keeps_it_from_looking_old() {
        let dir = scratch("touch");
        let file = dir.join("t.png");
        fs::write(&file, PNG).unwrap();
        let old = SystemTime::now() - Duration::from_secs(5 * 24 * 60 * 60);
        fs::OpenOptions::new().append(true).open(&file).unwrap().set_modified(old).unwrap();
        touch(&file);
        let age = SystemTime::now().duration_since(fs::metadata(&file).unwrap().modified().unwrap()).unwrap();
        assert!(age < Duration::from_secs(60), "a stale file is refreshed on use");

        let fresh = dir.join("f.png");
        fs::write(&fresh, PNG).unwrap();
        let before = fs::metadata(&fresh).unwrap().modified().unwrap();
        touch(&fresh);
        assert_eq!(fs::metadata(&fresh).unwrap().modified().unwrap(), before, "a recent file isn't rewritten");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn creates_and_reuses_a_cached_png_thumbnail() {
        let dir = scratch("ok");
        let src = dir.join("pic.png");
        fs::write(&src, PNG).unwrap();
        let cache = dir.join("cache");

        let out = make_thumbnail(&cache, src.to_str().unwrap(), 16).unwrap();
        let bytes = fs::read(&out).unwrap();
        assert!(bytes.starts_with(&[0x89, b'P', b'N', b'G']));

        let again = make_thumbnail(&cache, src.to_str().unwrap(), 16).unwrap();
        assert_eq!(out, again);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_small_image_is_not_scaled_up() {
        let dir = scratch("small");
        let src = dir.join("pic.png");
        fs::write(&src, PNG).unwrap();
        assert_eq!(pixel_max(&src), Some(8));
        let out = make_thumbnail(&dir.join("cache"), src.to_str().unwrap(), 160).unwrap();
        assert_eq!(pixel_max(&crate::paths::real(&out)), Some(8));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_passing_failures_are_marked_transient() {
        let gone = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert!(!io_failure(gone).starts_with(TRANSIENT));
        let busy = std::io::Error::from_raw_os_error(libc::EBUSY);
        assert!(io_failure(busy).starts_with(TRANSIENT));
        let dir = scratch("transient");
        let corrupt = dir.join("broken.png");
        fs::write(&corrupt, b"not an image").unwrap();
        let err = make_thumbnail(&dir.join("cache"), corrupt.to_str().unwrap(), 64).unwrap_err();
        assert!(!err.starts_with(TRANSIENT), "{err}");
        let mut slow = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        assert_eq!(wait_within(&mut slow, Duration::from_millis(100)), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn jpeg_output_for_non_alpha_formats() {
        let dir = scratch("jpg");
        let png = dir.join("pic.png");
        fs::write(&png, PNG).unwrap();
        let src = dir.join("photo.jpg");
        fs::copy(&png, &src).unwrap();
        let out = make_thumbnail(&dir.join("cache"), src.to_str().unwrap(), 32).unwrap();
        assert!(out.ends_with(".jpg"));
        assert!(fs::read(&out).unwrap().starts_with(&[0xff, 0xd8]));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn app_bundle_uses_its_icns() {
        let dir = scratch("app");
        let app = dir.join("Demo.app");
        let res = app.join("Contents").join("Resources");
        fs::create_dir_all(&res).unwrap();
        fs::write(
            app.join("Contents").join("Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIconFile</key><string>Demo</string></dict></plist>"#,
        )
        .unwrap();
        fs::write(res.join("Demo.icns"), PNG).unwrap();
        let out = make_thumbnail(&dir.join("cache"), app.to_str().unwrap(), 16).unwrap();
        assert!(out.ends_with(".png"));
        let empty = dir.join("Empty.app");
        fs::create_dir_all(&empty).unwrap();
        assert!(make_thumbnail(&dir.join("cache"), empty.to_str().unwrap(), 16).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn limits_the_size_asked_for() {
        let dir = scratch("limits");
        let cache = dir.join("cache");
        for name in ["pic.png", "doc.pdf"] {
            let src = dir.join(name);
            fs::write(&src, b"x").unwrap();
            let path = src.to_str().unwrap();
            assert_eq!(locate(&cache, path, 3200).unwrap().dim, 3200);
            assert_eq!(locate(&cache, path, u32::MAX).unwrap().dim, MAX_DIM);
            assert_eq!(locate(&cache, path, 1).unwrap().dim, 16);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_bad_input() {
        let dir = scratch("bad");
        let cache = dir.join("cache");
        assert!(make_thumbnail(&cache, "relative/pic.png", 64).is_err());
        assert!(make_thumbnail(&cache, "-rf.png", 64).is_err());
        let txt = dir.join("notes.txt");
        fs::write(&txt, "hi").unwrap();
        assert!(make_thumbnail(&cache, txt.to_str().unwrap(), 64).is_err());
        let corrupt = dir.join("broken.png");
        fs::write(&corrupt, b"not an image").unwrap();
        assert!(make_thumbnail(&cache, corrupt.to_str().unwrap(), 64).is_err());
        assert!(make_thumbnail(&cache, dir.to_str().unwrap(), 64).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn slow_children_are_killed() {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let start = std::time::Instant::now();
        assert!(!wait_or_kill(&mut child, Duration::from_millis(200)));
        assert!(start.elapsed() < Duration::from_secs(5));
        let mut ok = Command::new("/usr/bin/true").spawn().unwrap();
        assert!(wait_or_kill(&mut ok, Duration::from_secs(5)));
    }

    const PDF: &[u8] = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

    #[test]
    fn quick_look_renders_a_pdf_through_the_thumbnail_service() {
        let dir = scratch("qlpdf");
        let cache = dir.join("cache");
        let src = dir.join("page.pdf");
        fs::write(&src, PDF).unwrap();
        match make_thumbnail(&cache, src.to_str().unwrap(), 64) {
            Ok(out) => {
                assert!(out.ends_with(".png"));
                assert!(fs::read(&out).unwrap().starts_with(&[0x89, b'P', b'N', b'G']));
                assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
                assert_eq!(make_thumbnail(&cache, src.to_str().unwrap(), 64).unwrap(), out);
            }
            // Headless CI has no thumbnail service. Skip, do not fail.
            Err(e) => eprintln!("Quick Look thumbnail unavailable here, skipping: {e}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn quick_look_is_only_used_for_allowlisted_types() {
        let dir = scratch("ql");
        let cache = dir.join("cache");
        assert!(make_thumbnail(&cache, dir.join("missing.pdf").to_str().unwrap(), 64).is_err());
        let odd = dir.join("data.unknownext");
        fs::write(&odd, "x").unwrap();
        assert!(make_thumbnail(&cache, odd.to_str().unwrap(), 64).is_err());
        assert!(!cache.exists() || fs::read_dir(&cache).unwrap().count() == 0);
        let _ = fs::remove_dir_all(&dir);
    }
}

/// The Linux renderers, where the macOS tests do not apply.
#[cfg(all(test, not(target_os = "macos")))]
mod linux_tests {
    use super::*;

    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08, 0x08, 0x06, 0x00, 0x00, 0x00, 0xc4,
        0x0f, 0xbe, 0x8b, 0x00, 0x00, 0x00, 0x12, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x38,
        0x61, 0x63, 0xf3, 0x1f, 0x1f, 0x66, 0x18, 0x19, 0x0a, 0x00, 0x0f, 0xbe, 0x8f, 0xc1, 0x56,
        0x80, 0x1f, 0xf8, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("doftar-linthumbs-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn fits_inside_without_upscaling() {
        assert_eq!(scaled_dims(8, 8, 16), (8, 8), "small stays at its own size");
        assert_eq!(scaled_dims(3200, 1600, 320), (320, 160));
        assert_eq!(scaled_dims(1600, 3200, 320), (160, 320));
        assert_eq!(scaled_dims(1000, 1, 100), (100, 1));
        assert_eq!(scaled_dims(0, 0, 16), (0, 0));
    }

    #[test]
    fn limits_the_size_asked_for() {
        let dir = scratch("limits");
        let cache = dir.join("cache");
        let src = dir.join("pic.png");
        fs::write(&src, PNG).unwrap();
        let path = src.to_str().unwrap();
        assert_eq!(locate(&cache, path, 3200).unwrap().dim, 3200);
        assert_eq!(locate(&cache, path, u32::MAX).unwrap().dim, MAX_DIM);
        assert_eq!(locate(&cache, path, 1).unwrap().dim, 16);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn makes_and_reuses_a_png_thumbnail() {
        let dir = scratch("png");
        let src = dir.join("pic.png");
        fs::write(&src, PNG).unwrap();
        let cache = dir.join("cache");
        let out = make_thumbnail(&cache, src.to_str().unwrap(), 16).unwrap();
        assert!(fs::read(&out).unwrap().starts_with(&[0x89, b'P', b'N', b'G']));
        assert_eq!(make_thumbnail(&cache, src.to_str().unwrap(), 16).unwrap(), out);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_small_image_is_not_scaled_up() {
        let dir = scratch("small");
        let src = dir.join("pic.png");
        fs::write(&src, PNG).unwrap();
        assert_eq!(pixel_max(&src), Some(8));
        let out = make_thumbnail(&dir.join("cache"), src.to_str().unwrap(), 160).unwrap();
        assert_eq!(pixel_max(&crate::paths::real(&out)), Some(8));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn jpeg_output_for_non_alpha_formats() {
        let dir = scratch("jpg");
        let png = dir.join("pic.png");
        fs::write(&png, PNG).unwrap();
        let src = dir.join("photo.jpg");
        fs::copy(&png, &src).unwrap();
        let out = make_thumbnail(&dir.join("cache"), src.to_str().unwrap(), 32).unwrap();
        assert!(out.ends_with(".jpg"));
        assert!(fs::read(&out).unwrap().starts_with(&[0xff, 0xd8]));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn heic_audio_and_documents_are_permanent_not_transient() {
        let dir = scratch("permanent");
        let cache = dir.join("cache");
        let heic = dir.join("pic.heic");
        fs::write(&heic, PNG).unwrap();
        let err = make_thumbnail(&cache, heic.to_str().unwrap(), 64).unwrap_err();
        assert!(!err.starts_with(TRANSIENT), "{err}");
        let mp3 = dir.join("t.mp3");
        fs::write(&mp3, b"x").unwrap();
        let err = make_thumbnail(&cache, mp3.to_str().unwrap(), 64).unwrap_err();
        assert!(!err.starts_with(TRANSIENT), "{err}");
        let docx = dir.join("t.docx");
        fs::write(&docx, b"x").unwrap();
        let err = make_thumbnail(&cache, docx.to_str().unwrap(), 64).unwrap_err();
        assert!(!err.starts_with(TRANSIENT), "{err}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_corrupt_image_is_a_permanent_error() {
        let dir = scratch("corrupt");
        let broken = dir.join("broken.png");
        fs::write(&broken, b"not an image").unwrap();
        let err = make_thumbnail(&dir.join("cache"), broken.to_str().unwrap(), 64).unwrap_err();
        assert!(!err.starts_with(TRANSIENT), "{err}");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// A JPEG of `img` with an EXIF orientation tag, spliced in as an APP1 segment after the SOI.
    fn jpeg_with_orientation(img: &image::DynamicImage, orientation: u16) -> Vec<u8> {
        let mut jpeg = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
            .unwrap();
        // Big-endian TIFF: header, one IFD0 entry (tag 0x112, SHORT, count 1), no next IFD.
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"MM\x00*");
        tiff.extend_from_slice(&[0u8, 0, 0, 8]); // the IFD starts right after the header
        tiff.extend_from_slice(&[0u8, 1]); // one entry
        tiff.extend_from_slice(&[0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01]);
        tiff.extend_from_slice(&orientation.to_be_bytes());
        tiff.extend_from_slice(&[0u8, 0]); // the rest of the SHORT value slot
        tiff.extend_from_slice(&[0u8, 0, 0, 0]); // no next IFD
        let mut out = jpeg[..2].to_vec(); // the SOI
        out.extend_from_slice(&[0xff, 0xe1]);
        out.extend_from_slice(&(tiff.len() as u16 + 8).to_be_bytes()); // "Exif\0\0", lengths
        out.extend_from_slice(b"Exif\x00\x00");
        out.extend_from_slice(&tiff);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    #[test]
    fn an_exif_oriented_jpeg_decodes_upright() {
        let dir = scratch("exif");
        let cache = dir.join("cache");
        // Stored 8 x 4, red on top, blue below. Orientation 6 turns the camera sideways.
        let mut px = image::RgbaImage::new(8, 4);
        for y in 0..4 {
            for x in 0..8 {
                px.put_pixel(
                    x,
                    y,
                    if y < 2 { image::Rgba([255, 0, 0, 255]) } else { image::Rgba([0, 0, 255, 255]) },
                );
            }
        }
        let src = dir.join("photo.jpg");
        fs::write(&src, jpeg_with_orientation(&image::DynamicImage::ImageRgba8(px), 6)).unwrap();

        let shown = decode_scaled(&src, 32).unwrap();
        assert_eq!((shown.width(), shown.height()), (4, 8), "orientation 6 swaps the sides");
        use image::GenericImageView;
        // The clockwise turn puts the stored bottom row on the left and the top row on the right.
        let (left, right) = (shown.get_pixel(0, 0), shown.get_pixel(3, 7));
        assert!(left.0[0] < left.0[2], "the left side is the stored bottom: {left:?}");
        assert!(right.0[0] > right.0[2], "the right side is the stored top: {right:?}");

        // The thumbnail on disk is upright too.
        let out = make_thumbnail(&cache, src.to_str().unwrap(), 32).unwrap();
        let thumb = image::ImageReader::open(crate::paths::real(&out))
            .unwrap()
            .with_guessed_format()
            .unwrap()
            .decode()
            .unwrap();
        assert_eq!((thumb.width(), thumb.height()), (4, 8));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_name_that_is_not_utf8_still_gets_a_thumbnail() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let dir = scratch("nonutf8");
        let cache = dir.join("cache");
        let src = dir.join(OsStr::from_bytes(b"pic\xff.png"));
        fs::write(&src, PNG).unwrap();
        let out = make_thumbnail(&cache, &crate::paths::encode(&src), 16).unwrap();
        assert!(fs::read(crate::paths::real(&out)).unwrap().starts_with(&[0x89, b'P', b'N', b'G']));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn crash_leftover_scratch_names_are_pruned() {
        let dir = scratch("prune");
        let old = SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        let stale = |name: &str| {
            let f = dir.join(name);
            fs::write(&f, b"x").unwrap();
            fs::OpenOptions::new().append(true).open(&f).unwrap().set_modified(old).unwrap();
        };
        stale("key.402.1.tmp"); // a scratch file that never got renamed
        stale("key.402.1.tmp.png"); // ffmpeg output left before its rename
        stale("key.402.1.tmp-pp.png"); // pdftoppm output left before its rename
        stale("key.png"); // a real thumbnail, still inside CACHE_MAX_AGE
        let fresh = dir.join("new.png");
        fs::write(&fresh, PNG).unwrap();
        prune(&dir);
        let mut left: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["key.png", "new.png"], "scratch leftovers go, thumbnails stay");
        fs::remove_dir_all(&dir).unwrap();
    }
}
