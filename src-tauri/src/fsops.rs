use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use crate::guard;
use crate::launcher::{applescript_quote, shell_quote};
use crate::jobs::{self, Job, JobGuard, OpResult, Progress, Step};
use crate::tags::Tag;
use tauri::ipc::Channel;

fn strerr<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn unix_ms(t: std::io::Result<std::time::SystemTime>) -> u64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_hidden: bool,
    pub is_symlink: bool,
    /// A Finder alias file (shown with the shortcut arrow, opens its original).
    pub is_alias: bool,
    pub is_package: bool,
    pub size: u64,
    pub modified_ms: u64,
    pub created_ms: u64,
    pub ext: String,
    /// Stable identity (device:inode) that survives renames and same-volume moves.
    pub file_id: String,
    /// Finder tags, oldest first. A folder listing reads them only for items
    /// with a Finder label (see `tags::read_labelled`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<Tag>,
}

fn file_id_of(meta: &fs::Metadata) -> String {
    format!("{}:{}", meta.dev(), meta.ino())
}

pub fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.') || name == "desktop.ini" || name.starts_with("._") || name == "Icon\r"
}

#[cfg(target_os = "macos")]
const UF_HIDDEN: u32 = 0x8000;

fn has_hidden_flag(meta: &fs::Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt as _;
        meta.st_flags() & UF_HIDDEN != 0
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = meta;
        false
    }
}

pub const PACKAGE_EXTS: &[&str] = &[
    "app", "bundle", "framework", "pages", "numbers", "key", "xcodeproj",
    "xcworkspace", "playground", "photoslibrary", "band", "sparsebundle",
    "plugin", "prefpane", "qlgenerator", "kext", "docset", "rtfd", "appex",
    "xpc", "saver", "mdimporter", "xcarchive",
];

pub(crate) fn is_package_dir(path: &Path, ext: &str) -> bool {
    if PACKAGE_EXTS.contains(&ext) {
        return true;
    }
    if ext.is_empty() {
        return false;
    }
    let info = path.join("Contents").join("Info.plist");
    if !info.is_file() {
        return false;
    }
    plist::Value::from_file(&info)
        .ok()
        .and_then(|v| {
            v.as_dictionary()
                .and_then(|d| d.get("LSTypeIsPackage"))
                .and_then(|b| b.as_boolean())
        })
        .unwrap_or(false)
}

/// Larger than any alias file Finder writes, so bigger files skip the check.
pub(crate) const ALIAS_MAX_BYTES: u64 = 4 * 1024 * 1024;

pub fn build_entry(
    p: &Path,
    name: String,
    lmeta: fs::Metadata,
    show_hidden: bool,
) -> Option<FileEntry> {
    let mut entry = build_entry_untagged(p, name, lmeta, show_hidden)?;
    entry.tags = crate::tags::read(p);
    Some(entry)
}

/// `build_entry` without the tags, for callers that know them more cheaply.
pub(crate) fn build_entry_untagged(
    p: &Path,
    name: String,
    lmeta: fs::Metadata,
    show_hidden: bool,
) -> Option<FileEntry> {
    let hidden = is_hidden_name(&name) || has_hidden_flag(&lmeta);
    if !show_hidden && hidden {
        return None;
    }
    let is_symlink = lmeta.file_type().is_symlink();
    let meta = if is_symlink {
        fs::metadata(p).unwrap_or_else(|_| lmeta.clone())
    } else {
        lmeta
    };
    let is_dir = meta.is_dir();
    let raw_ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let is_package = is_dir && is_package_dir(p, &raw_ext);
    let ext = if is_dir && !is_package {
        String::new()
    } else {
        raw_ext
    };
    Some(FileEntry {
        name,
        path: p.to_string_lossy().to_string(),
        is_dir,
        is_hidden: hidden,
        is_symlink,
        // Aliases are small files; skip the attribute read for anything big.
        is_alias: meta.is_file() && meta.len() <= ALIAS_MAX_BYTES && crate::alias::is_alias_file(p),
        is_package,
        size: if is_dir { 0 } else { meta.len() },
        modified_ms: unix_ms(meta.modified()),
        created_ms: unix_ms(meta.created()),
        ext,
        file_id: file_id_of(&meta),
        tags: Vec::new(),
    })
}

/// Rows sent in each streamed batch: a small first one so the top of a big
/// folder appears at once, then growing ones so the interface re-sorts and
/// re-renders only a handful of times.
const STREAM_BATCHES: [usize; 4] = [400, 2_000, 8_000, 32_000];

/// Streams the interface has abandoned (it navigated away mid-listing).
static CANCELLED_STREAMS: std::sync::Mutex<Vec<u64>> = std::sync::Mutex::new(Vec::new());

fn stream_cancelled(id: u64) -> bool {
    CANCELLED_STREAMS.lock().unwrap().contains(&id)
}

#[tauri::command(async)]
pub fn cancel_list_stream(stream_id: u64) {
    let mut list = CANCELLED_STREAMS.lock().unwrap();
    if list.len() > 256 {
        list.drain(..128); // ids only grow; the oldest are long finished
    }
    list.push(stream_id);
}

/// Lists a folder like `list_dir`, but delivers the (already sorted) entries
/// through `on_batch` in growing chunks. Returns the total entry count so the
/// caller knows when the last chunk has arrived. Stops sending as soon as the
/// stream is cancelled, so leaving a huge folder doesn't ship the rest of it.
#[tauri::command]
pub async fn list_dir_stream(
    path: String,
    show_hidden: bool,
    stream_id: u64,
    on_batch: Channel<Vec<FileEntry>>,
) -> Result<usize, String> {
    jobs::blocking(move || {
        if stream_cancelled(stream_id) {
            return Ok(0);
        }
        let entries = list_dir_sync(&path, show_hidden)?;
        let total = entries.len();
        let mut rest = entries.into_iter();
        let mut sizes = STREAM_BATCHES.iter().copied().chain(std::iter::repeat(usize::MAX));
        loop {
            if stream_cancelled(stream_id) {
                break;
            }
            let size = sizes.next().unwrap_or(usize::MAX);
            let chunk: Vec<FileEntry> = rest.by_ref().take(size).collect();
            if chunk.is_empty() {
                break;
            }
            if on_batch.send(chunk).is_err() {
                break; // the window is gone
            }
        }
        Ok(total)
    })
    .await?
}

/// Lists a folder for hover-prefetching: `None` when it holds more than
/// `max_entries`, so a huge folder is never shipped to the interface on a hover.
#[tauri::command]
pub async fn list_dir_capped(
    path: String,
    show_hidden: bool,
    max_entries: usize,
) -> Result<Option<Vec<FileEntry>>, String> {
    jobs::blocking(move || {
        // Counting names stops after max_entries + 1, so a huge folder is
        // turned away without being fully listed and sorted.
        if let Ok(rd) = fs::read_dir(&path) {
            if rd.take(max_entries.saturating_add(1)).count() > max_entries {
                return Ok(None);
            }
        }
        let entries = list_dir_sync(&path, show_hidden)?;
        Ok((entries.len() <= max_entries).then_some(entries))
    })
    .await?
}

#[tauri::command]
pub async fn list_dir(path: String, show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    jobs::blocking(move || list_dir_sync(&path, show_hidden)).await?
}

pub(crate) fn list_dir_sync(path: &str, show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    let dir = Path::new(path);
    // One syscall per batch of entries; `None` means use the per-entry path
    // below, which also produces the error message for unreadable folders.
    #[cfg(target_os = "macos")]
    let bulk = crate::bulk::list_dir(dir, show_hidden);
    #[cfg(not(target_os = "macos"))]
    let bulk: Option<Vec<FileEntry>> = None;
    let mut entries = match bulk {
        Some(entries) => entries,
        None => {
            let mut entries = Vec::new();
            let read = fs::read_dir(dir).map_err(|e| format!("{} ({})", e, path))?;
            for item in read.flatten() {
                let name = item.file_name().to_string_lossy().to_string();
                let Ok(lmeta) = item.metadata() else { continue };
                if let Some(entry) = build_entry(&item.path(), name, lmeta, show_hidden) {
                    entries.push(entry);
                }
            }
            entries
        }
    };
    // Folders first, then by name ignoring case. The lowercase key is built
    // once per entry, not twice per comparison.
    entries.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase()));
    Ok(entries)
}

