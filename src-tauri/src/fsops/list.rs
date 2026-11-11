//! Folder listings, volumes and the small stat commands.

use crate::lock::Locked;
use super::*;

/// A small first batch shows the top of a big folder at once. Larger batches limit re-sorts.
pub(super) const STREAM_BATCHES: [usize; 4] = [400, 2_000, 8_000, 32_000];

/// Ids of streams the interface abandoned.
pub(super) static CANCELLED_STREAMS: std::sync::Mutex<Vec<u64>> = std::sync::Mutex::new(Vec::new());

pub(super) fn stream_cancelled(id: u64) -> bool {
    CANCELLED_STREAMS.locked().contains(&id)
}

#[tauri::command(async)]
pub fn cancel_list_stream(stream_id: u64) {
    let mut list = CANCELLED_STREAMS.locked();
    if list.len() > 256 {
        list.drain(..128); // Ids only grow. The oldest streams are finished.
    }
    list.push(stream_id);
}

/// Sends the sorted entries through `on_batch` in growing chunks. Returns the total count.
/// Stops when the stream is cancelled.
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
                break;
            }
        }
        Ok(total)
    })
    .await?
}

/// Returns `None` when the folder holds more than `max_entries`. Hover prefetch uses it.
#[tauri::command]
pub async fn list_dir_capped(
    path: String,
    show_hidden: bool,
    max_entries: usize,
) -> Result<Option<Vec<FileEntry>>, String> {
    jobs::blocking(move || {
        // Count names up to max_entries + 1. A huge folder is rejected before a full list and sort.
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

/// macOS asks for folder access only once. This resets the answer for the area holding `path`.
/// It then reads `path` again and waits for the prompt. Returns true when allowed.
#[tauri::command]
pub async fn request_folder_access(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    let home = std::env::var("HOME").map_err(strerr)?;
    let under = |root: &str| path == root || path.starts_with(&format!("{root}/"));
    let services: &[&str] = if under(&format!("{home}/Desktop")) {
        &["SystemPolicyDesktopFolder"]
    } else if under(&format!("{home}/Documents")) {
        &["SystemPolicyDocumentsFolder"]
    } else if under(&format!("{home}/Downloads")) {
        &["SystemPolicyDownloadsFolder"]
    } else if under("/Volumes") {
        &["SystemPolicyRemovableVolumes", "SystemPolicyNetworkVolumes"]
    } else {
        return Ok(false);
    };
    let id = app.config().identifier.clone();
    jobs::blocking(move || {
        for s in services {
            let _ = std::process::Command::new("/usr/bin/tccutil").args(["reset", s, &id]).status();
        }
        fs::read_dir(&path).is_ok()
    })
    .await
}

#[tauri::command]
pub async fn list_dir(path: String, show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    jobs::blocking(move || list_dir_sync(&path, show_hidden)).await?
}

pub(crate) fn list_dir_sync(path: &str, show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    let dir = Path::new(path);
    // `None` means use the per-entry path. That path also gives the error for unreadable folders.
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
    is_network: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    home: String,
    boot_volume_name: String,
    volumes: Vec<VolumeInfo>,
}

pub(super) fn is_network_fs(fs_type: &str) -> bool {
    matches!(fs_type, "smbfs" | "afpfs" | "nfs" | "webdav" | "cifs" | "ftp")
}

pub(crate) fn is_network_volume(path: &str) -> bool {
    let Ok(c) = std::ffi::CString::new(path) else { return false };
    let mut st: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is NUL-terminated and `st` is zeroed.
    if unsafe { libc::statfs(c.as_ptr(), &mut st) } != 0 {
        return false;
    }
    let ty: Vec<u8> = st.f_fstypename.iter().take_while(|&&b| b != 0).map(|&b| b as u8).collect();
    is_network_fs(&String::from_utf8_lossy(&ty)) || st.f_flags & (libc::MNT_LOCAL as u32) == 0
}

pub(super) fn push_volume(v: &mut Vec<VolumeInfo>, path: &str, name: &str, ejectable: bool) {
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

pub(super) const SYSTEM_VOLUME_NAMES: [&str; 4] = ["Recovery", "Preboot", "VM", "Update"];

/// Bytes free on the volume that holds `path`.
#[tauri::command(async)]
pub fn free_space(path: String) -> Option<u64> {
    fs2::available_space(&path).ok()
}

#[tauri::command(async)]
pub fn system_info() -> SystemInfo {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let root_dev = fs::metadata("/").map(|m| m.dev()).unwrap_or(0);
    let mut root_name = "Macintosh HD".to_string();
    let mut volumes = Vec::new();
    if let Ok(rd) = fs::read_dir("/Volumes") {
        for item in rd.flatten() {
            let p = item.path();
            let is_boot = fs::read_link(&p).is_ok_and(|t| t == Path::new("/"))
                || fs::metadata(&p).is_ok_and(|m| m.dev() == root_dev);
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
    // Do not follow symlinks. A dangling link is still an item.
    exists(Path::new(&path))
}

#[tauri::command(async)]
pub fn is_folder(path: String) -> bool {
    fs::metadata(&path).is_ok_and(|m| m.is_dir())
}

/// Returns the folder modification time. It changes when an item is added, removed or renamed.
#[tauri::command(async)]
pub fn dir_stamp(path: String) -> Option<String> {
    let modified = fs::metadata(&path).ok()?.modified().ok()?;
    let d = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(format!("{}.{:09}", d.as_secs(), d.subsec_nanos()))
}

/// Returns `None` for a path that cannot be read.
#[tauri::command(async)]
pub fn file_ids(paths: Vec<String>) -> Vec<Option<String>> {
    paths
        .iter()
        .map(|p| fs::metadata(p).ok().map(|m| file_id_of(&m)))
        .collect()
}

/// Ids of the items themselves, not of link targets. Undo steps record them.
#[tauri::command(async)]
pub fn item_ids(paths: Vec<String>) -> Vec<Option<String>> {
    paths.iter().map(|p| jobs::file_id(Path::new(p))).collect()
}

/// See `jobs::revision`. The editor sends it back with its save.
#[tauri::command(async)]
pub fn file_revision(path: String) -> Option<String> {
    fs::metadata(&path).ok().map(|m| jobs::revision(&m))
}

