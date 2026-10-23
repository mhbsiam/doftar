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
/// Unused for this long, a cached thumbnail goes. Cache hits refresh the file's
/// time, so what you keep looking at stays.
const CACHE_MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);

const EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "heic", "heif", "webp",
];

const QL_EXTS: &[&str] = &[
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key", "rtf", "rtfd",
    "mov", "mp4", "m4v", "avi", "mkv", "webm", "mp3", "m4a", "svg", "psd", "ai", "eps", "epub",
];
const QL_MAX_CONCURRENT: usize = 2;
const QL_TIMEOUT: Duration = Duration::from_secs(6);
#[cfg(target_os = "macos")]
const SF_DATALESS: u32 = 0x4000_0000;
/// Starts the error of a failure that may not happen next time (a file still
/// in iCloud, a renderer that ran out of time, a disk busy or full just now),
/// so the interface tries again later instead of remembering it for good.
pub(crate) const TRANSIENT: &str = "transient: ";

fn transient(msg: impl std::fmt::Display) -> String {
    format!("{TRANSIENT}{msg}")
}

/// An I/O error's message, marked transient unless the file is missing or off
/// limits, which trying again won't change.
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

/// Numbers each scratch file, so two renders of one thumbnail at once (two
/// windows showing the same folder) never write to the same one.
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
        let mut n = self.running.lock().unwrap();
        while *n >= self.limit {
            n = self.cv.wait(n).unwrap();
        }
        *n += 1;
        Permit(self)
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        *self.0.running.lock().unwrap() -= 1;
        self.0.cv.notify_one();
    }
}

/// Everything Doftar caches on disk lives under this folder.
pub(crate) fn cache_root() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join("com.doftar.app"))
}

/// Previews of files on any other volume (USB and external drives, network
/// shares, disk images) are kept apart, under `session/<device>/`, and deleted
/// once that volume goes away or Doftar quits (see cache.rs), so a private
/// drive leaves no copies of its contents on this Mac.
pub(crate) fn session_root() -> Option<PathBuf> {
    cache_root().map(|d| d.join("session"))
}

/// The startup disk's devices: its system volume and the data volume that
/// holds the home folder.
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

/// The cache folder `kind` ("thumbs" or "viewer") for previews of a file with
/// metadata `meta`: the lasting one on the startup disk, else its volume's
/// session folder.
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
            // `{key}.{pid}.d` scratch dirs older builds left behind when they crashed mid-render.
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

/// Whether `child` succeeded, or `None` when it was killed for running past
/// `limit` (or couldn't be waited on).
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

/// The largest width or height among the images in `src`, read from its
/// header without decoding it.
#[cfg(target_os = "macos")]
fn pixel_max(src: &Path) -> Option<u32> {
    use objc2_core_foundation::{
        CFDictionary, CFNumber, CFRetained, CFString, CFType, CFURLPathStyle, CFURL,
    };
    use objc2_image_io::{kCGImagePropertyPixelHeight, kCGImagePropertyPixelWidth, CGImageSource};

    let s = CFString::from_str(&src.to_string_lossy());
    let url = CFURL::with_file_system_path(None, Some(&s), CFURLPathStyle::CFURLPOSIXPathStyle, false)?;
    // SAFETY: ImageIO calls with a valid URL; property dictionaries have CFString keys.
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

/// Where a thumbnail for `path` lives in the cache and how to make it.
struct Located {
    src: PathBuf,
    out: PathBuf,
    dim: u32,
    quick_look: bool,
    png: bool,
}

/// Validates `path` and works out its cache file, without making anything.
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
        let dim = max_dim.clamp(16, 512);
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
    let dim = max_dim.clamp(16, 512);
    let png = matches!(ext.as_str(), "png" | "gif" | "webp" | "tif" | "tiff");
    let key = cache_key(&src, &meta, dim);
    let out = cache.join(format!("{key}.{}", if png { "png" } else { "jpg" }));
    Ok(Located { src, out, dim, quick_look: false, png })
}

/// Marks a cache file as used, so pruning drops what nobody looks at first.
/// Only rewritten when it is more than a day stale, to avoid a write per hit.
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

/// Thumbnail requests the interface no longer wants (scrolled out of view).
static CANCELLED: Mutex<Vec<u64>> = Mutex::new(Vec::new());

fn is_cancelled(req: Option<u64>) -> bool {
    req.is_some_and(|id| CANCELLED.lock().unwrap().contains(&id))
}

#[tauri::command(async)]
pub fn cancel_thumbnail(request_id: u64) {
    let mut list = CANCELLED.lock().unwrap();
    if list.len() > 512 {
        list.drain(..256); // ids only grow; the oldest are long finished
    }
    list.push(request_id);
}

/// A CGImage handed over from the Quick Look completion queue. CGImage is
/// immutable and safe to use from any thread; objc2 just doesn't say so.
#[cfg(target_os = "macos")]
struct SentImage(objc2_core_foundation::CFRetained<objc2_core_graphics::CGImage>);
#[cfg(target_os = "macos")]
unsafe impl Send for SentImage {}

/// Asks the QuickLookThumbnailing service for a `dim`-sized thumbnail of
/// `src`. Generators run in Apple's own sandboxed thumbnail service over XPC,
/// so this works where spawning `qlmanage` doesn't, and never blocks past
/// `QL_TIMEOUT`.
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
    // SAFETY: plain constructor calls; the request is kept alive below for
    // as long as the generator may still refer to it (cancelRequest:).
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
        // SAFETY: Quick Look passes either a live representation or a live
        // error, valid for the duration of this call; we retain what we keep.
        let outcome = match unsafe { rep.as_ref() } {
            Some(rep) => Ok(SentImage(unsafe { rep.CGImage() }.into())),
            None => Err(unsafe { err.as_ref() }
                .map(|e| e.localizedDescription().to_string())
                .unwrap_or_else(|| "Quick Look couldn't render a thumbnail".into())),
        };
        // The waiter may have given up already; then nothing wants this.
        let _ = tx.send(outcome);
    });
    // SAFETY: the shared generator is thread-safe; the block is retained by
    // the framework until it has been called.
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

/// Writes `image` to `out` as a PNG.
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
    // Writing into the cache failing says nothing about the file.
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
    // `-Z` scales up as readily as down; a small image stays its own size.
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
    // sips has no timeout of its own; a stalled network file or a cloud
    // download must not park one of the few thumbnail slots forever.
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

/// The cached thumbnail file for `path` at `max_dim`, if one exists; never
/// makes one.
pub fn cached(path: &str, max_dim: u32) -> Option<PathBuf> {
    let dir = cache_dir(path).ok()?;
    let loc = locate(&dir, path, max_dim).ok()?;
    loc.out.exists().then(|| {
        touch(&loc.out);
        loc.out
    })
}

/// The cached thumbnail for `path`, if one exists. Never makes one, never
/// waits for a slot, so the interface can ask for every visible row at once
/// and fill in whatever is already on disk (all of it, after a restart).
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

        // A changed file is a different cache entry.
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
        assert!(locate(&cache, src.to_str().unwrap(), 16).unwrap().out.exists() == false);
        // An uncancelled request still works.
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

    /// A one-page PDF, the smallest thing Quick Look will render.
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
                // The temp file is gone and nothing else was left behind.
                assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
                // The second ask is a cache hit.
                assert_eq!(make_thumbnail(&cache, src.to_str().unwrap(), 64).unwrap(), out);
            }
            // No thumbnail service in this environment (headless CI, say):
            // say so rather than fail.
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