#[tauri::command(async)]
pub fn stat_entries(paths: Vec<String>) -> Vec<FileEntry> {
    paths
        .iter()
        .filter_map(|p| {
            let path = Path::new(p);
            let meta = fs::symlink_metadata(path).ok()?;
            let name = path.file_name()?.to_string_lossy().to_string();
            build_entry(path, name, meta, true)
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    name: String,
    path: String,
    total_bytes: u64,
    free_bytes: u64,
    ejectable: bool,
    /// A share mounted over the network (SMB, AFP, NFS, WebDAV...), not a disk in this Mac.
    is_network: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    home: String,
    boot_volume_name: String,
    volumes: Vec<VolumeInfo>,
}

/// Filesystem types macOS uses for network shares.
fn is_network_fs(fs_type: &str) -> bool {
    matches!(fs_type, "smbfs" | "afpfs" | "nfs" | "webdav" | "cifs" | "ftp")
}

/// Whether the volume mounted at `path` lives on another machine.
fn is_network_volume(path: &str) -> bool {
    let Ok(c) = std::ffi::CString::new(path) else { return false };
    let mut st: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a valid NUL-terminated path and `st` is a zeroed statfs.
    if unsafe { libc::statfs(c.as_ptr(), &mut st) } != 0 {
        return false;
    }
    let ty: Vec<u8> = st.f_fstypename.iter().take_while(|&&b| b != 0).map(|&b| b as u8).collect();
    is_network_fs(&String::from_utf8_lossy(&ty)) || st.f_flags & (libc::MNT_LOCAL as u32) == 0
}

fn push_volume(v: &mut Vec<VolumeInfo>, path: &str, name: &str, ejectable: bool) {
    let total = fs2::total_space(path).unwrap_or(0);
    let free = fs2::available_space(path).unwrap_or(0);
    v.push(VolumeInfo {
        name: name.to_string(),
        path: path.to_string(),
        total_bytes: total,
        free_bytes: free,
        ejectable,
        is_network: is_network_volume(path),
    });
}

const SYSTEM_VOLUME_NAMES: [&str; 4] = ["Recovery", "Preboot", "VM", "Update"];

#[tauri::command(async)]
pub fn system_info() -> SystemInfo {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let root_dev = fs::metadata("/").map(|m| m.dev()).unwrap_or(0);
    let mut root_name = "Macintosh HD".to_string();
    let mut volumes = Vec::new();
    if let Ok(rd) = fs::read_dir("/Volumes") {
        for item in rd.flatten() {
            let p = item.path();
            let is_boot = fs::read_link(&p).map_or(false, |t| t == Path::new("/"))
                || fs::metadata(&p).map(|m| m.dev()).map_or(false, |d| d == root_dev);
            if is_boot {
                root_name = item.file_name().to_string_lossy().to_string();
                continue;
            }
            let name = item.file_name().to_string_lossy().to_string();
            if SYSTEM_VOLUME_NAMES
                .iter()
                .any(|v| name.eq_ignore_ascii_case(v))
            {
                continue;
            }
            push_volume(&mut volumes, &p.to_string_lossy(), &name, true);
        }
    }
    let mut all = Vec::with_capacity(volumes.len() + 1);
    push_volume(&mut all, "/", &root_name, false);
    all.extend(volumes);
    SystemInfo {
        home: home.to_string_lossy().to_string(),
        boot_volume_name: root_name,
        volumes: all,
    }
}

#[tauri::command(async)]
pub fn path_exists(path: String) -> bool {
    // Not following symlinks: a dangling link is still an item on disk.
    exists(Path::new(&path))
}

/// A fingerprint of a folder's contents list: its modification time, which
/// changes whenever an item is added, removed or renamed in it. A listing
/// taken when this matched is still right about *which* items exist.
#[tauri::command(async)]
pub fn dir_stamp(path: String) -> Option<String> {
    let modified = fs::metadata(&path).ok()?.modified().ok()?;
    let d = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(format!("{}.{:09}", d.as_secs(), d.subsec_nanos()))
}

/// Stable ids for `paths`, in order; `None` where a path can't be read.
#[tauri::command(async)]
pub fn file_ids(paths: Vec<String>) -> Vec<Option<String>> {
    paths
        .iter()
        .map(|p| fs::metadata(p).ok().map(|m| file_id_of(&m)))
        .collect()
}

/// Whether `dest_dir` is the folder `source` or somewhere inside it. Folders
/// are compared by identity (device and inode) up `dest_dir`'s real path, so
/// symlinks, firmlinks and letter case can't hide or fake a match. A symlink
/// source is never a container: it is moved or copied as the link.
fn is_within_subtree(source: &Path, dest_dir: &Path) -> bool {
    let Ok(s) = fs::symlink_metadata(source) else { return false };
    if !s.is_dir() {
        return false;
    }
    let d = fs::canonicalize(dest_dir).unwrap_or_else(|_| dest_dir.to_path_buf());
    d.ancestors()
        .filter_map(|p| fs::metadata(p).ok())
        .any(|m| m.dev() == s.dev() && m.ino() == s.ino())
}

/// Whether replacing the folder `container` with `item` would lose `item`:
/// it sits somewhere inside (a symlink inside counts, wherever it points),
/// or it is a symlink to the folder or something in it.
fn holds_item(container: &Path, item: &Path) -> bool {
    item.parent().is_some_and(|p| is_within_subtree(container, p))
        || fs::canonicalize(item).is_ok_and(|real| is_within_subtree(container, &real))
}

/// Whether the dot in `ext` (the text after a name's last dot) starts an
/// extension rather than being part of the name, as in "Project v1.2".
fn plausible_ext(ext: &str) -> bool {
    (1..=12).contains(&ext.len())
        && ext.chars().all(|c| c.is_ascii_alphanumeric())
        && ext.chars().any(|c| c.is_ascii_alphabetic())
}

/// `name` as stem and extension (with its dot) for numbering a copy:
/// "a.txt" is ("a", ".txt") and "a.tar.gz" is ("a", ".tar.gz"). A folder
/// that isn't a package ("Project v1.2"), a dot file, and a dot that
/// doesn't start a plausible extension keep the whole name as the stem.
pub(crate) fn split_ext(name: &str, plain_dir: bool) -> (&str, &str) {
    let Some(i) = name.rfind('.').filter(|&i| i > 0 && !plain_dir) else {
        return (name, "");
    };
    if !plausible_ext(&name[i + 1..]) {
        return (name, "");
    }
    let stem = &name[..i];
    match stem.rfind('.') {
        Some(j) if j > 0 && stem[j + 1..].eq_ignore_ascii_case("tar") => name.split_at(j),
        _ => name.split_at(i),
    }
}

/// True for a folder that isn't a package, whose name has no extension.
pub(crate) fn is_plain_dir(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())
        && !is_package_dir(
            p,
            &p.extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default(),
        )
}

fn copy_candidate(name: &str, n: usize, plain_dir: bool) -> String {
    if n == 0 {
        return name.to_string();
    }
    let (stem, ext) = split_ext(name, plain_dir);
    if n == 1 {
        format!("{} - Copy{}", stem, ext)
    } else {
        format!("{} - Copy ({}){}", stem, n, ext)
    }
}

fn reserve_dest(dest_dir: &Path, name: &str, is_dir: bool, plain_dir: bool) -> Result<PathBuf, String> {
    let mut n = 0usize;
    loop {
        let candidate = dest_dir.join(copy_candidate(name, n, plain_dir));
        let res = if is_dir {
            fs::create_dir(&candidate)
        } else {
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
                .map(|_| ())
        };
        match res {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(e) => return Err(strerr(e)),
        }
    }
}

fn same_dir(a: Option<&Path>, b: &Path) -> bool {
    let Some(a) = a else { return false };
    let ca = fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let cb = fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

pub(crate) fn unique_name(dir: &Path, base: &str, ext: &str) -> String {
    let mut name = format!("{}{}", base, ext);
    let mut n = 2;
    // A dangling symlink holds a name too: writing to it would land in
    // whatever it points to.
    while exists(&dir.join(&name)) {
        name = format!("{} ({}){}", base, n, ext);
        n += 1;
    }
    name
}

pub(crate) fn path_str(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

pub(crate) fn label(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path_str(p))
}

fn exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

fn remove_path(p: &Path) {
    let _ = remove_path_checked(p);
}

fn remove_path_checked(p: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(p),
        Ok(_) => fs::remove_file(p),
        Err(_) => Ok(()),
    }
}

static PARTIAL_SEQ: AtomicU64 = AtomicU64::new(0);

pub(crate) fn partial_path(dir: &Path) -> PathBuf {
    let n = PARTIAL_SEQ.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".wf-partial-{}-{n}", std::process::id()))
}

fn copy_to_unique(
    from: &Path,
    dest_dir: &Path,
    name: &str,
    job: &Job,
) -> Result<PathBuf, String> {
    let mut n = 0usize;
    let plain_dir = is_plain_dir(from);
    loop {
        let candidate = dest_dir.join(copy_candidate(name, n, plain_dir));
        n += 1;
        if exists(&candidate) {
            continue;
        }
        match copy_item(from, &candidate, job) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                remove_path(&candidate);
                return Err(strerr(e));
            }
        }
    }
}

struct Moved {
    to: PathBuf,
    leftover: Option<Leftover>,
    trashed_old: Option<String>,
}

/// A cross-volume move whose copy landed but whose original couldn't be
/// removed.
struct Leftover {
    warning: String,
    /// False when removing a folder failed partway, leaving only part of
    /// it: the copy is then the one complete version.
    original_intact: bool,
}

fn make_room(to: &Path, replace: bool) -> Result<Option<String>, String> {
    if replace && exists(to) {
        trash_one(&path_str(to))
    } else {
        Ok(None)
    }
}

fn restore_room(to: &Path, trashed: Option<String>) {
    if let Some(t) = trashed {
        let _ = fs::rename(t, to);
    }
}

