#[cfg(not(target_os = "macos"))]
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "macos")]
pub(crate) fn user_trash() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".Trash"))
        .ok_or_else(|| "can't find the home folder".to_string())
}

/// freedesktop trash: $XDG_DATA_HOME/Trash/files, defaulting to ~/.local/share.
#[cfg(not(target_os = "macos"))]
pub(crate) fn user_trash() -> Result<PathBuf, String> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".local/share")))
        .ok_or_else(|| "can't find the home folder".to_string())?;
    Ok(base.join("Trash/files"))
}

#[cfg(target_os = "macos")]
pub(crate) fn volume_roots() -> Vec<PathBuf> {
    fs::read_dir("/Volumes")
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|v| fs::read_link(v).is_err())
                .collect()
        })
        .unwrap_or_default()
}

/// Mount points that can hold a per-user .Trash-$uid folder.
/// Ubuntu mounts at /media/<user>/<vol> and /run/media/<user>/<vol>; /mnt is flat.
#[cfg(not(target_os = "macos"))]
pub(crate) fn volume_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for base in ["/media", "/run/media"] {
        if let Ok(rd) = fs::read_dir(base) {
            for u in rd.flatten() {
                if let Ok(rd2) = fs::read_dir(u.path()) {
                    roots.extend(rd2.flatten().map(|e| e.path()));
                }
            }
        }
    }
    if let Ok(rd) = fs::read_dir("/mnt") {
        roots.extend(rd.flatten().map(|e| e.path()));
    }
    roots
}

fn all_trashes() -> Result<Vec<PathBuf>, String> {
    let mut dirs = vec![user_trash()?];
    let uid = unsafe { libc::getuid() };
    for vol in volume_roots() {
        #[cfg(target_os = "macos")]
        let t = vol.join(".Trashes").join(uid.to_string());
        #[cfg(not(target_os = "macos"))]
        let t = vol.join(format!(".Trash-{uid}/files"));
        if t.is_dir() {
            dirs.push(t);
        }
    }
    Ok(dirs)
}

#[tauri::command(async)]
pub fn trash_dirs() -> Result<Vec<String>, String> {
    Ok(all_trashes()?
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}

fn remove_item(p: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(p)?.is_dir() {
        fs::remove_dir_all(p)
    } else {
        fs::remove_file(p)
    }
}

fn remove_locked(p: &Path) -> std::io::Result<()> {
    retry_unlocked(p, || remove_item(p))
}

/// Run `remove`, which deletes `p`. If something inside is locked (the macOS
/// user-immutable flag), clear the flag on `p` and all inside, then run `remove` again.
/// `chflags -R` does not follow symlinks, so a link target keeps its flag.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub(crate) fn retry_unlocked(
    p: &Path,
    mut remove: impl FnMut() -> std::io::Result<()>,
) -> std::io::Result<()> {
    match remove() {
        Err(first) if first.raw_os_error() == Some(libc::EPERM) => {
            #[cfg(target_os = "macos")]
            {
                let cleared = Command::new("/usr/bin/chflags")
                    .args(["-R", "nouchg"])
                    .arg(p)
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if cleared {
                    return remove();
                }
            }
            Err(first)
        }
        other => other,
    }
}

/// The freedesktop `info/` sibling of a trash's `files/` dir. macOS has no info dir —
/// `~/.Trash`'s parent's `info` would be a user folder — so there is none there.
#[cfg(not(target_os = "macos"))]
fn info_dir_of(trash: &Path) -> Option<PathBuf> {
    trash.parent().map(|root| root.join("info"))
}

#[cfg(target_os = "macos")]
fn info_dir_of(_trash: &Path) -> Option<PathBuf> {
    None
}

/// True if the file was written in the last few seconds. Trashing writes the record
/// before moving the item in, so a just-written record's item may simply not have
/// arrived yet — it is not an orphan.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn record_is_fresh(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|d| d < std::time::Duration::from_secs(2))
}

fn empty_dir(trash: &Path) -> Result<usize, String> {
    let info_dir = info_dir_of(trash);
    let rd = fs::read_dir(trash).map_err(|e| e.to_string())?;
    let mut removed = 0;
    let mut failures = Vec::new();
    for item in rd.flatten() {
        if item.file_name() == ".DS_Store" {
            continue;
        }
        let p = item.path();
        match remove_locked(&p) {
            Ok(()) => {
                removed += 1;
                if let Some(info) = info_dir.as_ref() {
                    let mut rec = item.file_name().to_os_string();
                    rec.push(".trashinfo");
                    // Best effort: a missing record is fine once the item is gone.
                    let _ = fs::remove_file(info.join(rec));
                }
            }
            Err(e) => failures.push(format!("\"{}\": {e}", item.file_name().to_string_lossy())),
        }
    }
    // Records whose item is already gone (a crash, a manual rm) would pile up forever,
    // and find_trashed rescans them on every trash and undo. A record written moments
    // ago belongs to an item still being moved in — leave it alone.
    if let Some(info) = info_dir.as_ref() {
        if let Ok(rd) = fs::read_dir(info) {
            use std::os::unix::ffi::OsStrExt;
            for item in rd.flatten() {
                let name = item.file_name();
                let Some(stem) = name.as_bytes().strip_suffix(b".trashinfo") else {
                    continue;
                };
                if trash.join(std::ffi::OsStr::from_bytes(stem)).exists() {
                    continue;
                }
                if record_is_fresh(&item.path()) {
                    continue;
                }
                let _ = fs::remove_file(item.path());
            }
        }
    }
    if failures.is_empty() {
        Ok(removed)
    } else {
        let more = failures.len().saturating_sub(3);
        let mut msg = failures.into_iter().take(3).collect::<Vec<_>>().join("; ");
        if more > 0 {
            msg.push_str(&format!("; and {more} more"));
        }
        Err(format!("Couldn't empty the Trash completely: {msg}"))
    }
}

