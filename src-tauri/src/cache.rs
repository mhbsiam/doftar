//! Housekeeping for everything Doftar caches on disk, so the cache can't
//! quietly grow: a background pass trims it now and then, and the interface
//! can show its size and clear it.

use serde::Serialize;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::thumbs::{cache_root, prune, session_root};

/// First pass waits, so it never competes with startup.
const FIRST_PASS_DELAY: Duration = Duration::from_secs(30);
const PASS_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// How soon a drive's previews go after it is ejected or unplugged.
const UNMOUNT_CHECK_EVERY: Duration = Duration::from_secs(10);

/// Trims each cache folder: drops old entries, then the least recently used
/// until it is back under its size limit.
fn sweep() {
    let Some(root) = cache_root() else { return };
    let Ok(rd) = fs::read_dir(&root) else { return };
    for e in rd.flatten() {
        if e.metadata().is_ok_and(|m| m.is_dir()) {
            prune(&e.path());
        }
    }
}

/// Devices of every mounted volume: the startup disk, those under /Volumes,
/// and any mounted elsewhere (a share or disk image mounted into a folder).
fn mounted_devices() -> Vec<u64> {
    let mut paths = vec![PathBuf::from("/")];
    if let Ok(rd) = fs::read_dir("/Volumes") {
        paths.extend(rd.flatten().map(|e| e.path()));
    }
    paths.extend(mount_points());
    paths
        .iter()
        .filter_map(|p| fs::metadata(p).ok())
        .map(|m| m.dev())
        .collect()
}

