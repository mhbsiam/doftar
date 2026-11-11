use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn user_trash() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".Trash"))
        .ok_or_else(|| "can't find the home folder".to_string())
}

fn all_trashes() -> Result<Vec<PathBuf>, String> {
    let mut dirs = vec![user_trash()?];
    let uid = unsafe { libc::getuid() };
    if let Ok(rd) = fs::read_dir("/Volumes") {
        for item in rd.flatten() {
            let vol = item.path();
            if fs::read_link(&vol).is_ok() {
                continue;
            }
            let t = vol.join(".Trashes").join(uid.to_string());
            if t.is_dir() {
                dirs.push(t);
            }
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

/// Run `remove`, which deletes `p`. If something inside is locked (user-immutable flag), clear the flag on `p` and all inside, then run `remove` again.
/// `chflags -R` does not follow symlinks, so a link target keeps its flag.
pub(crate) fn retry_unlocked(
    p: &Path,
    mut remove: impl FnMut() -> std::io::Result<()>,
) -> std::io::Result<()> {
    match remove() {
        Err(first) if first.raw_os_error() == Some(libc::EPERM) => {
            let cleared = Command::new("/usr/bin/chflags")
                .args(["-R", "nouchg"])
                .arg(p)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if cleared {
                remove()
            } else {
                Err(first)
            }
        }
        other => other,
    }
}

fn empty_dir(trash: &Path) -> Result<usize, String> {
    let rd = fs::read_dir(trash).map_err(|e| e.to_string())?;
    let mut removed = 0;
    let mut failures = Vec::new();
    for item in rd.flatten() {
        if item.file_name() == ".DS_Store" {
            continue;
        }
        let p = item.path();
        match remove_locked(&p) {
            Ok(()) => removed += 1,
            Err(e) => failures.push(format!("\"{}\": {e}", item.file_name().to_string_lossy())),
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
    let p = Path::new(path);
    use std::path::Component;
    if !p.starts_with("/Volumes")
        || p == Path::new("/Volumes")
        || p.components().any(|c| c == Component::ParentDir)
    {
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
    // An open Quick Look preview of a file on the volume keeps it busy.
    crate::quicklook::quicklook_close();
    let mut result = eject(trimmed);
    for _ in 0..3 {
        match &result {
            Err(e) if is_busy(e) => {
                std::thread::sleep(std::time::Duration::from_millis(350));
                result = eject(trimmed);
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
fn eject(path: &str) -> Result<(), String> {
    // A network share has no disk for `eject` to find.
    let verb = if crate::fsops::is_network_volume(path) { "unmount" } else { "eject" };
    let out = Command::new("/usr/sbin/diskutil")
        .args([verb, path])
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

#[cfg(not(target_os = "macos"))]
fn eject(_path: &str) -> Result<(), String> {
    Err("Eject is only supported on macOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_volume_paths_can_be_ejected() {
        assert!(ejectable_volume("/Volumes/USB").is_ok());
        assert!(ejectable_volume("/Volumes").is_err());
        assert!(ejectable_volume("/Volumes/../tmp").is_err());
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
        assert!(Path::new("/").exists(), "symlink target untouched");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn eject_refuses_non_volumes() {
        assert!(ejectable_volume("/").is_err());
        assert!(ejectable_volume("/Volumes").is_err());
        assert!(ejectable_volume("/Users/someone").is_err());
    }
}