fn move_item(
    from: &Path,
    dest_dir: &Path,
    name: &str,
    job: &Job,
    force_cross_volume: bool,
    replace: bool,
) -> Result<Moved, String> {
    let is_dir = fs::symlink_metadata(from).map(|m| m.is_dir()).unwrap_or(false);
    let to = if replace {
        dest_dir.join(name)
    } else {
        reserve_dest(dest_dir, name, is_dir, is_plain_dir(from))?
    };
    let cleanup_to = |to: &Path| {
        if !replace {
            remove_path(to);
        }
    };
    if !force_cross_volume {
        let trashed = make_room(&to, replace)?;
        match fs::rename(from, &to) {
            Ok(()) => {
                return Ok(Moved {
                    to,
                    leftover: None,
                    trashed_old: trashed,
                })
            }
            Err(e) => {
                restore_room(&to, trashed);
                if e.raw_os_error() != Some(libc::EXDEV) {
                    cleanup_to(&to);
                    return Err(strerr(e));
                }
            }
        }
    }
    let partial = partial_path(dest_dir);
    if let Err(e) = copy_item(from, &partial, job) {
        remove_path(&partial);
        cleanup_to(&to);
        return Err(strerr(e));
    }
    let trashed = match make_room(&to, replace) {
        Ok(t) => t,
        Err(e) => {
            remove_path(&partial);
            cleanup_to(&to);
            return Err(e);
        }
    };
    if let Err(e) = fs::rename(&partial, &to) {
        remove_path(&partial);
        cleanup_to(&to);
        restore_room(&to, trashed);
        return Err(strerr(e));
    }
    // Removing a file either happens or doesn't; a folder can lose part of
    // its contents before failing.
    let leftover = remove_path_checked(from).err().map(|e| Leftover {
        warning: if is_dir {
            format!(
                "\"{name}\": copied, but removing the original stopped partway ({e}). \
                 The copy is complete; what's left of the original is still where it was"
            )
        } else {
            format!("\"{name}\": copied, but the original couldn't be removed ({e})")
        },
        original_intact: !is_dir,
    });
    Ok(Moved {
        to,
        leftover,
        trashed_old: trashed,
    })
}

