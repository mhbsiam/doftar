use crate::lock::Locked;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ops::Deref;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

const EMIT_EVERY: Duration = Duration::from_millis(80);
/// Time a cancel without a job waits for the job to start.
const EARLY_CANCEL_TTL: Duration = Duration::from_secs(30);

/// (window label, job id). Ids restart in each window and after a reload.
pub type JobKey = (String, u64);

pub fn job_key(webview: &tauri::Webview, id: u64) -> JobKey {
    (webview.label().to_string(), id)
}

struct CancelFlag {
    flag: Arc<AtomicBool>,
    /// Set if the cancel came before the job.
    early: Option<Instant>,
}

/// The UI can cancel right after it starts a job. The cancel can arrive first.
/// An early cancel leaves a flag for the job. The flag expires after `EARLY_CANCEL_TTL`.
pub struct Cancels(OnceLock<Mutex<HashMap<JobKey, CancelFlag>>>);

impl Cancels {
    pub const fn new() -> Self {
        Cancels(OnceLock::new())
    }

    fn map(&self) -> MutexGuard<'_, HashMap<JobKey, CancelFlag>> {
        let mut map = self.0.get_or_init(Default::default).locked();
        map.retain(|_, c| c.early.is_none_or(|at| at.elapsed() < EARLY_CANCEL_TTL));
        map
    }

    pub fn begin(&self, key: JobKey) -> Arc<AtomicBool> {
        let mut map = self.map();
        // A job that runs from before a reload keeps its flag. The new job gets a fresh one.
        let flag = match map.remove(&key) {
            Some(c) if c.early.is_some() => c.flag,
            _ => Arc::new(AtomicBool::new(false)),
        };
        map.insert(key, CancelFlag { flag: flag.clone(), early: None });
        flag
    }

    pub fn cancel(&self, key: JobKey) {
        self.map()
            .entry(key)
            .or_insert_with(|| CancelFlag {
                flag: Arc::new(AtomicBool::new(false)),
                early: Some(Instant::now()),
            })
            .flag
            .store(true, Ordering::Relaxed);
    }

    /// Keep the entry if a newer job under the same key replaced it.
    pub fn end(&self, key: &JobKey, flag: &Arc<AtomicBool>) {
        let mut map = self.map();
        if map.get(key).is_some_and(|c| Arc::ptr_eq(&c.flag, flag)) {
            map.remove(key);
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.map().len()
    }
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub items_done: usize,
    pub items_total: usize,
    pub current: String,
    pub scanning: bool,
    pub paused: bool,
}

/// An undo or redo step. `id` is the `file_id` of the item. A step does not touch another item at the same path.
/// A step without an `id` acts on the path alone.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Step {
    Move {
        from: String,
        to: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    Copy { from: String, to: String },
    Trash {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
}

impl Step {
    pub fn moved(from: String, to: String) -> Step {
        let id = file_id(Path::new(&from));
        Step::Move { from, to, id }
    }

    pub fn trash(path: String) -> Step {
        let id = file_id(Path::new(&path));
        Step::Trash { path, id }
    }
}

/// Volume and file number of `p`, not of a symlink target. APFS and HFS+ never reuse them.
/// It is a string because JS numbers cannot hold every 64-bit value.
pub fn file_id(p: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(p)
        .ok()
        .map(|m| format!("{}:{}", m.dev(), m.ino()))
}

/// `file_id`, size and modified time to the nanosecond. Any save or replace changes it.
pub fn revision(m: &std::fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("{}:{}:{}:{}.{}", m.dev(), m.ino(), m.len(), m.mtime(), m.mtime_nsec())
}

/// Cancel all jobs and wait up to `limit` for them to stop at a safe point. Returns true if any ran.
pub fn stop_all(limit: Duration) -> bool {
    let reg = registry().locked();
    let any = !reg.is_empty();
    for job in reg.values() {
        job.cancel.store(true, Ordering::Relaxed);
    }
    drop(reg);
    let until = Instant::now() + limit;
    while !registry().locked().is_empty() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
    any
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub inverse: Vec<Step>,
    pub cancelled: bool,
    pub errors: Vec<String>,
    /// Items left in place. Their volume has no Trash.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub no_trash: Vec<String>,
    /// Steps a cancelled undo or redo did not reach.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub left: Vec<Step>,
    /// Steps that failed. The UI can retry them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub failed: Vec<Step>,
}

pub struct Job {
    cancel: AtomicBool,
    paused: AtomicBool,
    /// Compare checksums after a copy to another volume. See `fsops::copy`.
    verify: AtomicBool,
    /// Why the job stopped itself, for the user. Set with `cancel`.
    abort: Mutex<Option<String>>,
    /// Held while the job works, so the Mac does not sleep halfway through a copy. Not held while paused.
    awake: Mutex<Option<awake::Awake>>,
    done: AtomicBool,
    scanning: AtomicBool,
    bytes_done: AtomicU64,
    bytes_total: AtomicU64,
    items_done: AtomicUsize,
    items_total: AtomicUsize,
    current: Mutex<String>,
    chan: Option<Channel<Progress>>,
    last_emit: Mutex<Instant>,
}

fn registry() -> &'static Mutex<HashMap<u64, Arc<Job>>> {
    static REG: OnceLock<Mutex<HashMap<u64, Arc<Job>>>> = OnceLock::new();
    REG.get_or_init(Default::default)
}