/// Where each mounted file system is mounted, as the kernel lists them.
#[cfg(target_os = "macos")]
fn mount_points() -> Vec<PathBuf> {
    use std::ffi::{CStr, OsStr};
    use std::os::unix::ffi::OsStrExt;
    let n = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
    if n <= 0 {
        return Vec::new();
    }
    // Room for a few mounted in between the two calls.
    let mut buf: Vec<libc::statfs> = Vec::with_capacity(n as usize + 8);
    let bytes = (buf.capacity() * std::mem::size_of::<libc::statfs>()) as libc::c_int;
    let got = unsafe { libc::getfsstat(buf.as_mut_ptr(), bytes, libc::MNT_NOWAIT) };
    if got <= 0 {
        return Vec::new();
    }
    // SAFETY: getfsstat filled the first `got` entries.
    unsafe { buf.set_len((got as usize).min(buf.capacity())) };
    buf.iter()
        .map(|s| {
            let name = unsafe { CStr::from_ptr(s.f_mntonname.as_ptr()) };
            PathBuf::from(OsStr::from_bytes(name.to_bytes()))
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn mount_points() -> Vec<PathBuf> {
    Vec::new()
}

/// Deletes the per-volume preview folders in `root` whose volume isn't
/// mounted any more.
fn drop_unmounted_in(root: &Path, mounted: &[u64]) {
    let Ok(rd) = fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let dev = e.file_name().to_string_lossy().parse::<u64>().ok();
        if !dev.is_some_and(|d| mounted.contains(&d)) {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

/// Makes `dir` (creating it) readable by its owner only, and keeps it out of
/// Time Machine: the cache holds small copies of the user's pictures and
/// documents, and the store lists what they opened.
pub fn make_private(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::create_dir_all(dir);
    let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
}

/// Marks `dir` so Time Machine skips it (the same mark `tmutil addexclusion`
/// sets on a folder).
pub fn exclude_from_backup(dir: &Path) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let (Ok(p), Ok(name)) = (
        CString::new(dir.as_os_str().as_bytes()),
        CString::new("com.apple.metadata:com_apple_backup_excludeItem"),
    ) else {
        return;
    };
    let value = b"com.apple.backupd";
    unsafe {
        libc::setxattr(
            p.as_ptr(),
            name.as_ptr(),
            value.as_ptr() as *const libc::c_void,
            value.len(),
            0,
            0,
        );
    }
}

/// Creates the cache folders with private permissions and keeps them out of
/// backups. Runs at launch, before any thumbnail is made.
pub fn secure_dirs() {
    if let Some(root) = cache_root() {
        make_private(&root);
        exclude_from_backup(&root);
        for sub in ["thumbs", "viewer"] {
            make_private(&root.join(sub));
        }
    }
    if let Some(session) = session_root() {
        make_private(&session);
    }
}

/// Deletes the previews of drives that have been ejected or unplugged.
pub fn drop_unmounted_previews() {
    if let Some(root) = session_root() {
        drop_unmounted_in(&root, &mounted_devices());
    }
}

/// Deletes every drive's previews: at quit, and at launch for any a crash
/// left behind.
pub fn drop_session_previews() {
    if let Some(root) = session_root() {
        let _ = fs::remove_dir_all(root);
    }
}

/// Starts the periodic trim: shortly after launch, then every few hours while
/// the app stays open. Separately, drops the previews of drives as soon as
/// they are gone.
pub fn start_janitor() {
    std::thread::spawn(|| {
        std::thread::sleep(FIRST_PASS_DELAY);
        loop {
            sweep();
            std::thread::sleep(PASS_EVERY);
        }
    });
    std::thread::spawn(|| loop {
        std::thread::sleep(UNMOUNT_CHECK_EVERY);
        drop_unmounted_previews();
    });
}

#[derive(Serialize, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub bytes: u64,
    pub files: u64,
}

fn measure(dir: &Path, info: &mut CacheInfo) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let Ok(m) = e.metadata() else { continue };
        if m.is_dir() {
            measure(&e.path(), info);
        } else {
            info.bytes += m.len();
            info.files += 1;
        }
    }
}

fn clear_dir(dir: &Path) -> CacheInfo {
    let mut freed = CacheInfo::default();
    let Ok(rd) = fs::read_dir(dir) else { return freed };
    for e in rd.flatten() {
        let path = e.path();
        let Ok(meta) = e.metadata() else { continue };
        let mut part = CacheInfo::default();
        let removed = if meta.is_dir() {
            measure(&path, &mut part);
            // Scratch dirs of in-flight work may vanish under it; that is fine.
            fs::remove_dir_all(&path).is_ok()
        } else {
            part = CacheInfo { bytes: meta.len(), files: 1 };
            fs::remove_file(&path).is_ok()
        };
        if removed {
            freed.bytes += part.bytes;
            freed.files += part.files;
        }
    }
    freed
}

#[tauri::command(async)]
pub fn cache_info() -> CacheInfo {
    let mut info = CacheInfo::default();
    if let Some(root) = cache_root() {
        measure(&root, &mut info);
    }
    info
}

/// Deletes every cached file and returns how much was freed.
#[tauri::command(async)]
pub fn clear_cache() -> CacheInfo {
    cache_root().map(|r| clear_dir(&r)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_previews_of_unmounted_volumes_only() {
        let base = std::env::temp_dir().join(format!("wf-session-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        for dir in ["11/thumbs", "22/viewer", "stray"] {
            fs::create_dir_all(base.join(dir)).unwrap();
        }
        fs::write(base.join("11/thumbs/a.jpg"), b"x").unwrap();
        drop_unmounted_in(&base, &[11]);
        assert!(base.join("11/thumbs/a.jpg").exists());
        assert!(!base.join("22").exists());
        assert!(!base.join("stray").exists());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_startup_disk_counts_as_mounted() {
        assert!(mounted_devices().contains(&fs::metadata("/").unwrap().dev()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn volumes_mounted_outside_volumes_count_as_mounted() {
        // /dev is its own file system, mounted outside /Volumes.
        assert!(mount_points().iter().any(|p| p == Path::new("/dev")));
        assert!(mounted_devices().contains(&fs::metadata("/dev").unwrap().dev()));
    }

    #[test]
    fn measures_and_clears_nested_files() {
        let base = std::env::temp_dir().join(format!("wf-cache-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("thumbs/x.d")).unwrap();
        fs::write(base.join("thumbs/a.png"), vec![0u8; 100]).unwrap();
        fs::write(base.join("thumbs/x.d/b.png"), vec![0u8; 50]).unwrap();
        fs::write(base.join("loose"), vec![0u8; 7]).unwrap();

        let mut info = CacheInfo::default();
        measure(&base, &mut info);
        assert_eq!(info, CacheInfo { bytes: 157, files: 3 });

        let freed = clear_dir(&base);
        assert_eq!(freed, CacheInfo { bytes: 157, files: 3 });
        let mut after = CacheInfo::default();
        measure(&base, &mut after);
        assert_eq!(after, CacheInfo::default());
        fs::remove_dir_all(&base).unwrap();
    }
}