fn copy_replacing(
    from: &Path,
    dest_dir: &Path,
    name: &str,
    job: &Job,
) -> Result<(PathBuf, Option<String>), String> {
    let to = dest_dir.join(name);
    let partial = partial_path(dest_dir);
    if let Err(e) = copy_item(from, &partial, job) {
        remove_path(&partial);
        return Err(strerr(e));
    }
    let trashed = match make_room(&to, true) {
        Ok(t) => t,
        Err(e) => {
            remove_path(&partial);
            return Err(e);
        }
    };
    if let Err(e) = fs::rename(&partial, &to) {
        remove_path(&partial);
        restore_room(&to, trashed);
        return Err(strerr(e));
    }
    Ok((to, trashed))
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Resolution {
    Replace,
    Skip,
    KeepBoth,
}

pub type Resolutions = HashMap<String, Resolution>;

/// Names one transfer has already put into its destination. Two sources with
/// the same name (`/x/a.txt`, `/y/a.txt`) both conflict with the `a.txt`
/// already there; replacing for the second would trash the first's arrival
/// and leave undo restoring the wrong item, so the second keeps both instead.
#[derive(Default)]
struct Placed(std::collections::HashSet<String>);

impl Placed {
    /// Case-folded, as APFS and HFS+ volumes are case-insensitive by default.
    fn key(name: &str) -> String {
        name.to_lowercase()
    }

    fn add(&mut self, arrived: &Path) {
        self.0.insert(Self::key(&label(arrived)));
    }

    fn guard(&self, name: &str, decision: Resolution) -> Resolution {
        if decision == Resolution::Replace && self.0.contains(&Self::key(name)) {
            Resolution::KeepBoth
        } else {
            decision
        }
    }
}

fn decide(from: &Path, dest: &Path, name: &str, resolutions: &Resolutions) -> Resolution {
    if !exists(&dest.join(name)) || same_dir(from.parent(), dest) {
        return Resolution::KeepBoth;
    }
    resolutions
        .get(&path_str(from))
        .copied()
        .unwrap_or(Resolution::KeepBoth)
}

fn copy_one(
    src: &str,
    dest: &Path,
    job: &Job,
    res: &mut OpResult,
    resolutions: &Resolutions,
    placed: &mut Placed,
) {
    let from = Path::new(src);
    let Some(name) = from.file_name().map(|s| s.to_string_lossy().to_string()) else {
        res.errors.push(format!("invalid source path: {src}"));
        return;
    };
    if is_within_subtree(from, dest) {
        res.errors
            .push(format!("Can't put \"{name}\" into itself or its own subfolder"));
        return;
    }
    let decision = placed.guard(&name, decide(from, dest, &name, resolutions));
    if decision == Resolution::Skip {
        job.item_done();
        return;
    }
    if decision == Resolution::Replace && holds_item(&dest.join(&name), from) {
        res.errors
            .push(format!("Can't replace \"{name}\" with an item inside it"));
        job.item_done();
        return;
    }
    job.set_current(&name);
    let done = if decision == Resolution::Replace {
        copy_replacing(from, dest, &name, job).map(|(p, trashed)| {
            placed.add(&p);
            let mut undo = vec![Step::trash(path_str(&p))];
            if let Some(old) = trashed {
                undo.push(Step::moved(old, path_str(&p)));
            }
            undo
        })
    } else {
        copy_to_unique(from, dest, &name, job).map(|p| {
            placed.add(&p);
            vec![Step::trash(path_str(&p))]
        })
    };
    match done {
        Ok(undo) => res.inverse.extend(undo),
        Err(_) if job.cancelled() => res.cancelled = true,
        Err(e) => res.errors.push(format!("\"{name}\": {e}")),
    }
    job.item_done();
}

fn move_one(
    src: &str,
    dest: &Path,
    job: &Job,
    res: &mut OpResult,
    force_cross_volume: bool,
    resolutions: &Resolutions,
    placed: &mut Placed,
) {
    let from = Path::new(src);
    let Some(name) = from.file_name().map(|s| s.to_string_lossy().to_string()) else {
        res.errors.push(format!("invalid source path: {src}"));
        return;
    };
    if is_within_subtree(from, dest) {
        res.errors
            .push(format!("Can't move \"{name}\" into itself or its own subfolder"));
        return;
    }
    if same_dir(from.parent(), dest) {
        job.item_done();
        return;
    }
    if let Err(e) = guard::check(from) {
        res.errors.push(format!("\"{name}\": {e}"));
        job.item_done();
        return;
    }
    let decision = placed.guard(&name, decide(from, dest, &name, resolutions));
    if decision == Resolution::Skip {
        job.item_done();
        return;
    }
    if decision == Resolution::Replace && holds_item(&dest.join(&name), from) {
        res.errors
            .push(format!("Can't replace \"{name}\" with an item inside it"));
        job.item_done();
        return;
    }
    job.set_current(&name);
    match move_item(
        from,
        dest,
        &name,
        job,
        force_cross_volume,
        decision == Resolution::Replace,
    ) {
        Ok(Moved {
            to,
            leftover: None,
            trashed_old,
        }) => {
            placed.add(&to);
            res.inverse.push(Step::moved(path_str(&to), src.to_string()));
            if let Some(old) = trashed_old {
                res.inverse.push(Step::moved(old, path_str(&to)));
            }
        }
        Ok(Moved {
            to,
            leftover: Some(left),
            trashed_old,
        }) => {
            // The copy landed even though the original stayed behind, so
            // undo removes the copy (and restores whatever it replaced) -
            // but only while the original is whole. A folder removed partway
            // leaves the copy as the one complete version, which stays put.
            placed.add(&to);
            res.errors.push(left.warning);
            if left.original_intact {
                res.inverse.push(Step::trash(path_str(&to)));
                if let Some(old) = trashed_old {
                    res.inverse.push(Step::moved(old, path_str(&to)));
                }
            }
        }
        Err(_) if job.cancelled() => res.cancelled = true,
        Err(e) => res.errors.push(format!("\"{name}\": {e}")),
    }
    job.item_done();
}

#[derive(Clone, Copy)]
enum Mode {
    Copy,
    Move,
    Drop { force_copy: bool },
}

fn run_transfer(
    sources: &[String],
    dest_dir: &str,
    mode: Mode,
    resolutions: &Resolutions,
    job: &JobGuard,
) -> OpResult {
    let dest = Path::new(dest_dir);
    let copies = |s: &str| match mode {
        Mode::Copy => true,
        Mode::Move => false,
        Mode::Drop { force_copy } => force_copy || !on_same_volume(Path::new(s), dest),
    };
    let heavy: Vec<String> = sources
        .iter()
        .filter(|s| copies(s) || !on_same_volume(Path::new(s), dest))
        .cloned()
        .collect();
    job.set_items_total(sources.len());
    jobs::start_scan(job, heavy);
    let mut res = OpResult::default();
    let mut placed = Placed::default();
    for src in sources {
        if job.cancelled() {
            res.cancelled = true;
            break;
        }
        if copies(src) {
            copy_one(src, dest, job, &mut res, resolutions, &mut placed);
        } else {
            move_one(src, dest, job, &mut res, false, resolutions, &mut placed);
        }
        if res.cancelled {
            break;
        }
    }
    res
}

#[tauri::command]
pub async fn copy_paths(
    sources: Vec<String>,
    dest_dir: String,
    resolutions: Resolutions,
    job_id: u64,
    on_progress: Channel<Progress>,
) -> Result<OpResult, String> {
    jobs::blocking(move || {
        let job = jobs::begin(job_id, on_progress);
        run_transfer(&sources, &dest_dir, Mode::Copy, &resolutions, &job)
    })
    .await
}

#[tauri::command]
pub async fn move_paths(
    sources: Vec<String>,
    dest_dir: String,
    resolutions: Resolutions,
    job_id: u64,
    on_progress: Channel<Progress>,
) -> Result<OpResult, String> {
    jobs::blocking(move || {
        let job = jobs::begin(job_id, on_progress);
        run_transfer(&sources, &dest_dir, Mode::Move, &resolutions, &job)
    })
    .await
}

fn on_same_volume(src: &Path, dest: &Path) -> bool {
    match (fs::symlink_metadata(src), fs::metadata(dest)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev(),
        _ => false,
    }
}

#[tauri::command(async)]
pub fn drop_moves(sources: Vec<String>, dest_dir: String) -> bool {
    let dest = Path::new(&dest_dir);
    !sources.is_empty() && sources.iter().all(|s| on_same_volume(Path::new(s), dest))
}

#[tauri::command(async)]
pub fn drop_plan(sources: Vec<String>, dest_dir: String) -> Vec<bool> {
    let dest = Path::new(&dest_dir);
    sources
        .iter()
        .map(|s| on_same_volume(Path::new(s), dest))
        .collect()
}

#[tauri::command]
pub async fn transfer_paths(
    sources: Vec<String>,
    dest_dir: String,
    force_copy: bool,
    resolutions: Resolutions,
    job_id: u64,
    on_progress: Channel<Progress>,
) -> Result<OpResult, String> {
    jobs::blocking(move || {
        let job = jobs::begin(job_id, on_progress);
        run_transfer(&sources, &dest_dir, Mode::Drop { force_copy }, &resolutions, &job)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSide {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub source: ConflictSide,
    pub existing: ConflictSide,
    pub can_replace: bool,
}

fn conflict_side(p: &Path) -> Option<ConflictSide> {
    let meta = fs::metadata(p).or_else(|_| fs::symlink_metadata(p)).ok()?;
    Some(ConflictSide {
        path: path_str(p),
        name: label(p),
        is_dir: meta.is_dir(),
        size: if meta.is_dir() { 0 } else { meta.len() },
        modified_ms: unix_ms(meta.modified()),
    })
}

#[tauri::command(async)]
pub fn find_conflicts(sources: Vec<String>, dest_dir: String) -> Vec<Conflict> {
    let dest = Path::new(&dest_dir);
    sources
        .iter()
        .filter_map(|s| {
            let from = Path::new(s);
            let name = from.file_name()?;
            let target = dest.join(name);
            if !exists(&target) || same_dir(from.parent(), dest) {
                return None;
            }
            let source = conflict_side(from)?;
            let existing = conflict_side(&target)?;
            let can_replace =
                source.is_dir == existing.is_dir && !holds_item(&target, from);
            Some(Conflict {
                source,
                existing,
                can_replace,
            })
        })
        .collect()
}

/// True for a case-only rename on a case-insensitive volume, where `to`
/// already resolves to the very file being renamed. On a case-sensitive
/// volume the two names are distinct files and must not be conflated.
fn same_file_case_only(from: &Path, to: &Path) -> bool {
    if path_str(from).to_lowercase() != path_str(to).to_lowercase() {
        return false;
    }
    match (fs::symlink_metadata(from), fs::symlink_metadata(to)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

fn move_exact(from: &Path, to: &Path, job: &Job) -> Result<(), String> {
    guard::check(from)?;
    if exists(to) && !same_file_case_only(from, to) {
        return Err(format!("An item named \"{}\" already exists", label(to)));
    }
    if !exists(from) {
        return Err("it is no longer there".to_string());
    }
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            let dir = to.parent().ok_or_else(|| "invalid destination".to_string())?;
            let partial = partial_path(dir);
            let done = copy_item(from, &partial, job).and_then(|_| fs::rename(&partial, to));
            if let Err(e) = done {
                remove_path(&partial);
                return Err(strerr(e));
            }
            remove_path_checked(from).map_err(strerr)
        }
        Err(e) => Err(strerr(e)),
    }
}

/// Refuses a step whose item has been replaced by another at the same path.
fn same_item(path: &str, id: &Option<String>) -> Result<(), String> {
    match id {
        Some(id) if exists(Path::new(path)) && jobs::file_id(Path::new(path)).as_ref() != Some(id) => {
            Err("it has been replaced by another item since".to_string())
        }
        _ => Ok(()),
    }
}

fn apply_step(step: &Step, job: &Job) -> Result<Option<Step>, String> {
    match step {
        Step::Move { from, to, id } => {
            same_item(from, id)?;
            move_exact(Path::new(from), Path::new(to), job)?;
            Ok(Some(Step::moved(to.clone(), from.clone())))
        }
        Step::Copy { from, to } => {
            if exists(Path::new(to)) {
                return Err(format!(
                    "An item named \"{}\" already exists",
                    label(Path::new(to))
                ));
            }
            copy_item(Path::new(from), Path::new(to), job).map_err(|e| {
                if e.kind() != std::io::ErrorKind::AlreadyExists {
                    remove_path(Path::new(to));
                }
                strerr(e)
            })?;
            Ok(Some(Step::trash(to.clone())))
        }
        Step::Trash { path, id } => {
            same_item(path, id)?;
            Ok(trash_one(path)?.map(|trashed| Step::moved(trashed, path.clone())))
        }
    }
}

fn run_steps(steps: &[Step], job: &JobGuard) -> OpResult {
    job.set_items_total(steps.len());
    jobs::start_scan(
        job,
        steps
            .iter()
            .filter_map(|s| match s {
                Step::Copy { from, .. } => Some(from.clone()),
                _ => None,
            })
            .collect(),
    );
    let mut res = OpResult::default();
    for step in steps {
        if job.cancelled() {
            res.cancelled = true;
            break;
        }
        let (Step::Move { to: subject, .. } | Step::Copy { to: subject, .. } | Step::Trash { path: subject, .. }) =
            step;
        job.set_current(&label(Path::new(subject)));
        match apply_step(step, job) {
            Ok(Some(inverse)) => res.inverse.push(inverse),
            Ok(None) => {}
            Err(_) if job.cancelled() => {
                res.cancelled = true;
                break;
            }
            Err(e) => res
                .errors
                .push(format!("\"{}\": {e}", label(Path::new(subject)))),
        }
        job.item_done();
    }
    res.inverse.reverse();
    res
}

#[tauri::command]
pub async fn apply_steps(
    steps: Vec<Step>,
    job_id: u64,
    on_progress: Channel<Progress>,
) -> Result<OpResult, String> {
    jobs::blocking(move || {
        let job = jobs::begin(job_id, on_progress);
        run_steps(&steps, &job)
    })
    .await
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." {
        return Err(format!("\"{name}\" isn't a valid name"));
    }
    if name.contains('/') || name.contains(':') || name.contains('\0') {
        return Err("A name can't contain a slash (/) or colon (:)".to_string());
    }
    if name.len() > 255 {
        return Err("That name is too long".to_string());
    }
    Ok(())
}

#[tauri::command(async)]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    let dest = Path::new(&to);
    validate_name(&label(dest))?;
    if Path::new(&from).parent() != dest.parent() {
        return Err("A name can't contain a slash (/) or colon (:)".to_string());
    }
    if exists(dest) && !same_file_case_only(Path::new(&from), dest) {
        let name = dest
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        return Err(format!("An item named \"{}\" already exists", name));
    }
    guard::check(Path::new(&from)).map_err(|e| format!("\"{}\": {e}", label(Path::new(&from))))?;
    fs::rename(&from, dest).map_err(strerr)
}

#[tauri::command(async)]
pub fn create_dir(parent: String) -> Result<String, String> {
    let p = Path::new(&parent);
    let name = unique_name(p, "New folder", "");
    let full = p.join(&name);
    fs::create_dir(&full).map_err(strerr)?;
    Ok(full.to_string_lossy().to_string())
}

#[tauri::command(async)]
pub fn create_file(parent: String) -> Result<String, String> {
    let p = Path::new(&parent);
    let name = unique_name(p, "New Text Document", ".txt");
    let full = p.join(&name);
    // `create_new` refuses a symlink in the way rather than writing through it.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&full)
        .map_err(strerr)?;
    Ok(full.to_string_lossy().to_string())
}

#[cfg(target_os = "macos")]
fn trash_one(path: &str) -> Result<Option<String>, String> {
    use objc2::rc::Retained;
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    guard::check(Path::new(path))?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let mut resulting: Option<Retained<NSURL>> = None;
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting))
        .map_err(|e| e.localizedDescription().to_string())?;
    Ok(resulting.and_then(|u| u.path()).map(|p| p.to_string()))
}