pub struct JobGuard {
    job: Arc<Job>,
    id: Option<u64>,
}

impl Deref for JobGuard {
    type Target = Job;
    fn deref(&self) -> &Job {
        &self.job
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        self.job.done.store(true, Ordering::Relaxed);
        // The scan thread can outlive the guard and still hold the job.
        self.job.awake.locked().take();
        if let Some(id) = self.id {
            // Ids restart after a reload. Remove only our entry, or a newer job cannot be cancelled.
            let mut reg = registry().locked();
            if reg.get(&id).is_some_and(|j| Arc::ptr_eq(j, &self.job)) {
                reg.remove(&id);
            }
        }
    }
}

fn new_job(chan: Option<Channel<Progress>>) -> Arc<Job> {
    Arc::new(Job {
        cancel: AtomicBool::new(false),
        paused: AtomicBool::new(false),
        verify: AtomicBool::new(false),
        abort: Mutex::new(None),
        awake: Mutex::new(None),
        done: AtomicBool::new(false),
        scanning: AtomicBool::new(false),
        bytes_done: AtomicU64::new(0),
        bytes_total: AtomicU64::new(0),
        items_done: AtomicUsize::new(0),
        items_total: AtomicUsize::new(0),
        current: Mutex::new(String::new()),
        chan,
        last_emit: Mutex::new(Instant::now() - EMIT_EVERY),
    })
}

/// Run slow work on the blocking pool. `#[tauri::command(async)]` on a plain fn runs on a worker.
/// A few slow commands can then stall all IPC calls.
pub async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

fn early_cancels() -> MutexGuard<'static, HashMap<u64, Instant>> {
    static EARLY: OnceLock<Mutex<HashMap<u64, Instant>>> = OnceLock::new();
    let mut map = EARLY.get_or_init(Default::default).locked();
    map.retain(|_, at| at.elapsed() < EARLY_CANCEL_TTL);
    map
}

pub fn begin(id: u64, chan: Channel<Progress>) -> JobGuard {
    let job = new_job(Some(chan));
    let mut reg = registry().locked();
    if early_cancels().remove(&id).is_some() {
        job.cancel.store(true, Ordering::Relaxed);
    }
    reg.insert(id, job.clone());
    *job.awake.locked() = awake::Awake::begin();
    JobGuard { job, id: Some(id) }
}

#[cfg(test)]
pub fn detached() -> JobGuard {
    JobGuard {
        job: new_job(None),
        id: None,
    }
}

#[tauri::command]
pub fn cancel_job(job_id: u64) {
    // Same lock order as `begin`. A cancel cannot fall between its check and insert.
    let reg = registry().locked();
    match reg.get(&job_id) {
        Some(job) => job.cancel.store(true, Ordering::Relaxed),
        None => {
            early_cancels().insert(job_id, Instant::now());
        }
    }
}

/// Pauses or resumes a job. A paused job holds at its next safe point: between files, or between blocks of one file.
#[tauri::command]
pub fn pause_job(job_id: u64, paused: bool) {
    if let Some(job) = registry().locked().get(&job_id) {
        job.set_paused(paused);
    }
}

/// The message when a copy needs more room than the destination has. `None` when it fits.
pub fn space_shortfall(volume: &str, needed: u64, free: u64) -> Option<String> {
    let gb = |n: u64| format!("{:.1} GB", n as f64 / 1e9);
    (needed > free).then(|| format!("Not enough space on \"{volume}\": the copy needs {}, and {} is free", gb(needed), gb(free)))
}

