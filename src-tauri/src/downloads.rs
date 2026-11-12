//! Progress of cloud files that download now. A cloud drive publishes an NSProgress for each download.
//! Only a subscriber on the file's own folder sees it, so each watched cloud folder is subscribed.
//! While a download runs, the interface gets `cloud:downloads`. When it ends, the interface gets `fs:changed`.

pub fn is_cloud(path: &str) -> bool {
    path.contains("/Library/CloudStorage/") || path.contains("/Library/Mobile Documents/")
}

/// Downloads an online-only cloud file. Reading the file makes its drive download all of it.
#[tauri::command(async)]
pub fn download_file(path: String) -> Result<(), String> {
    download(std::path::Path::new(&path))
}

pub(crate) fn download(path: &std::path::Path) -> Result<(), String> {
    use std::io::Read;
    let dataless = |p: &std::path::Path| std::fs::metadata(p).is_ok_and(|m| crate::thumbs::is_dataless(&m));
    if !dataless(path) {
        return Ok(());
    }
    std::fs::File::open(path)
        .and_then(|mut f| f.read(&mut [0u8; 1]))
        .map_err(|e| format!("Couldn't download it: {e}"))?;
    if dataless(path) {
        return Err("Couldn't download it: the drive didn't send it".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub use mac::*;

#[cfg(target_os = "macos")]
mod mac {
    use crate::lock::Locked;
    use super::is_cloud;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::Message;
    use objc2_foundation::{NSProgress, NSProgressFileOperationKindDownloading, NSProgressUnpublishingHandler, NSString, NSURL};
    use serde::Serialize;
    use std::collections::HashMap;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};

    const TICK: Duration = Duration::from_millis(250);
    /// Give up on a download with no progress for this long. A failed download may never say it ended.
    const STALLED: Duration = Duration::from_secs(60);

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static SUBS: Mutex<Option<HashMap<String, Sub>>> = Mutex::new(None);
    static LIVE: Mutex<Vec<Live>> = Mutex::new(Vec::new());
    static POLLING: AtomicBool = AtomicBool::new(false);

    struct Sub(Retained<AnyObject>);
    // Only used on the main thread. The map just holds it.
    unsafe impl Send for Sub {}

    struct Live {
        path: String,
        progress: Retained<NSProgress>,
        fraction: f64,
        moved: Instant,
    }

    #[derive(Serialize, Clone)]
    struct Row<'a> {
        path: &'a str,
        fraction: f64,
    }

    pub fn init(app: AppHandle) {
        let _ = APP.set(app);
    }

    pub fn subscribe(dir: &str) {
        let Some(app) = APP.get().filter(|_| is_cloud(dir)) else { return };
        let dir = dir.to_string();
        let _ = app.run_on_main_thread(move || {
            let mut subs = SUBS.locked();
            let subs = subs.get_or_insert_with(HashMap::new);
            if subs.contains_key(&dir) {
                return;
            }
            let url = NSURL::fileURLWithPath(&NSString::from_str(&dir));
            let own = dir.clone();
            let handler = RcBlock::new(move |p: NonNull<NSProgress>| -> NSProgressUnpublishingHandler {
                seen(unsafe { p.as_ref() }, &own);
                // The poll sees the end, so there is no unpublishing handler.
                std::ptr::null_mut()
            });
            let sub = unsafe { NSProgress::addSubscriberForFileURL_withPublishingHandler(&url, RcBlock::as_ptr(&handler)) };
            subs.insert(dir, Sub(sub));
        });
    }

    pub fn unsubscribe(dir: &str) {
        let Some(app) = APP.get().filter(|_| is_cloud(dir)) else { return };
        let dir = dir.to_string();
        let _ = app.run_on_main_thread(move || {
            if let Some(sub) = SUBS.locked().as_mut().and_then(|s| s.remove(&dir)) {
                unsafe { NSProgress::removeSubscriber(&sub.0) };
            }
        });
    }

    fn seen(p: &NSProgress, dir: &str) {
        let downloading = p
            .fileOperationKind()
            .is_some_and(|k| k.isEqualToString(unsafe { NSProgressFileOperationKindDownloading }));
        let Some(path) = p.fileURL().and_then(|u| u.path()).map(|s| s.to_string()) else { return };
        // A drive root also publishes a total for everything under it.
        if !downloading || path.trim_end_matches('/') == dir {
            return;
        }
        let mut live = LIVE.locked();
        live.retain(|l| l.path != path);
        live.push(Live { path, progress: p.retain(), fraction: 0.0, moved: Instant::now() });
        drop(live);
        if !POLLING.swap(true, Ordering::SeqCst) {
            std::thread::spawn(poll);
        }
    }

    fn still_dataless(path: &str) -> bool {
        std::fs::symlink_metadata(path).is_ok_and(|m| crate::thumbs::is_dataless(&m))
    }

    fn poll() {
        let Some(app) = APP.get() else { return };
        loop {
            std::thread::sleep(TICK);
            let mut ended = Vec::new();
            let mut live = LIVE.locked();
            live.retain_mut(|l| {
                let f = l.progress.fractionCompleted().clamp(0.0, 1.0);
                if f != l.fraction {
                    l.fraction = f;
                    l.moved = Instant::now();
                }
                let done = l.progress.isFinished()
                    || l.progress.isCancelled()
                    || f >= 1.0
                    || l.moved.elapsed() > STALLED
                    || !still_dataless(&l.path);
                if done {
                    ended.push(l.path.clone());
                }
                !done
            });
            let rows: Vec<Row> = live.iter().map(|l| Row { path: &l.path, fraction: l.fraction }).collect();
            let _ = app.emit("cloud:downloads", &rows);
            let empty = rows.is_empty();
            if empty {
                POLLING.store(false, Ordering::SeqCst);
            }
            drop(rows);
            drop(live);
            for path in ended {
                if let Some(dir) = std::path::Path::new(&path).parent() {
                    let _ = app.emit("fs:changed", dir.to_string_lossy());
                }
            }
            if empty {
                return;
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn init(_app: tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::is_cloud;

    #[test]
    fn only_synced_folders_are_cloud() {
        assert!(is_cloud("/Users/me/Library/CloudStorage/Box-Box/a.pdf"));
        assert!(is_cloud("/Users/me/Library/Mobile Documents/com~apple~CloudDocs"));
        assert!(!is_cloud("/Users/me/Documents/CloudStorage/a.pdf"));
    }
}
