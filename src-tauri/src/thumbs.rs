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
    "mov", "mp4", "m4v", "avi", "mkv", "webm", "mp3", "m4a", "svg", "psd", "ai", "eps", "epub",
];
const QL_MAX_CONCURRENT: usize = 2;
const PDF_MAX_CONCURRENT: usize = 2;
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
/// PDFKit draws in this process, so a slow page can't be timed out. It must not hold up icons.
static PDF_GATE: Gate = Gate {
    running: Mutex::new(0),
    cv: Condvar::new(),
    limit: PDF_MAX_CONCURRENT,
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
        [Some(PathBuf::from("/")), dirs::home_dir()]
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
    let meta = fs::metadata(path).map_err(io_failure)?;
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
        if e.file_name().to_string_lossy().ends_with(".tmp") && age > SCRATCH_MAX_AGE {
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

#[cfg(not(target_os = "macos"))]
fn pixel_max(_src: &Path) -> Option<u32> {
    None
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
    dim: u32,
    quick_look: bool,
    png: bool,
}

/// The largest thumbnail, for a picture zoomed in the preview bar.
const MAX_DIM: u32 = 3200;

fn locate(cache: &Path, path: &str, max_dim: u32) -> Result<Located, String> {
    let src = Path::new(path);
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
    if !is_app && QL_EXTS.contains(&ext_of(src).as_str()) {
        let dim = max_dim.clamp(16, MAX_DIM);
        let meta = fs::metadata(src).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("not a file".into());
        }
        if is_dataless(&meta) {
            return Err(transient("file is not downloaded"));
        }
        let key = format!("ql-{}", cache_key(src, &meta, dim));
        return Ok(Located {
            src: src.to_path_buf(),
            out: cache.join(format!("{key}.png")),
            dim,
            quick_look: true,
            png: true,
        });
    }
    let (src, ext) = if is_app {
        let icns = app_icon(src).ok_or_else(|| "no app icon".to_string())?;
        (icns, "png".to_string())
    } else {
        let ext = ext_of(src);
        if !EXTS.contains(&ext.as_str()) {
            return Err("unsupported image type".into());
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
    Ok(Located { src, out, dim, quick_look: false, png })
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

#[cfg(not(target_os = "macos"))]
fn make_ql_thumbnail(_loc: &Located, _cache: &Path, _req: Option<u64>) -> Result<String, String> {
    Err("Quick Look thumbnails need macOS".into())
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
        .map_err(transient)?;
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

/// A PDF page as the preview bar lays it out, in points.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct PageSize {
    w: f64,
    h: f64,
}

/// Only a PDF that is on disk. A cloud file must not start a download here.
fn pdf_source(path: &str) -> Result<(&Path, fs::Metadata), String> {
    let src = Path::new(path);
    let is_pdf = src.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
    if !src.is_absolute() || !is_pdf {
        return Err("not a PDF".into());
    }
    let meta = fs::metadata(src).map_err(io_failure)?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if is_dataless(&meta) {
        return Err(transient("file is not downloaded"));
    }
    Ok((src, meta))
}

#[cfg(target_os = "macos")]
mod pdf_pages {
    use super::*;
    use objc2::rc::Retained;
    use objc2::AllocAnyThread;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGContext, CGImageAlphaInfo,
    };
    use objc2_foundation::NSURL;
    use objc2_pdf_kit::{PDFDisplayBox, PDFDocument, PDFPage};

    /// A file with a password is an error, so the preview shows its Quick Look picture.
    fn open(src: &Path) -> Result<Retained<PDFDocument>, String> {
        let url = NSURL::from_file_path(src).ok_or("invalid path")?;
        // SAFETY: the document is made, used and dropped on this thread. No view shares it.
        let doc = unsafe { PDFDocument::initWithURL(PDFDocument::alloc(), &url) }
            .ok_or("Doftar can't read this PDF")?;
        if unsafe { doc.isLocked() } {
            return Err("the PDF is protected with a password".into());
        }
        Ok(doc)
    }

    /// As shown: a page turned a quarter swaps its sides.
    fn shown_size(page: &PDFPage) -> Option<(f64, f64)> {
        // SAFETY: plain getters on a live page.
        let b = unsafe { page.boundsForBox(PDFDisplayBox::CropBox) };
        let (w, h) = (b.size.width, b.size.height);
        if w <= 0.0 || h <= 0.0 {
            return None;
        }
        Some(if unsafe { page.rotation() } % 180 != 0 { (h, w) } else { (w, h) })
    }

    pub fn sizes(src: &Path) -> Result<Vec<PageSize>, String> {
        objc2::rc::autoreleasepool(|_| {
            let doc = open(src)?;
            // SAFETY: each index is below the page count.
            (0..unsafe { doc.pageCount() })
                .map(|i| {
                    unsafe { doc.pageAtIndex(i) }
                        .and_then(|page| shown_size(&page))
                        .map(|(w, h)| PageSize { w, h })
                        .ok_or_else(|| "Doftar can't read this PDF".to_string())
                })
                .collect()
        })
    }

    pub fn render(src: &Path, index: usize, dim: u32, tmp: &Path) -> Result<(), String> {
        objc2::rc::autoreleasepool(|_| {
            let doc = open(src)?;
            // PDFKit raises an exception for an index past the end.
            if index >= unsafe { doc.pageCount() } {
                return Err("no such page".to_string());
            }
            let page = unsafe { doc.pageAtIndex(index) }.ok_or("no such page")?;
            let (w, h) = shown_size(&page).ok_or("the page is empty")?;
            let k = f64::from(dim) / w.max(h);
            let (pw, ph) = ((w * k).round().max(1.0), (h * k).round().max(1.0));
            let space = CGColorSpace::new_device_rgb().ok_or("couldn't draw the page")?;
            // SAFETY: Core Graphics owns the pixels, because the buffer is null.
            let ctx = unsafe {
                CGBitmapContextCreate(
                    std::ptr::null_mut(),
                    pw as usize,
                    ph as usize,
                    8,
                    0,
                    Some(&space),
                    CGImageAlphaInfo::NoneSkipLast.0,
                )
            }
            .ok_or("couldn't draw the page")?;
            // A page has no background of its own.
            CGContext::set_rgb_fill_color(Some(&ctx), 1.0, 1.0, 1.0, 1.0);
            CGContext::fill_rect(Some(&ctx), CGRect::new(CGPoint::ZERO, CGSize::new(pw, ph)));
            CGContext::scale_ctm(Some(&ctx), pw / w, ph / h);
            unsafe { page.drawWithBox_toContext(PDFDisplayBox::CropBox, &ctx) };
            let image = CGBitmapContextCreateImage(Some(&ctx)).ok_or("couldn't draw the page")?;
            write_png(&image, tmp)
        })
    }
}

#[cfg(target_os = "macos")]
fn make_pdf_page(
    cache: &Path,
    path: &str,
    index: usize,
    max_dim: u32,
    req: Option<u64>,
) -> Result<String, String> {
    let (src, meta) = pdf_source(path)?;
    let dim = max_dim.clamp(16, MAX_DIM);
    let key = format!("pdf-{index}-{}", cache_key(src, &meta, dim));
    let out = cache.join(format!("{key}.png"));
    if out.exists() {
        touch(&out);
        return Ok(out.to_string_lossy().into_owned());
    }
    fs::create_dir_all(cache).map_err(transient)?;
    let _permit = PDF_GATE.acquire();
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    if is_cancelled(req) {
        return Err("cancelled".into());
    }
    let tmp = tmp_path(cache, &key);
    let made = pdf_pages::render(src, index, dim, &tmp)
        .and_then(|()| fs::rename(&tmp, &out).map_err(|e| e.to_string()));
    if made.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    made?;
    Ok(out.to_string_lossy().into_owned())
}

#[cfg(not(target_os = "macos"))]
fn make_pdf_page(_: &Path, _: &str, _: usize, _: u32, _: Option<u64>) -> Result<String, String> {
    Err("PDF pages need macOS".into())
}

/// Every page's size, so the preview bar can lay out a page before it is drawn.
#[tauri::command]
pub async fn pdf_page_sizes(path: String) -> Result<Vec<PageSize>, String> {
    if crate::watcher::is_ejecting(&path) {
        return Err("volume is being ejected".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (src, _) = pdf_source(&path)?;
        #[cfg(target_os = "macos")]
        return pdf_pages::sizes(src);
        #[cfg(not(target_os = "macos"))]
        {
            let _ = src;
            Err("PDF pages need macOS".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A page as a PNG. `index` starts at 0. `cancel_thumbnail` stops `request_id`.
/// Pages have their own folder, and so their own size limit, so a long PDF doesn't push out icons.
#[tauri::command]
pub async fn pdf_page_picture(
    path: String,
    index: usize,
    max_dim: u32,
    request_id: Option<u64>,
) -> Result<String, String> {
    if crate::watcher::is_ejecting(&path) {
        return Err("volume is being ejected".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(io_failure)?;
        let dir = preview_dir("pdf-pages", &meta).ok_or("no cache directory")?;
        make_pdf_page(&dir, &path, index, max_dim, request_id)
    })
    .await
    .map_err(|e| e.to_string())?
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
        assert_eq!(pixel_max(Path::new(&out)), Some(8));
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

    /// Two 200 x 100 pages, with a red square at the lower left. The second is turned a quarter.
    fn two_page_pdf(path: &Path) {
        let square = "1 0 0 rg 0 0 50 50 re f";
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 5 0 R >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Rotate 90 /Contents 5 0 R >>".to_string(),
            format!("<< /Length {} >>\nstream\n{square}\nendstream", square.len()),
        ];
        let mut pdf = String::from("%PDF-1.4\n");
        let mut offsets = vec![];
        for (i, o) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf += &format!("{} 0 obj\n{o}\nendobj\n", i + 1);
        }
        let xref = pdf.len();
        pdf += &format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1);
        for o in offsets {
            pdf += &format!("{o:010} 00000 n \n");
        }
        pdf += &format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1);
        fs::write(path, pdf).unwrap();
    }

    /// The width and height of a PNG, and whether each corner is red: top-left, top-right, bottom-left, bottom-right.
    fn red_corners(png: &str) -> (usize, usize, [bool; 4]) {
        use objc2_core_foundation::{CFString, CFURLPathStyle, CGPoint, CGRect, CGSize, CFURL};
        use objc2_core_graphics::{
            CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
        };
        use objc2_image_io::CGImageSource;
        let s = CFString::from_str(png);
        let url = CFURL::with_file_system_path(None, Some(&s), CFURLPathStyle::CFURLPOSIXPathStyle, false).unwrap();
        let image = unsafe { CGImageSource::with_url(&url, None).unwrap().image_at_index(0, None) }.unwrap();
        let (w, h) = (CGImage::width(Some(&image)), CGImage::height(Some(&image)));
        let mut px = vec![0u8; w * h * 4];
        let space = CGColorSpace::new_device_rgb().unwrap();
        let ctx = unsafe {
            CGBitmapContextCreate(px.as_mut_ptr().cast(), w, h, 8, w * 4, Some(&space), CGImageAlphaInfo::NoneSkipLast.0)
        }
        .unwrap();
        let rect = CGRect::new(CGPoint::ZERO, CGSize::new(w as f64, h as f64));
        CGContext::draw_image(Some(&ctx), rect, Some(&image));
        let red = |x: usize, y: usize| px[(y * w + x) * 4 + 1] < 128;
        (w, h, [red(2, 2), red(w - 3, 2), red(2, h - 3), red(w - 3, h - 3)])
    }

    #[test]
    fn draws_each_pdf_page_the_way_up_it_is_shown() {
        let dir = scratch("pdf-pages");
        let cache = dir.join("cache");
        let src = dir.join("two.pdf");
        two_page_pdf(&src);
        let path = src.to_str().unwrap();

        assert_eq!(
            pdf_pages::sizes(&src).unwrap(),
            [PageSize { w: 200.0, h: 100.0 }, PageSize { w: 100.0, h: 200.0 }]
        );
        let first = make_pdf_page(&cache, path, 0, 400, None).unwrap();
        assert_eq!(red_corners(&first), (400, 200, [false, false, true, false]));
        // A quarter turn clockwise takes the lower left to the upper left.
        let turned = make_pdf_page(&cache, path, 1, 400, None).unwrap();
        assert_eq!(red_corners(&turned), (200, 400, [true, false, false, false]));
        assert_eq!(make_pdf_page(&cache, path, 0, 400, None).unwrap(), first);
        assert_ne!(first, turned);

        assert!(make_pdf_page(&cache, path, 2, 400, None).is_err());
        assert!(make_pdf_page(&cache, dir.join("missing.pdf").to_str().unwrap(), 0, 400, None).is_err());
        let not_pdf = dir.join("notes.txt");
        fs::write(&not_pdf, "hi").unwrap();
        assert!(make_pdf_page(&cache, not_pdf.to_str().unwrap(), 0, 400, None).is_err());
        let broken = dir.join("broken.pdf");
        fs::write(&broken, "not a pdf").unwrap();
        assert!(pdf_pages::sizes(&broken).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pdf_with_a_password_is_refused() {
        use objc2::runtime::AnyObject;
        use objc2::AllocAnyThread;
        use objc2_foundation::{NSDictionary, NSString, NSURL};
        use objc2_pdf_kit::{
            PDFDocument, PDFDocumentOwnerPasswordOption, PDFDocumentUserPasswordOption,
        };
        let dir = scratch("pdf-locked");
        let plain = dir.join("plain.pdf");
        two_page_pdf(&plain);
        let locked = dir.join("locked.pdf");
        let url = NSURL::from_file_path(&plain).unwrap();
        let doc = unsafe { PDFDocument::initWithURL(PDFDocument::alloc(), &url) }.unwrap();
        let secret = NSString::from_str("secret");
        let value: &AnyObject = &secret;
        let options = NSDictionary::from_slices(
            unsafe { &[PDFDocumentOwnerPasswordOption, PDFDocumentUserPasswordOption] },
            &[value, value],
        );
        let to = NSString::from_str(locked.to_str().unwrap());
        assert!(unsafe { doc.writeToFile_withOptions(&to, Some(&options)) });

        assert!(pdf_pages::sizes(&plain).is_ok());
        assert!(pdf_pages::sizes(&locked).unwrap_err().contains("password"));
        let made = make_pdf_page(&dir.join("cache"), locked.to_str().unwrap(), 0, 64, None);
        assert!(made.unwrap_err().contains("password"));
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