#[cfg(not(target_os = "macos"))]
fn trash_one(path: &str) -> Result<Option<String>, String> {
    guard::check(Path::new(path))?;
    trash::delete(path).map_err(|e| e.to_string())?;
    Ok(None)
}

#[tauri::command]
pub async fn trash_paths(paths: Vec<String>) -> Result<OpResult, String> {
    jobs::blocking(move || trash_paths_sync(&paths)).await
}

fn trash_paths_sync(paths: &[String]) -> OpResult {
    let mut res = OpResult::default();
    for p in paths {
        match trash_one(p) {
            Ok(Some(trashed)) => res.inverse.push(Step::moved(trashed, p.clone())),
            Ok(None) => {}
            Err(e) => res
                .errors
                .push(format!("\"{}\": {e}", label(Path::new(p)))),
        }
    }
    res
}

#[tauri::command(async)]
pub fn open_terminal(path: String, app: Option<String>) -> Result<(), String> {
    let p = Path::new(&path);
    let dir = if p.is_dir() {
        p.to_path_buf()
    } else {
        p.parent()
            .map(|x| x.to_path_buf())
            .unwrap_or_else(|| p.to_path_buf())
    };
    // `app` is an application bundle's path; without one, Terminal. Only a
    // known terminal by name or a real bundle on disk is accepted.
    let app = app.unwrap_or_else(|| "Terminal".to_string());
    crate::openwith::check_terminal(&app)?;
    let name = Path::new(&app)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| app.clone());
    if name.eq_ignore_ascii_case("wezterm") {
        // WezTerm doesn't take a folder as a document; it takes one on its
        // command line, which only reaches it from outside the sandbox.
        return crate::launcher::run(&format!(
            "exec /usr/bin/open -na {} --args start --cwd {}",
            shell_quote(&app),
            shell_quote(&dir.to_string_lossy())
        ));
    }
    let status = std::process::Command::new("/usr/bin/open")
        .args(["-a", &app, "--"])
        .arg(&dir)
        .status()
        .map_err(|e| format!("failed to launch {name}: {e}"))?;
    if !status.success() {
        return Err(format!("{name} couldn't open \"{}\"", label(&dir)));
    }
    Ok(())
}

/// How a command handed to a terminal went: `ran` when the terminal took
/// it, otherwise the terminal was only opened in the folder, with `reason`
/// saying why when something refused.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunOutcome {
    pub ran: bool,
    pub reason: Option<String>,
}

/// Runs `command` in a new window of the terminal `app` (a bundle path, or
/// Terminal), in the folder `dir`, as the address bar does for a word that
/// isn't a folder. Terminal takes it as a `.command` file, iTerm2 by
/// AppleScript, Warp through a launch configuration, Ghostty and WezTerm on
/// their command lines, each leaving the shell open. Zentty and any other
/// app only open in the folder, which the answer says so the page can hand
/// the command over another way.
///
/// All but Warp go through the launcher applet (launcher.rs): started from
/// Doftar's sandbox, LaunchServices would drop the arguments and Terminal
/// would refuse the file, and a terminal started as a child would inherit
/// the sandbox, which a shell can't live in.
#[tauri::command(async)]
pub fn run_in_terminal(dir: String, command: String, app: Option<String>) -> Result<RunOutcome, String> {
    let dir_path = Path::new(&dir);
    if !dir_path.is_absolute() || !dir_path.is_dir() {
        return Err(format!("\"{}\" isn't a folder", label(dir_path)));
    }
    let command = command.trim();
    if command.is_empty() {
        return Err("nothing to run".into());
    }
    let app = app.unwrap_or_else(|| "Terminal".to_string());
    crate::openwith::check_terminal(&app)?;
    let name = Path::new(&app)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| app.clone());
    // What the shell runs: into the folder, then the command as typed.
    let line = format!("cd {} && {command}", shell_quote(&dir));
    // The same, then an interactive login shell to stay in afterwards.
    let keep_open = format!("{line}; exec /bin/zsh -il");
    let kind = name.to_ascii_lowercase();
    let attempt: Result<(), String> = match kind.as_str() {
        "terminal" => command_file(&line).and_then(|file| {
            crate::launcher::run(&format!(
                "exec /usr/bin/open -a {} {}",
                shell_quote(&app),
                shell_quote(&file.to_string_lossy())
            ))
        }),
        "iterm2" | "iterm" => {
            let script = format!(
                "tell application \"{name}\"\nactivate\nset w to (create window with default profile)\ntell current session of w to write text \"{}\"\nend tell",
                applescript_quote(&line)
            );
            crate::launcher::run(&format!("exec /usr/bin/osascript -e {}", shell_quote(&script)))
        }
        k if k.starts_with("warp") => warp_launch(&dir, command, &app),
        // An option before -e would be ignored, so the shell does the cd.
        "ghostty" => crate::launcher::run(&format!(
            "exec /usr/bin/open -na {} --args -e /bin/zsh -lc {}",
            shell_quote(&app),
            shell_quote(&keep_open)
        )),
        "wezterm" => crate::launcher::run(&format!(
            "exec /usr/bin/open -na {} --args start --cwd {} -- /bin/zsh -lc {}",
            shell_quote(&app),
            shell_quote(&dir),
            shell_quote(&keep_open)
        )),
        _ => Err(format!("{name} can't be handed a command")),
    };
    match attempt {
        Ok(()) => Ok(RunOutcome { ran: true, reason: None }),
        Err(reason) => {
            open_terminal(dir, Some(app))?;
            Ok(RunOutcome { ran: false, reason: Some(reason) })
        }
    }
}

/// A one-off script that runs `line` in the user's login shell and leaves
/// an interactive shell behind, for Terminal to open. It deletes itself as
/// it starts.
fn command_file(line: &str) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let root = crate::thumbs::cache_root().ok_or("no cache folder")?.join("run");
    fs::create_dir_all(&root).map_err(strerr)?;
    crate::cache::make_private(&root);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file = root.join(format!("run-{stamp}.command"));
    fs::write(&file, format!("#!/bin/zsh -il\nrm -f -- \"$0\"\n{line}\nexec /bin/zsh -il\n")).map_err(strerr)?;
    fs::set_permissions(&file, fs::Permissions::from_mode(0o700)).map_err(strerr)?;
    Ok(file)
}

/// Writes a Warp launch configuration (a tab in `dir` that runs `command`)
/// and asks Warp to open it. The same file is rewritten each time.
fn warp_launch(dir: &str, command: &str, app: &str) -> Result<(), String> {
    let folder = dirs::home_dir()
        .ok_or("no home folder")?
        .join(".warp/launch_configurations");
    std::fs::create_dir_all(&folder).map_err(strerr)?;
    let yaml = format!(
        "---\nname: doftar-run\nwindows:\n  - tabs:\n      - title: {}\n        layout:\n          cwd: {}\n          commands:\n            - exec: {}\n",
        yaml_str(command),
        yaml_str(dir),
        yaml_str(command)
    );
    std::fs::write(folder.join("doftar-run.yaml"), yaml).map_err(strerr)?;
    let status = std::process::Command::new("/usr/bin/open")
        .arg("-a")
        .arg(app)
        .arg("warp://launch/doftar-run")
        .status()
        .map_err(strerr)?;
    if status.success() {
        Ok(())
    } else {
        Err("Warp didn't open the launch configuration".into())
    }
}

/// `s` as a double-quoted YAML string.
fn yaml_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn remove_tree(path: &Path, job: &Job) -> std::io::Result<()> {
    if job.cancelled() {
        return Err(std::io::ErrorKind::Interrupted.into());
    }
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() {
        return fs::remove_file(path);
    }
    for item in fs::read_dir(path)? {
        let item = item?;
        let p = item.path();
        job.set_current(&label(&p));
        remove_tree(&p, job)?;
    }
    fs::remove_dir(path)
}

#[tauri::command]
pub async fn delete_permanently(
    paths: Vec<String>,
    job_id: u64,
    on_progress: Channel<Progress>,
) -> Result<OpResult, String> {
    jobs::blocking(move || {
        let job = jobs::begin(job_id, on_progress);
        delete_permanently_sync(&paths, &job)
    })
    .await
}

fn delete_permanently_sync(paths: &[String], job: &JobGuard) -> OpResult {
    job.set_items_total(paths.len());
    let mut res = OpResult::default();
    for p in paths {
        if job.cancelled() {
            res.cancelled = true;
            break;
        }
        let path = Path::new(p);
        job.set_current(&label(path));
        // A locked item is removed as Empty Trash removes it.
        match guard::check(path)
            .map_err(std::io::Error::other)
            .and_then(|()| crate::trash::retry_unlocked(path, || remove_tree(path, job)))
        {
            Ok(()) => {}
            Err(_) if job.cancelled() => {
                res.cancelled = true;
                break;
            }
            Err(e) => res.errors.push(format!("\"{}\": {e}", label(path))),
        }
        job.item_done();
    }
    res
}