impl Job {
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub fn cancel_flag(&self) -> &AtomicBool {
        &self.cancel
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::Relaxed);
        // A paused job may wait for days. Let the Mac sleep until it resumes.
        *self.awake.locked() = if paused || self.done.load(Ordering::Relaxed) { None } else { awake::Awake::begin() };
        self.emit(true);
    }

    /// Holds the calling thread while the job is paused. A cancel ends the wait.
    pub fn wait_while_paused(&self) {
        while self.paused.load(Ordering::Relaxed) && !self.cancelled() {
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    pub fn set_verify(&self, on: bool) {
        self.verify.store(on, Ordering::Relaxed);
    }

    pub fn verifies(&self) -> bool {
        self.verify.load(Ordering::Relaxed)
    }

    /// Stops the job and keeps the reason for `abort_reason`.
    pub fn abort(&self, why: String) {
        *self.abort.locked() = Some(why);
        self.cancel.store(true, Ordering::Relaxed);
    }

    pub fn abort_reason(&self) -> Option<String> {
        self.abort.locked().clone()
    }

    #[cfg(test)]
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    #[cfg(test)]
    pub fn bytes_done(&self) -> u64 {
        self.bytes_done.load(Ordering::Relaxed)
    }

    pub fn set_items_total(&self, n: usize) {
        self.items_total.store(n, Ordering::Relaxed);
    }

    pub fn add_bytes(&self, n: u64) {
        self.bytes_done.fetch_add(n, Ordering::Relaxed);
        self.emit(false);
    }

    pub fn set_current(&self, name: &str) {
        *self.current.locked() = name.to_string();
        self.emit(false);
    }

    pub fn item_done(&self) {
        self.items_done.fetch_add(1, Ordering::Relaxed);
        self.emit(true);
    }

    pub fn emit(&self, force: bool) {
        let Some(chan) = &self.chan else { return };
        {
            let mut last = self.last_emit.locked();
            if !force && last.elapsed() < EMIT_EVERY {
                return;
            }
            *last = Instant::now();
        }
        let _ = chan.send(Progress {
            bytes_done: self.bytes_done.load(Ordering::Relaxed),
            bytes_total: self.bytes_total.load(Ordering::Relaxed),
            items_done: self.items_done.load(Ordering::Relaxed),
            items_total: self.items_total.load(Ordering::Relaxed),
            current: self.current.locked().clone(),
            scanning: self.scanning.load(Ordering::Relaxed),
            paused: self.paused.load(Ordering::Relaxed),
        });
    }
}

fn tree_bytes(job: &Job, path: &Path) -> u64 {
    if job.cancelled() || job.done.load(Ordering::Relaxed) {
        return 0;
    }
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if !meta.is_dir() {
        return meta.len();
    }
    let Ok(rd) = std::fs::read_dir(path) else {
        return 0;
    };
    rd.flatten().map(|e| tree_bytes(job, &e.path())).sum()
}

/// Totals the bytes of `paths` for the progress bar. With `space_on`, also stops the job when the
/// items coming from other volumes need more room than that folder's volume has.
// shortcut: a same-volume copy counts as free (an APFS clone). On exFAT it is a full copy and is not checked. Check all copies there if it comes up.
pub fn start_scan(job: &JobGuard, paths: Vec<String>, space_on: Option<&Path>) {
    use std::os::unix::fs::MetadataExt;
    if paths.is_empty() {
        return;
    }
    job.scanning.store(true, Ordering::Relaxed);
    let job = job.job.clone();
    let dest = space_on.map(Path::to_path_buf);
    std::thread::spawn(move || {
        let dev = |p: &Path| std::fs::metadata(p).ok().map(|m| m.dev());
        let dest_dev = dest.as_deref().and_then(dev);
        let mut incoming = 0u64;
        for p in &paths {
            let n = tree_bytes(&job, Path::new(p));
            job.bytes_total.fetch_add(n, Ordering::Relaxed);
            if dest_dev.is_some() && std::fs::symlink_metadata(p).ok().map(|m| m.dev()) != dest_dev {
                incoming = incoming.saturating_add(n);
            }
            job.emit(false);
        }
        job.scanning.store(false, Ordering::Relaxed);
        if let Some(dest) = dest.filter(|_| !job.cancelled() && !job.done.load(Ordering::Relaxed)) {
            // Count what this job already wrote there as still needed. It left the free space.
            let free = fs2::available_space(&dest).unwrap_or(u64::MAX).saturating_add(job.bytes_done.load(Ordering::Relaxed));
            let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "/".into());
            if let Some(why) = space_shortfall(&name, incoming, free) {
                job.abort(why);
            }
        }
        job.emit(true);
    });
}