#[tauri::command]
pub async fn empty_trash() -> Result<usize, String> {
    crate::jobs::blocking(empty_trash_sync).await?
}

fn empty_trash_sync() -> Result<usize, String> {
    let mut removed = 0;
    let mut errors = Vec::new();
    for dir in all_trashes()? {
        match empty_dir(&dir) {
            Ok(n) => removed += n,
            Err(e) => errors.push(e),
        }
    }
    if errors.is_empty() {
        Ok(removed)
    } else {
        Err(errors.join("; "))
    }
}

#[tauri::command(async)]
pub fn ensure_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

fn ejectable_volume(path: &str) -> Result<(), String> {
    let p = crate::paths::real(path);
    use std::path::Component;
    // Only what `volumes()` offers an eject button for: /Volumes on macOS, udisks2/GIO
    // mounts under /media and /run/media on Linux (fsops/list.rs).
    let under_root = if cfg!(target_os = "macos") {
        p.starts_with("/Volumes") && p != crate::paths::real("/Volumes")
    } else {
        (p.starts_with("/media") || p.starts_with("/run/media"))
            && p != Path::new("/media")
            && p != Path::new("/run/media")
    };
    if !under_root || p.components().any(|c| c == Component::ParentDir) {
        return Err("Only external volumes can be ejected".to_string());
    }
    Ok(())
}

#[tauri::command(async)]
pub fn eject_volume(
    state: tauri::State<'_, crate::watcher::WatcherState>,
    path: String,
) -> Result<(), String> {
    ejectable_volume(&path)?;
    let trimmed = path.trim_end_matches('/');
    crate::watcher::begin_eject(trimmed);
    crate::watcher::release_under(&state, trimmed);
    // An open Quick Look preview of a file on the volume keeps it busy. macOS only;
    // Linux has no Quick Look panel (see LINUX.md).
    #[cfg(target_os = "macos")]
    crate::quicklook::quicklook_close();
    // The system tools want the on-disk bytes; decode the bridge string once.
    let os_path = crate::paths::real(trimmed);
    let mut result = eject(&os_path);
    for _ in 0..3 {
        match &result {
            Err(e) if is_busy(e) => {
                std::thread::sleep(std::time::Duration::from_millis(350));
                result = eject(&os_path);
            }
            _ => break,
        }
    }
    if let Err(e) = &result {
        eprintln!("eject {trimmed}: {e}\n{}", own_open_files(trimmed));
    }
    crate::watcher::end_eject(trimmed);
    if result.is_ok() {
        crate::cache::drop_unmounted_previews();
    } else if !crate::watcher::is_ejecting(trimmed) {
        crate::watcher::rewatch_under(&state, trimmed);
    }
    result.map_err(|e| {
        if is_busy(&e) {
            format!("{e} Another app may still be using the disk, or a copy to it is still running.")
        } else {
            e
        }
    })
}

fn is_busy(msg: &str) -> bool {
    msg.contains("-47") || msg.contains("dissented") || msg.contains("busy")
}

