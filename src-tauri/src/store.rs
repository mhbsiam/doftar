use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

static STORE_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn set_path(p: PathBuf) {
    // A store written by an older build may be world-readable; fix that now
    // rather than at the next save.
    if p.exists() {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
    }
    *STORE_PATH.lock().unwrap() = Some(p);
}

#[tauri::command(async)]
pub fn load_store() -> Result<Option<String>, String> {
    let p = STORE_PATH.lock().unwrap().clone();
    match p {
        Some(p) if p.exists() => fs::read_to_string(p).map(Some).map_err(|e| e.to_string()),
        _ => Ok(None),
    }
}

/// Saves run on worker threads and can finish in any order, and windows
/// save their own copies. One runs at a time, and a snapshot taken before
/// the last one written (`taken_at`, milliseconds on a clock every window
/// shares) is dropped so it can't put back a stale copy.
static SAVE_TICKET: AtomicU64 = AtomicU64::new(0);
static SAVED_AT: Mutex<f64> = Mutex::new(f64::MIN);

#[tauri::command(async)]
pub fn save_store(content: String, taken_at: f64) -> Result<(), String> {
    let p = STORE_PATH
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "store path not initialized".to_string())?;
    save_in_order(&p, taken_at, &content)
}

fn save_in_order(p: &Path, taken_at: f64, content: &str) -> Result<(), String> {
    let mut saved = SAVED_AT.lock().unwrap_or_else(|e| e.into_inner());
    if taken_at < *saved {
        return Ok(());
    }
    // Unique, so a second app instance can't write into this one's temp file.
    let ticket = SAVE_TICKET.fetch_add(1, Ordering::Relaxed);
    let tmp = p.with_extension(format!("json.{}-{ticket}.tmp", std::process::id()));
    if let Err(e) = write_private(&tmp, content.as_bytes()).and_then(|_| fs::rename(&tmp, p)) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    *saved = taken_at;
    Ok(())
}

/// Writes `bytes` to a new file only its owner can read (mode 0600): the
/// store lists what the user opened and pinned.
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
        // Times far above any a real save in this process could hold.
        save_in_order(&p, 1e15 + 2.0, "new").unwrap();
        save_in_order(&p, 1e15 + 1.0, "old").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "new");
        save_in_order(&p, 1e15 + 3.0, "newer").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "newer");
        // No temp files left behind.
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
