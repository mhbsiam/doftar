use crate::lock::Locked;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

static STORE_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn set_path(p: PathBuf) {
    // A store from an older build may be world-readable. Fix it now, not at the next save.
    if p.exists() {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
    }
    *STORE_PATH.locked() = Some(p);
}

/// `None` if there is no store yet. Any other read failure is an error, so an existing store is never taken for missing.
#[tauri::command(async)]
pub fn load_store() -> Result<Option<String>, String> {
    let Some(p) = STORE_PATH.locked().clone() else {
        return Ok(None);
    };
    match fs::read_to_string(p) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Move an unreadable store to "store.unreadable-<time>.json" beside it. This keeps it for recovery and lets saves go on without overwriting it.
#[tauri::command(async)]
pub fn set_aside_store() -> Result<(), String> {
    let p = STORE_PATH
        .locked()
        .clone()
        .ok_or_else(|| "store path not initialized".to_string())?;
    set_aside(&p)
}

fn set_aside(p: &Path) -> Result<(), String> {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    fs::rename(p, p.with_file_name(format!("store.unreadable-{secs}.json"))).map_err(|e| e.to_string())
}

/// Saves run on worker threads and finish in any order. Windows save their own copies.
/// Run one save at a time. Drop a snapshot older than the last one written (`taken_at`: milliseconds on a clock all windows share), because it is stale.
static SAVE_TICKET: AtomicU64 = AtomicU64::new(0);
static SAVED_AT: Mutex<f64> = Mutex::new(f64::MIN);

#[tauri::command(async)]
pub fn save_store(content: String, taken_at: f64) -> Result<(), String> {
    let p = STORE_PATH
        .locked()
        .clone()
        .ok_or_else(|| "store path not initialized".to_string())?;
    save_in_order(&p, taken_at, &content)
}

fn save_in_order(p: &Path, taken_at: f64, content: &str) -> Result<(), String> {
    let mut saved = SAVED_AT.locked();
    if taken_at < *saved {
        return Ok(());
    }
    // Unique name, so a second app instance cannot write into this temp file.
    let ticket = SAVE_TICKET.fetch_add(1, Ordering::Relaxed);
    let tmp = p.with_extension(format!("json.{}-{ticket}.tmp", std::process::id()));
    if let Err(e) = write_private(&tmp, content.as_bytes()).and_then(|_| fs::rename(&tmp, p)) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    *saved = taken_at;
    Ok(())
}

/// Write `bytes` to a new file that only the owner can read (mode 0600). The store lists what the user opened and pinned.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_older_save_cannot_overwrite_a_newer_one() {
        let dir = std::env::temp_dir().join(format!("doftar-store-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("store.json");
        // Use times far above any real save in this process.
        save_in_order(&p, 1e15 + 2.0, "new").unwrap();
        save_in_order(&p, 1e15 + 1.0, "old").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "new");
        save_in_order(&p, 1e15 + 3.0, "newer").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "newer");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_store_is_kept_beside_it() {
        let dir = std::env::temp_dir().join(format!("doftar-store-aside-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("store.json");
        fs::write(&p, "{not json").unwrap();
        set_aside(&p).unwrap();
        assert!(!p.exists());
        let kept: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(fs::read_to_string(&kept[0]).unwrap(), "{not json");
        let _ = fs::remove_dir_all(&dir);
    }
}