fn own_open_files(prefix: &str) -> String {
    Command::new("/usr/sbin/lsof")
        .args(["-n", "-p", &std::process::id().to_string()])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| l.contains(prefix))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn eject(path: &Path) -> Result<(), String> {
    // A network share has no disk for `eject` to find.
    let p = path.to_string_lossy();
    let verb = if crate::fsops::is_network_volume(&p) { "unmount" } else { "eject" };
    let out = Command::new("/usr/sbin/diskutil")
        .args([verb, p.as_ref()])
        .output()
        .map_err(|e| format!("couldn't run diskutil: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let msg = if err.is_empty() {
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        err
    };
    Err(if msg.is_empty() { "diskutil eject failed".to_string() } else { msg })
}

/// `gio mount -u` unmounts udisks2/GIO mounts (USB sticks under /media, /run/media).
/// `umount` covers the rest when the user may unmount it.
#[cfg(not(target_os = "macos"))]
fn eject(path: &Path) -> Result<(), String> {
    let mut last = String::new();
    for (prog, args) in [
        (
            "gio",
            vec![
                OsString::from("mount"),
                OsString::from("-u"),
                path.as_os_str().to_owned(),
            ],
        ),
        ("umount", vec![path.as_os_str().to_owned()]),
    ] {
        let mut cmd = Command::new(prog);
        cmd.args(&args);
        // A genuinely stuck unmount must not park the eject forever — but a USB stick
        // flushing a large write cache can honestly take a minute, and a killed umount
        // empties stderr, so the busy retry in `eject_volume` would never see the real
        // reason. The timeout is for a hung NFS/SMB unmount, not for a slow drive.
        match crate::proc::run(&mut cmd, std::time::Duration::from_secs(60)) {
            Ok(out) if out.status.success() => return Ok(()),
            Ok(out) => {
                let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                last = if err.is_empty() {
                    String::from_utf8_lossy(&out.stdout).trim().to_string()
                } else {
                    err
                };
            }
            Err(_) => continue,
        }
    }
    Err(if last.is_empty() {
        format!("couldn't unmount {}", path.display())
    } else {
        last
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_volume_paths_can_be_ejected() {
        #[cfg(target_os = "macos")]
        {
            assert!(ejectable_volume("/Volumes/USB").is_ok());
            assert!(ejectable_volume("/Volumes").is_err());
        }
        #[cfg(not(target_os = "macos"))]
        {
            assert!(ejectable_volume("/media/user/USB").is_ok());
            assert!(ejectable_volume("/run/media/user/My Disk").is_ok());
            assert!(ejectable_volume("/media").is_err());
            assert!(ejectable_volume("/run/media").is_err());
            assert!(ejectable_volume("/mnt/usb").is_err());
        }
        assert!(ejectable_volume("/media/../etc").is_err());
        assert!(ejectable_volume("/tmp").is_err());
    }

    #[test]
    fn empty_dir_removes_items_but_keeps_ds_store() {
        let base = std::env::temp_dir().join(format!("wf-trash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("folder/inner")).unwrap();
        fs::write(base.join("folder/inner/f.txt"), "x").unwrap();
        fs::write(base.join("a.txt"), "a").unwrap();
        fs::write(base.join(".DS_Store"), "meta").unwrap();
        std::os::unix::fs::symlink("/", base.join("link")).unwrap();
        assert_eq!(empty_dir(&base).unwrap(), 3);
        let left: Vec<_> = fs::read_dir(&base).unwrap().flatten().collect();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].file_name(), ".DS_Store");
        assert!(crate::paths::real("/").exists(), "symlink target untouched");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn eject_refuses_non_volumes() {
        assert!(ejectable_volume("/").is_err());
        #[cfg(target_os = "macos")]
        assert!(ejectable_volume("/Volumes").is_err());
        assert!(ejectable_volume("/Users/someone").is_err());
        assert!(ejectable_volume("/etc/passwd").is_err());
    }

    /// Emptying the Trash takes the .trashinfo records with the items, including the
    /// ones orphaned before by a crash or a manual rm.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn emptying_leaves_no_trashinfo_behind() {
        let base = std::env::temp_dir().join(format!("wf-trash-info-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        // A freedesktop trash: files/ and info/ siblings.
        let files = base.join("files");
        let info = base.join("info");
        fs::create_dir_all(&files).unwrap();
        fs::create_dir_all(&info).unwrap();
        fs::write(files.join("a.txt"), "x").unwrap();
        fs::write(info.join("a.txt.trashinfo"), "[Trash Info]\nPath=/home/a.txt\n").unwrap();
        fs::write(info.join("gone.bin.trashinfo"), "[Trash Info]\n").unwrap();
        // Aged past the freshness window, so the sweep treats it as a real orphan.
        backdate(&info.join("gone.bin.trashinfo"));
        let removed = empty_dir(&files).unwrap();
        assert_eq!(removed, 1);
        assert!(!files.join("a.txt").exists());
        assert!(info.read_dir().unwrap().next().is_none(), "info/ must come out empty");
        fs::remove_dir_all(&base).unwrap();
    }

    /// Sets a file's times to the epoch, well past the orphan sweep's freshness window.
    #[cfg(not(target_os = "macos"))]
    fn backdate(path: &Path) {
        use std::os::unix::ffi::OsStrExt;
        let old = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        let times = [old, old];
        let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return };
        // SAFETY: `c` is a NUL-terminated C string.
        unsafe { libc::utimensat(libc::AT_FDCWD, c.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
    }

    /// Trashing writes the record before moving the item in, so a record written
    /// moments ago belongs to an item still on its way — the sweep must spare it.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn emptying_spares_a_fresh_record() {
        let base = std::env::temp_dir().join(format!("wf-trash-fresh-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let files = base.join("files");
        let info = base.join("info");
        fs::create_dir_all(&files).unwrap();
        fs::create_dir_all(&info).unwrap();
        fs::write(info.join("arriving.txt.trashinfo"), "[Trash Info]\nPath=/home/arriving.txt\n").unwrap();
        empty_dir(&files).unwrap();
        assert!(info.join("arriving.txt.trashinfo").exists(), "a fresh record is not an orphan");
        fs::remove_dir_all(&base).unwrap();
    }
}
