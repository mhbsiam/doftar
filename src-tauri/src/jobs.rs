use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ops::Deref;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

const EMIT_EVERY: Duration = Duration::from_millis(80);
/// How long a cancel that found no job waits for one to start under its key.
const EARLY_CANCEL_TTL: Duration = Duration::from_secs(30);

/// A job as the window that started it names it. Every window numbers its
/// jobs from the same start (and again after a reload), so an id alone
/// doesn't say whose job it is.
pub type JobKey = (String, u64);

pub fn job_key(webview: &tauri::Webview, id: u64) -> JobKey {
    (webview.label().to_string(), id)
}

struct CancelFlag {
    flag: Arc<AtomicBool>,
    /// When the cancel came, if it came before any job registered.
    early: Option<Instant>,
}

/// Cancel flags for one kind of long-running command. The UI cancels in an
/// effect cleanup right after invoking, so a cancel can beat its job to the
/// registry, or arrive after the job ended; either way it leaves a flag the
/// job picks up when it starts, dropped if none does soon.
pub struct Cancels(OnceLock<Mutex<HashMap<JobKey, CancelFlag>>>);

impl Cancels {
    pub const fn new() -> Self {
        Cancels(OnceLock::new())
    }

    fn map(&self) -> MutexGuard<'_, HashMap<JobKey, CancelFlag>> {
        let mut map = self.0.get_or_init(Default::default).lock().unwrap();
        map.retain(|_, c| c.early.is_none_or(|at| at.elapsed() < EARLY_CANCEL_TTL));
        map
    }

    /// Registers a job and returns its flag, already set if its cancel came first.
    pub fn begin(&self, key: JobKey) -> Arc<AtomicBool> {
        let mut map = self.map();
        // A job still running under this key (from before a reload) keeps
        // its own flag; the new one gets a fresh one.
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

    /// Unregisters the job that `begin` gave `flag`, unless a newer job
    /// under the same key replaced it.
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
}

/// An undo or redo step. `id` names the item a step acts on (see
/// `file_id`), so a step refuses to touch whatever else has since taken that
/// path. Steps made in the window carry none and act on the path alone.
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
    /// Moves what is now at `from` to `to`.
    pub fn moved(from: String, to: String) -> Step {
        let id = file_id(Path::new(&from));
        Step::Move { from, to, id }
    }

    /// Trashes what is now at `path`.
    pub fn trash(path: String) -> Step {
        let id = file_id(Path::new(&path));
        Step::Trash { path, id }
    }
}

/// The item at `p` (not what a symlink there points to) as volume and file
/// number, which APFS and HFS+ never hand to another file. A string, as the
/// window's numbers can't hold every 64-bit value.
pub fn file_id(p: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(p)
        .ok()
        .map(|m| format!("{}:{}", m.dev(), m.ino()))
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub inverse: Vec<Step>,
    pub cancelled: bool,
    pub errors: Vec<String>,
}

pub struct Job {
    cancel: AtomicBool,
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
        if let Some(id) = self.id {
            // Ids restart at 1 after a webview reload; only remove the entry
            // if it is still ours, or the newer job becomes uncancellable.
            let mut reg = registry().lock().unwrap();
            if reg.get(&id).is_some_and(|j| Arc::ptr_eq(j, &self.job)) {
                reg.remove(&id);
            }
        }
    }
}

fn new_job(chan: Option<Channel<Progress>>) -> Arc<Job> {
    Arc::new(Job {
        cancel: AtomicBool::new(false),
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

/// Runs blocking filesystem work on the blocking pool so it never parks a
/// tokio worker. A `#[tauri::command(async)]` on a plain fn runs the body
/// directly on a worker; a handful of slow commands could stall every IPC
/// call, so long-running commands go through here instead.
pub async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

pub fn begin(id: u64, chan: Channel<Progress>) -> JobGuard {
    let job = new_job(Some(chan));
    registry().lock().unwrap().insert(id, job.clone());
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
    if let Some(job) = registry().lock().unwrap().get(&job_id) {
        job.cancel.store(true, Ordering::Relaxed);
    }
}

impl Job {
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
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
        *self.current.lock().unwrap() = name.to_string();
        self.emit(false);
    }

    pub fn item_done(&self) {
        self.items_done.fetch_add(1, Ordering::Relaxed);
        self.emit(true);
    }

    pub fn emit(&self, force: bool) {
        let Some(chan) = &self.chan else { return };
        {
            let mut last = self.last_emit.lock().unwrap();
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
            current: self.current.lock().unwrap().clone(),
            scanning: self.scanning.load(Ordering::Relaxed),
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

pub fn start_scan(job: &JobGuard, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    job.scanning.store(true, Ordering::Relaxed);
    let job = job.job.clone();
    std::thread::spawn(move || {
        for p in &paths {
            let n = tree_bytes(&job, Path::new(p));
            job.bytes_total.fetch_add(n, Ordering::Relaxed);
            job.emit(false);
        }
        job.scanning.store(false, Ordering::Relaxed);
        job.emit(true);
    });
}

#[cfg(test)]
mod tests {
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

        // One that never finds its job is dropped after a while.
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