/// Stops idle sleep while a job runs. Closing the lid still sleeps the Mac.
mod awake {
    pub struct Awake(#[allow(dead_code)] u32);

    #[cfg(target_os = "macos")]
    mod sys {
        use objc2_core_foundation::CFString;
        #[link(name = "IOKit", kind = "framework")]
        extern "C" {
            pub fn IOPMAssertionCreateWithName(kind: &CFString, level: u32, name: &CFString, id: *mut u32) -> i32;
            pub fn IOPMAssertionRelease(id: u32) -> i32;
        }
    }

    impl Awake {
        #[cfg(target_os = "macos")]
        pub fn begin() -> Option<Awake> {
            use objc2_core_foundation::CFString;
            let mut id = 0u32;
            let kind = CFString::from_static_str("PreventUserIdleSystemSleep");
            let name = CFString::from_static_str("Doftar is copying, moving or deleting files");
            // 255 is kIOPMAssertionLevelOn.
            let rc = unsafe { sys::IOPMAssertionCreateWithName(&kind, 255, &name, &mut id) };
            (rc == 0).then_some(Awake(id))
        }

        #[cfg(not(target_os = "macos"))]
        pub fn begin() -> Option<Awake> {
            None
        }
    }

    #[cfg(target_os = "macos")]
    impl Drop for Awake {
        fn drop(&mut self) {
            unsafe { sys::IOPMAssertionRelease(self.0) };
        }
    }

    #[cfg(all(test, target_os = "macos"))]
    #[test]
    fn an_assertion_is_taken_and_released() {
        assert!(Awake::begin().is_some());
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_copy_that_does_not_fit_is_named_with_both_sizes() {
        assert_eq!(super::space_shortfall("USB", 5, 5), None);
        let why = super::space_shortfall("USB", 12_400_000_000, 3_100_000_000).unwrap();
        assert!(why.contains("\"USB\"") && why.contains("12.4 GB") && why.contains("3.1 GB"), "{why}");
    }

    #[test]
    fn a_paused_job_waits_until_it_is_resumed_or_cancelled() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let job = std::sync::Arc::new(super::detached());
        job.set_paused(true);
        let passed = std::sync::Arc::new(AtomicBool::new(false));
        let (j, p) = (job.job.clone(), passed.clone());
        let t = std::thread::spawn(move || {
            j.wait_while_paused();
            p.store(true, Ordering::Relaxed);
        });
        std::thread::sleep(std::time::Duration::from_millis(250));
        assert!(!passed.load(Ordering::Relaxed), "a paused job must hold");
        job.set_paused(false);
        t.join().unwrap();
        assert!(passed.load(Ordering::Relaxed));
        job.set_paused(true);
        job.cancel();
        job.wait_while_paused();
    }

    use super::*;

    fn key(window: &str, id: u64) -> JobKey {
        (window.to_string(), id)
    }

    #[test]
    fn a_cancel_reaches_only_its_own_windows_job() {
        let c = Cancels::new();
        let a = c.begin(key("main", 1));
        let b = c.begin(key("tab-1", 1));
        c.cancel(key("main", 1));
        assert!(a.load(Ordering::Relaxed));
        assert!(!b.load(Ordering::Relaxed), "same id, other window");
        c.end(&key("main", 1), &a);
        c.end(&key("tab-1", 1), &b);
        assert_eq!(c.len(), 0);
    }

    #[test]
    fn an_early_cancel_waits_for_its_job_and_then_goes() {
        let c = Cancels::new();
        c.cancel(key("main", 2));
        let f = c.begin(key("main", 2));
        assert!(f.load(Ordering::Relaxed), "starts cancelled");
        c.end(&key("main", 2), &f);
        assert_eq!(c.len(), 0);

        c.cancel(key("main", 3));
        c.map().get_mut(&key("main", 3)).unwrap().early =
            Some(Instant::now() - EARLY_CANCEL_TTL);
        assert_eq!(c.len(), 0);
        assert!(!c.begin(key("main", 3)).load(Ordering::Relaxed));
    }

    #[test]
    fn a_new_job_under_a_running_ones_key_gets_its_own_flag() {
        let c = Cancels::new();
        let old = c.begin(key("main", 1));
        let new = c.begin(key("main", 1));
        assert!(!Arc::ptr_eq(&old, &new));
        c.end(&key("main", 1), &old);
        c.cancel(key("main", 1));
        assert!(new.load(Ordering::Relaxed), "the old job's end left the new one registered");
    }
}