#[cfg(target_os = "macos")]
fn copy_item(from: &Path, to: &Path, job: &Job) -> std::io::Result<()> {
    macos_copy::copy(from, to, job, true)
}

#[cfg(target_os = "macos")]
mod macos_copy {
    use crate::jobs::Job;
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int, c_void};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    const COPYFILE_ACL: u32 = 1 << 0;
    const COPYFILE_STAT: u32 = 1 << 1;
    const COPYFILE_XATTR: u32 = 1 << 2;
    const COPYFILE_DATA: u32 = 1 << 3;
    const COPYFILE_ALL: u32 = COPYFILE_ACL | COPYFILE_STAT | COPYFILE_XATTR | COPYFILE_DATA;
    const COPYFILE_RECURSIVE: u32 = 1 << 15;
    const COPYFILE_EXCL: u32 = 1 << 17;
    const COPYFILE_NOFOLLOW_SRC: u32 = 1 << 18;
    const COPYFILE_CLONE: u32 = 1 << 24;

    const STATE_STATUS_CB: u32 = 6;
    const STATE_STATUS_CTX: u32 = 7;
    const STATE_COPIED: u32 = 8;

    const RECURSE_FILE: c_int = 1;
    const COPY_DATA: c_int = 4;
    const STAGE_START: c_int = 1;
    const STAGE_ERR: c_int = 3;
    const STAGE_PROGRESS: c_int = 4;
    const CONTINUE: c_int = 0;
    const QUIT: c_int = 2;

    extern "C" {
        fn copyfile(from: *const c_char, to: *const c_char, state: *mut c_void, flags: u32)
            -> c_int;
        fn copyfile_state_alloc() -> *mut c_void;
        fn copyfile_state_free(state: *mut c_void) -> c_int;
        fn copyfile_state_set(state: *mut c_void, flag: u32, src: *const c_void) -> c_int;
        fn copyfile_state_get(state: *mut c_void, flag: u32, dst: *mut c_void) -> c_int;
    }

    struct Ctx<'a> {
        job: &'a Job,
        last: u64,
    }

    extern "C" fn on_status(
        what: c_int,
        stage: c_int,
        state: *mut c_void,
        src: *const c_char,
        _dst: *const c_char,
        ctx: *mut c_void,
    ) -> c_int {
        let c = unsafe { &mut *(ctx as *mut Ctx) };
        if c.job.cancelled() || stage == STAGE_ERR {
            return QUIT;
        }
        match (what, stage) {
            (RECURSE_FILE, STAGE_START) if !src.is_null() => {
                c.last = 0;
                let path = unsafe { CStr::from_ptr(src) }.to_string_lossy();
                if let Some(name) = path.rsplit('/').next() {
                    c.job.set_current(name);
                }
            }
            (COPY_DATA, STAGE_PROGRESS) => {
                let mut copied: i64 = 0;
                unsafe {
                    copyfile_state_get(state, STATE_COPIED, &mut copied as *mut i64 as *mut c_void)
                };
                let copied = copied.max(0) as u64;
                if copied > c.last {
                    c.job.add_bytes(copied - c.last);
                }
                c.last = copied;
            }
            _ => {}
        }
        CONTINUE
    }

    pub fn copy(from: &Path, to: &Path, job: &Job, clone: bool) -> std::io::Result<()> {
        let src = CString::new(from.as_os_str().as_bytes())?;
        let dst = CString::new(to.as_os_str().as_bytes())?;
        let mut ctx = Ctx { job, last: 0 };
        // NOFOLLOW_SRC copies a symlink at the top as the link itself, as
        // the recursive copy already does for links inside a folder: a
        // dangling link would otherwise fail, and a link to a folder would
        // become a copy of the folder.
        let flags = COPYFILE_ALL
            | COPYFILE_RECURSIVE
            | COPYFILE_NOFOLLOW_SRC
            | if clone {
                COPYFILE_CLONE
            } else {
                COPYFILE_EXCL | COPYFILE_NOFOLLOW_SRC
            };
        unsafe {
            let state = copyfile_state_alloc();
            if state.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            copyfile_state_set(state, STATE_STATUS_CB, on_status as *const () as *const c_void);
            copyfile_state_set(
                state,
                STATE_STATUS_CTX,
                &mut ctx as *mut Ctx as *const c_void,
            );
            let rc = copyfile(src.as_ptr(), dst.as_ptr(), state, flags);
            let err = std::io::Error::last_os_error();
            copyfile_state_free(state);
            if rc == 0 {
                Ok(())
            } else if job.cancelled() {
                Err(std::io::ErrorKind::Interrupted.into())
            } else {
                Err(err)
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn copy_item(from: &Path, to: &Path, job: &Job) -> std::io::Result<()> {
    use std::io::{Read, Write};

    if job.cancelled() {
        return Err(std::io::ErrorKind::Interrupted.into());
    }
    if exists(to) {
        return Err(std::io::ErrorKind::AlreadyExists.into());
    }
    let meta = fs::symlink_metadata(from)?;
    if meta.is_dir() {
        fs::create_dir(to)?;
        for item in fs::read_dir(from)? {
            let item = item?;
            copy_item(&item.path(), &to.join(item.file_name()), job)?;
        }
    } else if meta.file_type().is_symlink() {
        std::os::unix::fs::symlink(fs::read_link(from)?, to)?;
    } else {
        let mut src = fs::File::open(from)?;
        let mut dst = fs::OpenOptions::new().write(true).create_new(true).open(to)?;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            if job.cancelled() {
                return Err(std::io::ErrorKind::Interrupted.into());
            }
            let n = src.read(&mut buf)?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n])?;
            job.add_bytes(n as u64);
        }
        fs::set_permissions(to, meta.permissions())?;
    }
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("wf-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn transfer_moves_on_same_volume_and_copies_when_forced() {
        let base = scratch("xfer");
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        fs::write(base.join("a.txt"), "a").unwrap();
        fs::write(base.join("b.txt"), "b").unwrap();
        let d = dest.to_string_lossy().to_string();
        let job = jobs::detached();

        let a = base.join("a.txt").to_string_lossy().to_string();
        assert!(drop_moves(vec![a.clone()], d.clone()));
        let res = run_transfer(&[a.clone()], &d, Mode::Drop { force_copy: false }, &Resolutions::new(), &job);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert!(!base.join("a.txt").exists());
        assert!(dest.join("a.txt").exists());
        assert_eq!(
            res.inverse,
            vec![Step::moved(path_str(&dest.join("a.txt")), a)]
        );

        let b = base.join("b.txt").to_string_lossy().to_string();
        let res = run_transfer(&[b], &d, Mode::Drop { force_copy: true }, &Resolutions::new(), &job);
        assert!(res.errors.is_empty());
        assert!(base.join("b.txt").exists());
        assert!(dest.join("b.txt").exists());
        assert_eq!(
            res.inverse,
            vec![Step::trash(path_str(&dest.join("b.txt")))]
        );

        let res = run_transfer(&[d.clone()], &d, Mode::Drop { force_copy: false }, &Resolutions::new(), &job);
        assert_eq!(res.errors.len(), 1);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn copy_preserves_xattrs_links_and_names() {
        let base = scratch("copy");
        let src = base.join("src");
        let dest = base.join("dest");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::create_dir_all(&dest).unwrap();
        fs::write(src.join("a.txt"), "hi").unwrap();
        fs::write(src.join("sub/b.txt"), "yo").unwrap();
        std::os::unix::fs::symlink("a.txt", src.join("link")).unwrap();
        let tag = "com.apple.metadata:_kMDItemUserTags";
        assert!(std::process::Command::new("xattr")
            .args(["-w", tag, "Red"])
            .arg(src.join("a.txt"))
            .status()
            .unwrap()
            .success());
        let job = jobs::detached();

        let first = copy_to_unique(&src, &dest, "src", &job).unwrap();
        let second = copy_to_unique(&src, &dest, "src", &job).unwrap();
        let file = copy_to_unique(&src.join("a.txt"), &dest, "a.txt", &job).unwrap();
        let file2 = copy_to_unique(&src.join("a.txt"), &dest, "a.txt", &job).unwrap();
        assert_eq!(first, dest.join("src"));
        assert_eq!(second, dest.join("src - Copy"));
        assert_eq!(file, dest.join("a.txt"));
        assert_eq!(file2, dest.join("a - Copy.txt"));
        assert_eq!(fs::read_to_string(first.join("sub/b.txt")).unwrap(), "yo");
        assert!(fs::symlink_metadata(first.join("link"))
            .unwrap()
            .file_type()
            .is_symlink());
        let out = std::process::Command::new("xattr")
            .args(["-p", tag])
            .arg(first.join("a.txt"))
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "Red");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn data_copy_reports_every_byte() {
        let base = scratch("progress");
        let src = base.join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("big.bin"), vec![7u8; 3 << 20]).unwrap();
        fs::write(src.join("sub/small.bin"), vec![1u8; 1000]).unwrap();
        let job = jobs::detached();
        macos_copy::copy(&src, &base.join("out"), &job, false).unwrap();
        assert_eq!(job.bytes_done(), (3 << 20) + 1000);
        assert_eq!(fs::read(base.join("out/sub/small.bin")).unwrap().len(), 1000);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn cancelled_copy_leaves_nothing_behind() {
        let base = scratch("cancel");
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        fs::write(base.join("a.txt"), "a").unwrap();
        let job = jobs::detached();
        job.cancel();
        let res = run_transfer(
            &[path_str(&base.join("a.txt"))],
            &path_str(&dest),
            Mode::Copy,
            &Resolutions::new(),
            &job,
        );
        assert!(res.cancelled);
        assert!(res.inverse.is_empty());
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);

        let src = base.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("big.bin"), vec![0u8; 2 << 20]).unwrap();
        let job = jobs::detached();
        job.cancel();
        assert!(copy_to_unique(&src, &dest, "src", &job).is_err());
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn cross_volume_move_is_atomic_and_leaves_no_scratch() {
        let base = scratch("xvol");
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        let src = base.join("tree");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("sub/f.txt"), "x").unwrap();
        fs::write(base.join("one.txt"), "1").unwrap();
        let job = jobs::detached();

        let moved = move_item(&src, &dest, "tree", &job, true, false).unwrap();
        assert!(moved.leftover.is_none());
        assert_eq!(moved.to, dest.join("tree"));
        assert!(!src.exists());
        assert_eq!(fs::read_to_string(dest.join("tree/sub/f.txt")).unwrap(), "x");
        let moved = move_item(&base.join("one.txt"), &dest, "one.txt", &job, true, false).unwrap();
        assert_eq!(fs::read_to_string(moved.to).unwrap(), "1");
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 2);

        let keep = base.join("keep");
        fs::create_dir_all(&keep).unwrap();
        fs::write(keep.join("k.txt"), "k").unwrap();
        let job = jobs::detached();
        job.cancel();
        assert!(move_item(&keep, &dest, "keep", &job, true, false).is_err());
        assert!(keep.join("k.txt").exists());
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 2);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn drop_plan_answers_per_source() {
        let base = scratch("plan");
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        fs::write(base.join("a.txt"), "a").unwrap();
        let plan = drop_plan(
            vec![path_str(&base.join("a.txt")), "/nonexistent/x".into()],
            path_str(&dest),
        );
        assert_eq!(plan, vec![true, false]);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn permanent_delete_removes_trees_and_honours_cancel() {
        let base = scratch("del");
        let tree = base.join("tree");
        fs::create_dir_all(tree.join("sub")).unwrap();
        fs::write(tree.join("sub/f.txt"), "x").unwrap();
        fs::write(base.join("keep.txt"), "k").unwrap();
        let job = jobs::detached();
        remove_tree(&tree, &job).unwrap();
        assert!(!tree.exists());

        let job = jobs::detached();
        job.cancel();
        assert!(remove_tree(&base.join("keep.txt"), &job).is_err());
        assert!(base.join("keep.txt").exists());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn steps_round_trip_through_trash() {
        let base = scratch("steps");
        let file = base.join("note.txt");
        fs::write(&file, "n").unwrap();
        let job = jobs::detached();
        let p = path_str(&file);

        let res = run_steps(&[Step::trash(p.clone())], &job);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert!(!file.exists());
        assert_eq!(res.inverse.len(), 1);

        let back = run_steps(&res.inverse, &job);
        assert!(back.errors.is_empty(), "{:?}", back.errors);
        assert_eq!(fs::read_to_string(&file).unwrap(), "n");
        assert_eq!(back.inverse.len(), 1);

        let renamed = base.join("renamed.txt");
        let res = run_steps(
            &[Step::moved(p.clone(), path_str(&renamed))],
            &job,
        );
        assert!(renamed.exists() && !file.exists());
        let res = run_steps(&res.inverse, &job);
        assert!(file.exists() && !renamed.exists());
        assert!(res.errors.is_empty());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn network_filesystems_are_recognised_and_the_boot_volume_is_local() {
        for t in ["smbfs", "afpfs", "nfs", "webdav"] {
            assert!(is_network_fs(t), "{t}");
        }
        for t in ["apfs", "hfs", "msdos", "exfat", ""] {
            assert!(!is_network_fs(t), "{t}");
        }
        assert!(!is_network_volume("/"), "the boot volume is local");
        assert!(!is_network_volume("/definitely/not/here"));
    }

    #[test]
    fn dir_stamp_changes_when_items_come_and_go_but_not_when_a_file_is_edited() {
        let base = scratch("stamp");
        fs::write(base.join("a.txt"), "1").unwrap();
        let path = path_str(&base);
        let first = dir_stamp(path.clone()).expect("stamp");

        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(base.join("a.txt"), "edited in place").unwrap();
        assert_eq!(dir_stamp(path.clone()).unwrap(), first, "an in-place edit leaves the folder's list alone");

        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(base.join("b.txt"), "new").unwrap();
        let added = dir_stamp(path.clone()).unwrap();
        assert_ne!(added, first, "a new item changes it");

        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::rename(base.join("b.txt"), base.join("c.txt")).unwrap();
        let renamed = dir_stamp(path.clone()).unwrap();
        assert_ne!(renamed, added, "a rename changes it");

        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::remove_file(base.join("c.txt")).unwrap();
        assert_ne!(dir_stamp(path).unwrap(), renamed, "a removal changes it");
        assert!(dir_stamp("/definitely/not/here".into()).is_none());
        fs::remove_dir_all(&base).unwrap();
    }

    fn is_link(p: &Path) -> bool {
        fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
    }

    #[test]
    fn symlinks_are_copied_and_moved_as_links() {
        let base = scratch("links");
        let dest = base.join("dest");
        fs::create_dir_all(base.join("real")).unwrap();
        fs::create_dir_all(&dest).unwrap();
        fs::write(base.join("real/f.txt"), "f").unwrap();
        std::os::unix::fs::symlink("nowhere", base.join("dangling")).unwrap();
        std::os::unix::fs::symlink(base.join("real"), base.join("dirlink")).unwrap();
        let job = jobs::detached();

        let copied = copy_to_unique(&base.join("dangling"), &dest, "dangling", &job).unwrap();
        assert!(is_link(&copied));
        assert_eq!(fs::read_link(&copied).unwrap(), Path::new("nowhere"));
        let again = copy_to_unique(&base.join("dangling"), &dest, "dangling", &job).unwrap();
        assert_eq!(again, dest.join("dangling - Copy"));

        let moved = move_item(&base.join("dirlink"), &dest, "dirlink", &job, true, false).unwrap();
        assert!(moved.leftover.is_none());
        assert!(is_link(&moved.to), "a link to a folder stays a link across volumes");
        assert!(!is_link(&base.join("dirlink")));
        assert_eq!(fs::read_to_string(base.join("real/f.txt")).unwrap(), "f");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn copy_names_split_only_real_extensions() {
        assert_eq!(copy_candidate("a.txt", 1, false), "a - Copy.txt");
        assert_eq!(copy_candidate("a.tar.gz", 2, false), "a - Copy (2).tar.gz");
        assert_eq!(copy_candidate("Project v1.2", 1, false), "Project v1.2 - Copy");
        assert_eq!(copy_candidate("Project v1.2", 1, true), "Project v1.2 - Copy");
        assert_eq!(copy_candidate("notes.final", 1, true), "notes.final - Copy");
        assert_eq!(copy_candidate("Thing.app", 1, false), "Thing - Copy.app");
        assert_eq!(copy_candidate(".zshrc", 1, false), ".zshrc - Copy");
        assert_eq!(copy_candidate("song.mp3", 1, false), "song - Copy.mp3");
        assert_eq!(copy_candidate("a.b c", 1, false), "a.b c - Copy");

        let base = scratch("names");
        let dest = base.join("dest");
        fs::create_dir_all(base.join("Project v1.2/inner")).unwrap();
        fs::create_dir_all(base.join("Thing.app/Contents")).unwrap();
        fs::create_dir_all(&dest).unwrap();
        let job = jobs::detached();
        for _ in 0..2 {
            copy_to_unique(&base.join("Project v1.2"), &dest, "Project v1.2", &job).unwrap();
            copy_to_unique(&base.join("Thing.app"), &dest, "Thing.app", &job).unwrap();
        }
        assert!(dest.join("Project v1.2 - Copy/inner").is_dir());
        assert!(dest.join("Thing - Copy.app/Contents").is_dir());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn into_itself_is_judged_by_the_real_folder() {
        let base = scratch("within");
        fs::create_dir_all(base.join("real/sub")).unwrap();
        std::os::unix::fs::symlink(base.join("real"), base.join("link")).unwrap();
        let real = base.join("real");
        // Into itself, however the destination is spelled.
        assert!(is_within_subtree(&real, &real));
        assert!(is_within_subtree(&real, &base.join("link/sub")));
        assert!(is_within_subtree(&real, Path::new(&path_str(&real.join("SUB")).replace("/real/", "/REAL/"))));
        // A link is moved as the link, so it can go anywhere, even its target.
        assert!(!is_within_subtree(&base.join("link"), &real.join("sub")));
        assert!(!is_within_subtree(&real.join("sub"), &real));
        assert!(!is_within_subtree(&base.join("realx"), &real));

        let job = jobs::detached();
        let res = run_transfer(&[path_str(&base.join("link"))], &path_str(&real.join("sub")), Mode::Move, &Resolutions::new(), &job);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert!(is_link(&real.join("sub/link")));
        let res = run_transfer(&[path_str(&real)], &path_str(&real.join("sub/link/sub")), Mode::Copy, &Resolutions::new(), &job);
        assert_eq!(res.errors.len(), 1, "a folder reached through a link is still inside itself");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn dangling_links_hold_their_names() {
        let base = scratch("dangle");
        let outside = base.join("outside.txt");
        std::os::unix::fs::symlink(&outside, base.join("New Text Document.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, base.join("taken")).unwrap();
        fs::write(base.join("mine"), "m").unwrap();
        let dir = path_str(&base);

        assert!(path_exists(path_str(&base.join("taken"))));
        assert!(rename_path(path_str(&base.join("mine")), path_str(&base.join("taken"))).is_err());
        assert!(is_link(&base.join("taken")));
        let made = create_file(dir.clone()).unwrap();
        assert_eq!(made, path_str(&base.join("New Text Document (2).txt")));
        assert!(!outside.exists(), "nothing written through the link");
        std::os::unix::fs::symlink(&outside, base.join("New folder")).unwrap();
        assert_eq!(create_dir(dir).unwrap(), path_str(&base.join("New folder (2)")));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn permanent_delete_removes_locked_items() {
        let base = scratch("locked");
        fs::create_dir_all(base.join("tree")).unwrap();
        fs::write(base.join("tree/f.txt"), "x").unwrap();
        fs::write(base.join("one.txt"), "1").unwrap();
        let lock = |p: &Path| {
            assert!(std::process::Command::new("/usr/bin/chflags").arg("uchg").arg(p).status().unwrap().success())
        };
        lock(&base.join("tree/f.txt"));
        lock(&base.join("one.txt"));
        let job = jobs::detached();
        let res = delete_permanently_sync(&[path_str(&base.join("tree")), path_str(&base.join("one.txt"))], &job);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert!(!exists(&base.join("tree")) && !exists(&base.join("one.txt")));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_partly_removed_original_keeps_its_only_complete_copy() {
        use std::os::unix::fs::PermissionsExt;
        let base = scratch("partial-move");
        let dest = base.join("dest");
        let src = base.join("tree");
        fs::create_dir_all(src.join("stuck")).unwrap();
        fs::create_dir_all(&dest).unwrap();
        fs::write(src.join("a.txt"), "a").unwrap();
        fs::write(src.join("stuck/b.txt"), "b").unwrap();
        // A locked file stops the folder's removal partway.
        let flags = |flag: &str, p: &Path| {
            assert!(std::process::Command::new("/usr/bin/chflags").args(["-R", flag]).arg(p).status().unwrap().success())
        };
        flags("uchg", &src.join("stuck/b.txt"));
        let job = jobs::detached();
        let mut res = OpResult::default();
        move_one(&path_str(&src), &dest, &job, &mut res, true, &Resolutions::new(), &mut Placed::default());
        flags("nouchg", &base);
        assert_eq!(res.errors.len(), 1, "{:?}", res.errors);
        assert!(res.errors[0].contains("copied, but"), "{:?}", res.errors);
        assert!(res.inverse.is_empty(), "undo must not trash the complete copy: {:?}", res.inverse);
        assert_eq!(fs::read_to_string(dest.join("tree/a.txt")).unwrap(), "a");

        // A file can't be half removed, so undo may still take the copy away.
        let file = base.join("f.txt");
        fs::write(&file, "f").unwrap();
        let ro = base.join("ro");
        fs::create_dir_all(&ro).unwrap();
        let held = ro.join("f.txt");
        fs::rename(&file, &held).unwrap();
        fs::set_permissions(&ro, fs::Permissions::from_mode(0o500)).unwrap();
        let mut res = OpResult::default();
        move_one(&path_str(&held), &dest, &job, &mut res, true, &Resolutions::new(), &mut Placed::default());
        fs::set_permissions(&ro, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(res.errors.len(), 1, "{:?}", res.errors);
        assert_eq!(res.inverse, vec![Step::trash(path_str(&dest.join("f.txt")))]);
        fs::remove_dir_all(&base).unwrap();
    }

    fn resolve(src: &Path, r: Resolution) -> Resolutions {
        [(path_str(src), r)].into_iter().collect()
    }

    #[test]
    fn conflicts_are_found_unless_pasting_in_place() {
        let base = scratch("conf");
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        fs::write(base.join("a.txt"), "new").unwrap();
        fs::write(dest.join("a.txt"), "old").unwrap();
        fs::create_dir_all(base.join("d")).unwrap();
        fs::write(dest.join("d"), "file").unwrap();
        let srcs = vec![path_str(&base.join("a.txt")), path_str(&base.join("d"))];
        let found = find_conflicts(srcs, path_str(&dest));
        assert_eq!(found.len(), 2);
        assert!(found[0].can_replace);
        assert!(!found[1].can_replace);
        assert!(find_conflicts(vec![path_str(&dest.join("a.txt"))], path_str(&dest)).is_empty());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn replace_trashes_the_old_item_and_undo_restores_it() {
        let base = scratch("repl");
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        let src = base.join("a.txt");
        fs::write(&src, "new").unwrap();
        fs::write(dest.join("a.txt"), "old").unwrap();
        let job = jobs::detached();

        let res = run_transfer(
            &[path_str(&src)],
            &path_str(&dest),
            Mode::Copy,
            &resolve(&src, Resolution::Replace),
            &job,
        );
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "new");
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 1, "no scratch or copy left");

        let undone = run_steps(&res.inverse, &job);
        assert!(undone.errors.is_empty(), "{:?}", undone.errors);
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "old");
        assert!(src.exists());

        let redone = run_steps(&undone.inverse, &job);
        assert!(redone.errors.is_empty(), "{:?}", redone.errors);
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "new");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn same_named_sources_replace_once_and_undo_cleanly() {
        let base = scratch("repl2");
        let dest = base.join("dest");
        fs::create_dir_all(base.join("x")).unwrap();
        fs::create_dir_all(base.join("y")).unwrap();
        fs::create_dir_all(&dest).unwrap();
        let (x, y) = (base.join("x/a.txt"), base.join("y/a.txt"));
        fs::write(&x, "x").unwrap();
        fs::write(&y, "y").unwrap();
        fs::write(dest.join("a.txt"), "old").unwrap();
        let job = jobs::detached();
        let both: Resolutions = [(path_str(&x), Resolution::Replace), (path_str(&y), Resolution::Replace)]
            .into_iter()
            .collect();

        let res = run_transfer(&[path_str(&x), path_str(&y)], &path_str(&dest), Mode::Copy, &both, &job);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "x");
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 2, "the second is kept beside the first");

        let undone = run_steps(&res.inverse, &job);
        assert!(undone.errors.is_empty(), "{:?}", undone.errors);
        let left: Vec<_> = fs::read_dir(&dest).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from("a.txt")]);
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "old");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn undo_spares_an_item_that_took_the_copys_place() {
        let base = scratch("ident");
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        let src = base.join("a.txt");
        fs::write(&src, "mine").unwrap();
        let job = jobs::detached();

        let res = run_transfer(&[path_str(&src)], &path_str(&dest), Mode::Copy, &Resolutions::new(), &job);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        fs::remove_file(dest.join("a.txt")).unwrap();
        fs::write(dest.join("a.txt"), "someone else's").unwrap();

        let undone = run_steps(&res.inverse, &job);
        assert_eq!(undone.errors.len(), 1, "{:?}", undone.errors);
        assert!(undone.inverse.is_empty());
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "someone else's");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn move_replace_skip_and_keep_both() {
        let base = scratch("movr");
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        let job = jobs::detached();
        let d = path_str(&dest);

        let a = base.join("a.txt");
        fs::write(&a, "A").unwrap();
        fs::write(dest.join("a.txt"), "old").unwrap();
        let res = run_transfer(&[path_str(&a)], &d, Mode::Move, &resolve(&a, Resolution::Replace), &job);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert!(!a.exists());
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "A");
        let undone = run_steps(&res.inverse, &job);
        assert!(undone.errors.is_empty(), "{:?}", undone.errors);
        assert_eq!(fs::read_to_string(&a).unwrap(), "A");
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "old");

        let res = run_transfer(&[path_str(&a)], &d, Mode::Move, &resolve(&a, Resolution::Skip), &job);
        assert!(res.errors.is_empty() && res.inverse.is_empty());
        assert!(a.exists());
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "old");

        let res = run_transfer(&[path_str(&a)], &d, Mode::Copy, &Resolutions::new(), &job);
        assert!(res.errors.is_empty());
        assert_eq!(fs::read_to_string(dest.join("a - Copy.txt")).unwrap(), "A");
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "old");
        fs::remove_dir_all(&base).unwrap();
    }
}
