use crate::lock::Locked;
use std::collections::HashMap;
use std::sync::Mutex;

#[cfg(target_os = "macos")]
pub use kq::*;
#[cfg(not(target_os = "macos"))]
pub use ino::*;

struct Watch {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fd: i32,
    refs: usize,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    id: usize,
    /// The first id. It stays the same after a re-arm. Owners hold it.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    serial: usize,
}

static EJECTING: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn begin_eject(prefix: &str) {
    EJECTING.locked().push(prefix.to_string());
}

pub fn end_eject(prefix: &str) {
    // Remove one entry. Another eject of the same volume can still be running.
    let mut ejecting = EJECTING.locked();
    if let Some(i) = ejecting.iter().position(|p| p == prefix) {
        ejecting.swap_remove(i);
    }
}

pub fn is_ejecting(path: &str) -> bool {
    EJECTING
        .locked()
        .iter()
        .any(|p| path == p || path.starts_with(&format!("{p}/")))
}

#[derive(Default)]
pub struct WatcherState {
    inner: Mutex<HashMap<String, Watch>>,
    files: Mutex<HashMap<String, Watch>>,
    /// Folder watches of each window, as (path, serial).
    /// A window releases only the watch with its serial. A replaced watch stays.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    owners: Mutex<HashMap<String, Vec<(String, usize)>>>,
    /// The files each window watches. The watched set is the union.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    file_sets: Mutex<HashMap<String, Vec<String>>>,
}

#[cfg(target_os = "macos")]
mod kq {
    use crate::lock::Locked;
    use super::{Watch, WatcherState};
    use std::collections::{HashMap, HashSet};
    use std::ffi::CString;
    use std::os::raw::c_void;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter, Manager};

    const COALESCE: Duration = Duration::from_millis(100);
    /// Interval to look again for a watched folder that is gone.
    const REARM_EVERY: Duration = Duration::from_secs(1);

    const DIR_NOTES: u32 = libc::NOTE_WRITE
        | libc::NOTE_EXTEND
        | libc::NOTE_LINK
        | libc::NOTE_DELETE
        | libc::NOTE_RENAME
        | libc::NOTE_REVOKE;
    const FILE_NOTES: u32 = libc::NOTE_WRITE
        | libc::NOTE_EXTEND
        | libc::NOTE_ATTRIB
        | libc::NOTE_DELETE
        | libc::NOTE_RENAME
        | libc::NOTE_REVOKE;
    /// The item left its path. Its fd does not see a new item there.
    const GONE: u32 = libc::NOTE_DELETE | libc::NOTE_RENAME | libc::NOTE_REVOKE;

    static KQ: OnceLock<i32> = OnceLock::new();
    static PATHS: Mutex<Option<HashMap<usize, (String, bool)>>> = Mutex::new(None);
    const MAX_FILE_WATCHES: usize = 256;
    static NEXT_ID: AtomicUsize = AtomicUsize::new(1);
    /// Set when the watcher thread exits. Watch requests then fail, so the UI reloads on focus.
    static DEAD: AtomicBool = AtomicBool::new(false);
    /// `watch_files` calls can finish out of order. Only the newest replaces the watched set.
    static FILES_GEN: AtomicU64 = AtomicU64::new(0);
    static FILES_APPLIED: AtomicU64 = AtomicU64::new(0);

    pub fn init(app: AppHandle) {
        let kq = unsafe { libc::kqueue() };
        if kq < 0 {
            eprintln!("watcher: kqueue() failed: {}", std::io::Error::last_os_error());
            return;
        }
        let _ = KQ.set(kq);
        *PATHS.locked() = Some(HashMap::new());
        std::thread::Builder::new()
            .name("fs-watcher".into())
            .spawn(move || run(kq, app))
            .expect("spawn fs-watcher thread");
    }

    fn run(kq: i32, app: AppHandle) {
        let state = app.state::<WatcherState>();
        let mut pending: HashSet<(String, bool)> = HashSet::new();
        let mut deadline: Option<Instant> = None;
        let mut rearm_at: Option<Instant> = None;
        let mut evs: [libc::kevent; 64] = unsafe { std::mem::zeroed() };
        loop {
            let ts;
            let tsp = match [deadline, rearm_at].into_iter().flatten().min() {
                Some(d) => {
                    let rem = d.saturating_duration_since(Instant::now());
                    ts = libc::timespec {
                        tv_sec: rem.as_secs() as libc::time_t,
                        tv_nsec: rem.subsec_nanos() as libc::c_long,
                    };
                    &ts as *const libc::timespec
                }
                None => std::ptr::null(),
            };
            let n = unsafe {
                libc::kevent(kq, std::ptr::null(), 0, evs.as_mut_ptr(), evs.len() as i32, tsp)
            };
            if n < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                eprintln!("watcher: kevent failed: {}", std::io::Error::last_os_error());
                DEAD.store(true, Ordering::Relaxed);
                return;
            }
            if n > 0 {
                let mut gone = Vec::new();
                {
                    let paths = PATHS.locked();
                    if let Some(paths) = paths.as_ref() {
                        for ev in &evs[..n as usize] {
                            let id = ev.udata as usize;
                            if let Some(p) = paths.get(&id) {
                                pending.insert(p.clone());
                                if ev.fflags & GONE != 0 {
                                    gone.push((id, p.clone()));
                                }
                            }
                        }
                    }
                }
                for (id, (path, is_file)) in gone {
                    if is_file {
                        // The next `watch_files` opens the new file at this path.
                        drop_watch(&state.files, &path, id);
                    } else if orphan(&state, &path, id) {
                        rearm_at.get_or_insert_with(|| Instant::now() + REARM_EVERY);
                    }
                }
                if !pending.is_empty() && deadline.is_none() {
                    deadline = Some(Instant::now() + COALESCE);
                }
            }
            if rearm_at.is_some_and(|d| Instant::now() >= d) {
                for path in rearm(kq, &state) {
                    pending.insert((path, false));
                    deadline.get_or_insert_with(Instant::now);
                }
                rearm_at = has_orphans(&state).then(|| Instant::now() + REARM_EVERY);
            }
            if deadline.is_some_and(|d| Instant::now() >= d) {
                for (p, is_file) in pending.drain() {
                    let _ = app.emit(if is_file { "fs:file" } else { "fs:changed" }, p);
                }
                deadline = None;
            }
        }
    }

    /// Non-blocking, so a FIFO or device cannot wait for a peer.
    fn open_evt(path: &str) -> std::io::Result<i32> {
        let c = CString::new(path)?;
        let fd = unsafe {
            libc::open(c.as_ptr(), libc::O_EVTONLY | libc::O_CLOEXEC | libc::O_NONBLOCK)
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(fd)
    }

    /// Closes the fd on failure.
    fn register(kq: i32, fd: i32, path: &str, is_file: bool) -> Result<usize, String> {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        PATHS
            .locked()
            .get_or_insert_with(HashMap::new)
            .insert(id, (path.to_string(), is_file));
        let change = libc::kevent {
            ident: fd as usize,
            filter: libc::EVFILT_VNODE,
            flags: libc::EV_ADD | libc::EV_CLEAR,
            fflags: if is_file { FILE_NOTES } else { DIR_NOTES },
            data: 0,
            udata: id as *mut c_void,
        };
        let rc = unsafe {
            libc::kevent(kq, &change, 1, std::ptr::null_mut(), 0, std::ptr::null())
        };
        if rc < 0 {
            let err = std::io::Error::last_os_error().to_string();
            unforget(id);
            unsafe { libc::close(fd) };
            return Err(err);
        }
        Ok(id)
    }

    fn unforget(id: usize) {
        if let Some(m) = PATHS.locked().as_mut() {
            m.remove(&id);
        }
    }

    /// A folder that waits for a re-arm has no fd.
    fn close_watch(w: &Watch) {
        unforget(w.id);
        if w.fd >= 0 {
            unsafe { libc::close(w.fd) };
        }
    }

    /// Remove the watch only if it still has `id`.
    fn drop_watch(map: &Mutex<HashMap<String, Watch>>, path: &str, id: usize) {
        let mut m = map.locked();
        if m.get(path).is_some_and(|w| w.id == id) {
            close_watch(&m.remove(path).unwrap());
        }
    }

    /// Keep the references so `rearm` can watch the next folder at this path.
    fn orphan(state: &WatcherState, path: &str, id: usize) -> bool {
        let mut inner = state.inner.locked();
        let Some(w) = inner.get_mut(path).filter(|w| w.id == id) else { return false };
        close_watch(w);
        w.fd = -1;
        true
    }

    fn has_orphans(state: &WatcherState) -> bool {
        state.inner.locked().values().any(|w| w.fd < 0)
    }

    /// Returns the paths of the folders it watches again.
    fn rearm(kq: i32, state: &WatcherState) -> Vec<String> {
        let orphans: Vec<String> = {
            let inner = state.inner.locked();
            inner.iter().filter(|(_, w)| w.fd < 0).map(|(p, _)| p.clone()).collect()
        };
        let mut back = Vec::new();
        for path in orphans {
            if super::is_ejecting(&path) || !std::fs::metadata(&path).is_ok_and(|m| m.is_dir()) {
                continue;
            }
            let Ok(fd) = open_evt(&path) else { continue };
            let mut inner = state.inner.locked();
            let Some(w) = inner.get_mut(&path).filter(|w| w.fd < 0) else {
                unsafe { libc::close(fd) };
                continue;
            };
            if let Ok(id) = register(kq, fd, &path, false) {
                w.fd = fd;
                w.id = id;
                back.push(path);
            }
        }
        back
    }

    #[tauri::command(async)]
    pub fn watch_path(
        window: tauri::Window,
        state: tauri::State<'_, WatcherState>,
        path: String,
    ) -> Result<(), String> {
        if let Some(id) = add_watch(&state, path.clone())? {
            let mut owners = state.owners.locked();
            owners.entry(window.label().to_string()).or_default().push((path, id));
        }
        Ok(())
    }

    /// Returns the serial of the watch, or `None` if it took no reference.
    fn add_watch(state: &WatcherState, path: String) -> Result<Option<usize>, String> {
        let kq = *KQ.get().ok_or("file watcher unavailable")?;
        if DEAD.load(Ordering::Relaxed) {
            return Err("file watcher stopped".to_string());
        }
        if super::is_ejecting(&path) {
            return Ok(None);
        }
        if let Some(w) = state.inner.locked().get_mut(&path) {
            w.refs += 1;
            return Ok(Some(w.serial));
        }
        // Open with no lock held. A stalled volume makes this slow.
        let fd = open_evt(&path).map_err(|e| e.to_string())?;
        let mut inner = state.inner.locked();
        if let Some(w) = inner.get_mut(&path) {
            unsafe { libc::close(fd) };
            w.refs += 1;
            return Ok(Some(w.serial));
        }
        let id = register(kq, fd, &path, false)?;
        crate::downloads::subscribe(&path);
        inner.insert(path, Watch { fd, refs: 1, id, serial: id });
        Ok(Some(id))
    }

    #[tauri::command(async)]
    pub fn watch_files(
        window: tauri::Window,
        state: tauri::State<'_, WatcherState>,
        paths: Vec<String>,
    ) -> Result<(), String> {
        // Take the generation while the sets are locked. Calls then apply in order.
        let (gen, union) = {
            let mut sets = state.file_sets.locked();
            sets.insert(window.label().to_string(), paths);
            (next_files_gen(), union_of(&sets))
        };
        apply_files(&state, gen, union)
    }

    fn next_files_gen() -> u64 {
        FILES_GEN.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn union_of(sets: &HashMap<String, Vec<String>>) -> Vec<String> {
        let mut seen = HashSet::new();
        sets.values()
            .flatten()
            .filter(|p| seen.insert(p.as_str()))
            .cloned()
            .collect()
    }

    /// Opening a FIFO waits for a writer. A device can react. Skip all but regular files.
    fn open_file(p: &str) -> Option<i32> {
        if !std::fs::metadata(p).is_ok_and(|m| m.is_file()) {
            return None;
        }
        open_evt(p).ok()
    }

    fn apply_files(state: &WatcherState, gen: u64, paths: Vec<String>) -> Result<(), String> {
        let kq = *KQ.get().ok_or("file watcher unavailable")?;
        if DEAD.load(Ordering::Relaxed) {
            return Err("file watcher stopped".to_string());
        }
        let wanted: Vec<String> = paths
            .into_iter()
            .filter(|p| !super::is_ejecting(p))
            .take(MAX_FILE_WATCHES)
            .collect();
        // Open new files before the lock. A slow open then blocks no other call.
        let have: HashSet<String> = state.files.locked().keys().cloned().collect();
        let mut opened: HashMap<&str, i32> = wanted
            .iter()
            .filter(|p| !have.contains(*p))
            .filter_map(|p| Some((p.as_str(), open_file(p)?)))
            .collect();
        let mut files = state.files.locked();
        if gen < FILES_APPLIED.load(Ordering::Relaxed) {
            for fd in opened.into_values() {
                unsafe { libc::close(fd) };
            }
            return Ok(());
        }
        FILES_APPLIED.store(gen, Ordering::Relaxed);
        let keep: HashSet<&String> = wanted.iter().collect();
        let stale: Vec<String> = files.keys().filter(|k| !keep.contains(k)).cloned().collect();
        for k in stale {
            if let Some(w) = files.remove(&k) {
                close_watch(&w);
            }
        }
        for p in &wanted {
            if files.contains_key(p) {
                continue;
            }
            // Missing if the watch was dropped after `have` was read.
            let Some(fd) = opened.remove(p.as_str()).or_else(|| open_file(p)) else { continue };
            if let Ok(id) = register(kq, fd, p, true) {
                files.insert(p.clone(), Watch { fd, refs: 1, id, serial: id });
            }
        }
        for fd in opened.into_values() {
            unsafe { libc::close(fd) };
        }
        Ok(())
    }

    pub fn release_under(state: &WatcherState, prefix: &str) -> usize {
        let under = |p: &str| p == prefix || p.starts_with(&format!("{prefix}/"));
        let mut dropped = 0;
        for map in [&state.inner, &state.files] {
            let mut m = map.locked();
            let gone: Vec<String> = m.keys().filter(|k| under(k)).cloned().collect();
            for k in gone {
                if let Some(w) = m.remove(&k) {
                    close_watch(&w);
                    dropped += 1;
                }
            }
        }
        dropped
    }

    /// Watch again what `release_under` dropped. The volume stayed mounted.
    pub fn rewatch_under(state: &WatcherState, prefix: &str) {
        let under = |p: &str| p == prefix || p.starts_with(&format!("{prefix}/"));
        let held: Vec<(String, String, usize)> = state
            .owners
            .locked()
            .iter()
            .flat_map(|(w, held)| {
                held.iter().filter(|(p, _)| under(p)).map(move |(p, id)| (w.clone(), p.clone(), *id))
            })
            .collect();
        for (window, path, old) in held {
            // Open with no lock held. A stalled volume makes this slow.
            let Ok(Some(id)) = add_watch(state, path.clone()) else { continue };
            let mut owners = state.owners.locked();
            match owners.get_mut(&window).and_then(|h| h.iter_mut().find(|e| e.0 == path && e.1 == old)) {
                Some(entry) => entry.1 = id,
                // The window released it meanwhile.
                None => {
                    drop(owners);
                    release(state, &path, id);
                }
            }
        }
        let (gen, union) = (next_files_gen(), union_of(&state.file_sets.locked()));
        let _ = apply_files(state, gen, union);
    }

    #[tauri::command(async)]
    pub fn unwatch_path(window: tauri::Window, state: tauri::State<'_, WatcherState>, path: String) {
        let id = {
            let mut owners = state.owners.locked();
            let Some(held) = owners.get_mut(window.label()) else { return };
            let Some(i) = held.iter().position(|(p, _)| p == &path) else { return };
            held.swap_remove(i).1
        };
        release(&state, &path, id);
    }

    pub fn forget_window(state: &WatcherState, label: &str) {
        let held = state.owners.locked().remove(label).unwrap_or_default();
        for (path, id) in held {
            release(state, &path, id);
        }
        let next = {
            let mut sets = state.file_sets.locked();
            sets.remove(label).map(|_| (next_files_gen(), union_of(&sets)))
        };
        if let Some((gen, union)) = next {
            let _ = apply_files(state, gen, union);
        }
    }

    fn release(state: &WatcherState, path: &str, serial: usize) {
        let mut inner = state.inner.locked();
        let Some(w) = inner.get_mut(path).filter(|w| w.serial == serial) else { return };
        w.refs -= 1;
        if w.refs > 0 {
            return;
        }
        close_watch(&inner.remove(path).unwrap());
        crate::downloads::unsubscribe(path);
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_volume_stays_ejecting_until_every_eject_ends() {
            let volume = "/Volumes/doftar-eject-test";
            crate::watcher::begin_eject(volume);
            crate::watcher::begin_eject(volume);
            crate::watcher::end_eject(volume);
            assert!(crate::watcher::is_ejecting(volume));
            crate::watcher::end_eject(volume);
            assert!(!crate::watcher::is_ejecting(volume));
        }

        #[test]
        fn a_fifo_is_not_opened_for_watching() {
            let dir = std::env::temp_dir().join(format!("doftar-fifo-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let fifo = dir.join("pipe");
            let c = CString::new(fifo.to_str().unwrap()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
            assert!(open_file(fifo.to_str().unwrap()).is_none());
            let fd = open_evt(fifo.to_str().unwrap()).unwrap();
            unsafe { libc::close(fd) };
            let file = dir.join("plain");
            std::fs::write(&file, b"x").unwrap();
            let fd = open_file(file.to_str().unwrap()).unwrap();
            unsafe { libc::close(fd) };
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn a_stale_owner_does_not_release_a_newer_watch() {
            let state = WatcherState::default();
            state.inner.locked().insert("/x".into(), Watch { fd: -1, refs: 1, id: 7, serial: 7 });
            release(&state, "/x", 3);
            assert!(state.inner.locked().contains_key("/x"));
            release(&state, "/x", 7);
            assert!(state.inner.locked().is_empty());
        }

        fn next_event(kq: i32) -> Option<usize> {
            let mut ev: libc::kevent = unsafe { std::mem::zeroed() };
            let ts = libc::timespec { tv_sec: 1, tv_nsec: 0 };
            let n = unsafe { libc::kevent(kq, std::ptr::null(), 0, &mut ev, 1, &ts) };
            (n > 0).then_some(ev.udata as usize)
        }

        #[test]
        fn a_recreated_folder_is_watched_again() {
            let kq = unsafe { libc::kqueue() };
            let dir = std::env::temp_dir().join(format!("doftar-rearm-{}", std::process::id()));
            let path = dir.to_str().unwrap().to_string();
            std::fs::create_dir_all(&dir).unwrap();
            let state = WatcherState::default();
            let fd = open_evt(&path).unwrap();
            let id = register(kq, fd, &path, false).unwrap();
            state.inner.locked().insert(path.clone(), Watch { fd, refs: 1, id, serial: id });

            std::fs::remove_dir(&dir).unwrap();
            assert_eq!(next_event(kq), Some(id));
            assert!(orphan(&state, &path, id));
            assert!(has_orphans(&state));
            assert!(rearm(kq, &state).is_empty(), "nothing to watch while it's gone");

            std::fs::create_dir(&dir).unwrap();
            assert_eq!(rearm(kq, &state), std::slice::from_ref(&path));
            assert!(!has_orphans(&state));
            let new_id = state.inner.locked()[&path].id;
            std::fs::write(dir.join("new"), b"x").unwrap();
            assert_eq!(next_event(kq), Some(new_id));

            release(&state, &path, id);
            assert!(state.inner.locked().is_empty());
            let _ = std::fs::remove_dir_all(&dir);
            unsafe { libc::close(kq) };
        }
    }
}

/// inotify through the `notify` crate. Same commands, events and payloads as `kq`.
#[cfg(not(target_os = "macos"))]
mod ino {
    use super::{Watch, WatcherState};
    use crate::lock::Locked;
    use notify::event::{AccessKind, AccessMode, EventKind, ModifyKind};
    use notify::{RecommendedWatcher, RecursiveMode, Watcher};
    use std::collections::{HashMap, HashSet};
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::mpsc::{Receiver, RecvTimeoutError};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter, Manager};

    const COALESCE: Duration = Duration::from_millis(100);
    /// Interval to look again for a watched folder that is gone.
    const REARM_EVERY: Duration = Duration::from_secs(1);
    const MAX_FILE_WATCHES: usize = 256;

    /// inotify has no fd per watch. `Watch::fd` only says if the kernel watch exists.
    const LIVE: i32 = 0;
    /// A folder that waits for a re-arm, as in `kq`.
    const ORPHAN: i32 = -1;

    type Rx = Receiver<notify::Result<notify::Event>>;

    /// One watcher for every path. A watcher per path would take an inotify instance each,
    /// and a user has only 128 of them by default.
    /// Leaf lock: nothing else is locked while it is held.
    static HUB: Mutex<Option<RecommendedWatcher>> = Mutex::new(None);
    static NEXT_ID: AtomicUsize = AtomicUsize::new(1);
    /// Set when the watcher thread exits. Watch requests then fail, so the UI reloads on focus.
    static DEAD: AtomicBool = AtomicBool::new(false);
    /// `watch_files` calls can finish out of order. Only the newest replaces the watched set.
    static FILES_GEN: AtomicU64 = AtomicU64::new(0);
    static FILES_APPLIED: AtomicU64 = AtomicU64::new(0);

    pub fn init(app: AppHandle) {
        let Some(rx) = start_hub() else { return };
        std::thread::Builder::new()
            .name("fs-watcher".into())
            .spawn(move || {
                let state = app.state::<WatcherState>();
                run(rx, &state, |event, path| {
                    let _ = app.emit(event, path);
                });
            })
            .expect("spawn fs-watcher thread");
    }

    /// `notify` reads inotify on its own thread and sends each event to the channel.
    fn start_hub() -> Option<Rx> {
        let (tx, rx) = std::sync::mpsc::channel();
        match notify::recommended_watcher(tx) {
            Ok(w) => {
                *HUB.locked() = Some(w);
                Some(rx)
            }
            Err(e) => {
                eprintln!("watcher: inotify unavailable: {e}");
                None
            }
        }
    }

    /// Report one event's hits, and drop or re-arm what left its path.
    fn absorb(
        state: &WatcherState,
        ev: &notify::Event,
        pending: &mut HashSet<(String, bool)>,
        deadline: &mut Option<Instant>,
        rearm_at: &mut Option<Instant>,
    ) {
        let (hits, gone) = route(state, ev);
        pending.extend(hits);
        for (key, is_file) in gone {
            if is_file {
                rearm_file(state, &key);
            } else if orphan(state, &key) {
                rearm_at.get_or_insert_with(|| Instant::now() + REARM_EVERY);
            }
        }
        if !pending.is_empty() && deadline.is_none() {
            *deadline = Some(Instant::now() + COALESCE);
        }
    }

    /// Route everything queued so far. A re-arm calls this first: what queued
    /// before it is older than the watch it is about to add. `kq` tags every
    /// event with its watch id and drops stale ones; notify names paths only,
    /// so handling the old events before the new watch exists is the guard
    /// that keeps a queued delete from dropping a just re-armed watch.
    fn drain_queued(
        rx: &Rx,
        state: &WatcherState,
        pending: &mut HashSet<(String, bool)>,
        deadline: &mut Option<Instant>,
        rearm_at: &mut Option<Instant>,
    ) {
        while let Ok(queued) = rx.try_recv() {
            match queued {
                Ok(ev) => absorb(state, &ev, pending, deadline, rearm_at),
                Err(e) => eprintln!("watcher: {e}"),
            }
        }
    }

    fn run(rx: Rx, state: &WatcherState, mut emit: impl FnMut(&str, &str)) {
        let mut pending: HashSet<(String, bool)> = HashSet::new();
        let mut deadline: Option<Instant> = None;
        let mut rearm_at: Option<Instant> = None;
        loop {
            let got = match [deadline, rearm_at].into_iter().flatten().min() {
                Some(d) => rx.recv_timeout(d.saturating_duration_since(Instant::now())),
                None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            };
            // notify unwraps its replies to its event loop, and this thread
            // calls into it. A panic here would end watching with no DEAD flag
            // and no way back, so the whole round is contained.
            let alive = catch_unwind(AssertUnwindSafe(|| {
                match got {
                    Ok(Ok(ev)) => absorb(state, &ev, &mut pending, &mut deadline, &mut rearm_at),
                    // One bad read. The watches stay.
                    Ok(Err(e)) => eprintln!("watcher: {e}"),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        eprintln!("watcher: inotify thread stopped");
                        DEAD.store(true, Ordering::Relaxed);
                        return false;
                    }
                }
                if rearm_at.is_some_and(|d| Instant::now() >= d) {
                    drain_queued(&rx, state, &mut pending, &mut deadline, &mut rearm_at);
                    for path in rearm(state) {
                        pending.insert((path, false));
                        deadline.get_or_insert_with(Instant::now);
                    }
                    rearm_at = has_orphans(state).then(|| Instant::now() + REARM_EVERY);
                }
                if deadline.is_some_and(|d| Instant::now() >= d) {
                    for (p, is_file) in pending.drain() {
                        emit(if is_file { "fs:file" } else { "fs:changed" }, &p);
                    }
                    deadline = None;
                }
                true
            }));
            match alive {
                Ok(true) => {}
                Ok(false) => return,
                Err(_) => {
                    eprintln!("watcher: inotify thread stopped");
                    DEAD.store(true, Ordering::Relaxed);
                    return;
                }
            }
        }
    }

    #[derive(PartialEq, Debug)]
    enum Change {
        /// An item appeared, left or got a new name.
        Entries,
        /// The data or attributes of an item changed.
        Content,
    }

    /// `notify` also asks for IN_OPEN. Listing a folder opens it, so an open that
    /// counted as a change would reload the folder forever.
    fn classify(kind: &EventKind) -> Option<Change> {
        match kind {
            EventKind::Create(_) | EventKind::Remove(_) | EventKind::Any => Some(Change::Entries),
            EventKind::Modify(ModifyKind::Name(_)) => Some(Change::Entries),
            EventKind::Modify(_) => Some(Change::Content),
            EventKind::Access(AccessKind::Close(AccessMode::Write)) => Some(Change::Content),
            EventKind::Access(_) | EventKind::Other => None,
        }
    }

    /// The watches to report, and of those the ones whose item left its path. A watch is (key, is_file).
    type Reported = (Vec<(String, bool)>, Vec<(String, bool)>);

    /// The key is the string the webview sent, so it gets the same string back.
    fn route(state: &WatcherState, ev: &notify::Event) -> Reported {
        let (mut hits, mut gone) = (Vec::new(), Vec::new());
        let inner = state.inner.locked();
        // The kernel queue overflowed and events are lost. Reload every folder,
        // and every watched file: their changes in the lost window are lost too.
        if ev.need_rescan() {
            hits.extend(inner.keys().map(|k| (k.clone(), false)));
            hits.extend(state.files.locked().keys().map(|k| (k.clone(), true)));
            return (hits, gone);
        }
        let Some(change) = classify(&ev.kind) else { return (hits, gone) };
        let files = state.files.locked();
        for p in &ev.paths {
            let key = crate::paths::encode(p);
            if files.contains_key(&key) {
                hits.push((key.clone(), true));
                // Deleted, renamed, or a new file took the path. The kernel watch is on the old one.
                if change == Change::Entries {
                    gone.push((key.clone(), true));
                }
            }
            // A folder reports its entries, not the data of its files, as in `kq`.
            // A file that grows would else reload its folder ten times a second.
            if change != Change::Entries {
                continue;
            }
            if let Some(parent) = p.parent().map(crate::paths::encode) {
                if inner.contains_key(&parent) {
                    hits.push((parent, false));
                }
            }
            if inner.contains_key(&key) {
                hits.push((key.clone(), false));
                gone.push((key, false));
            }
        }
        (hits, gone)
    }

    /// Why `hub_watch` refused a path. The watch limit is its own case: it
    /// fails every path, and the watches already out stay out.
    enum Refused {
        /// inotify's watch table is full (notify reports `MaxFilesWatch`).
        Limit,
        /// The path is gone, cannot be watched, or notify's loop is gone.
        Other(String),
    }

    impl std::fmt::Display for Refused {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Refused::Limit => write!(f, "inotify watch limit reached"),
                Refused::Other(e) => write!(f, "{e}"),
            }
        }
    }

    /// One round trip to notify's event loop. Its loop also stats on its own
    /// behalf and can stall minutes on a hung mount; callers keep locks off.
    fn hub_watch(key: &str) -> Result<(), Refused> {
        let added = catch_unwind(AssertUnwindSafe(|| {
            let mut hub = HUB.locked();
            hub.as_mut()
                .ok_or_else(|| Refused::Other("file watcher unavailable".into()))?
                .watch(&crate::paths::real(key), RecursiveMode::NonRecursive)
                .map_err(|e| {
                    if matches!(e.kind, notify::ErrorKind::MaxFilesWatch) {
                        Refused::Limit
                    } else {
                        Refused::Other(e.to_string())
                    }
                })
        }));
        // notify unwraps its round trip. If its loop died the unwrap panics,
        // and watching is over either way: mark it dead here, as a disconnected
        // channel would, instead of taking the caller down with it.
        match added {
            Ok(added) => added,
            Err(_) => {
                eprintln!("watcher: inotify thread stopped");
                DEAD.store(true, Ordering::Relaxed);
                Err(Refused::Other("file watcher stopped".into()))
            }
        }
    }

    /// Fails for a path with no watch. `notify` drops the watch of a deleted item itself.
    fn hub_unwatch(key: &str) {
        // Same round trip, same unwraps. Losing the reply is fine; if the loop died the
        // panic is not: mark it dead, as `hub_watch` does, instead of dying quietly.
        let done = catch_unwind(AssertUnwindSafe(|| {
            if let Some(hub) = HUB.locked().as_mut() {
                let _ = hub.unwatch(&crate::paths::real(key));
            }
        }));
        if done.is_err() {
            eprintln!("watcher: inotify thread stopped");
            DEAD.store(true, Ordering::Relaxed);
        }
    }

    fn is_regular(key: &str) -> bool {
        std::fs::metadata(crate::paths::real(key)).is_ok_and(|m| m.is_file())
    }

    /// Watch the file that is at the path now. Forget the path if there is none.
    /// Open with no lock held, as in `kq`: notify answers from its single event
    /// loop, a stalled volume can keep that busy for minutes, and `route` and
    /// every window's `apply_files` would else wait behind the files lock.
    fn rearm_file(state: &WatcherState, key: &str) {
        let Some(id) = state.files.locked().get(key).map(|w| w.id) else { return };
        let ok = is_regular(key) && hub_watch(key).is_ok();
        // Forget only what is still the entry this re-arm saw: a concurrent
        // `apply_files` can have replaced or taken it meanwhile.
        let forget = {
            let mut files = state.files.locked();
            let forget = files.get(key).is_some_and(|w| w.id == id) && !ok;
            if forget {
                files.remove(key);
            }
            forget
        };
        // The unwatch round trip runs with no lock, as the watch adds above. A
        // concurrent winner of the path gets its watch put back right after.
        if forget {
            hub_unwatch(key);
            if state.files.locked().contains_key(key) {
                let _ = hub_watch(key);
            }
        }
    }

    /// Keep the references so `rearm` can watch the next folder at this path.
    fn orphan(state: &WatcherState, key: &str) -> bool {
        // A renamed folder keeps its kernel watch. Its events would still name this path,
        // so a live watch is dropped — but the round trip to notify runs with no lock
        // held, as in the adds: a stalled volume must not park `route` behind it.
        let live = {
            let mut inner = state.inner.locked();
            let Some(w) = inner.get_mut(key) else { return false };
            let live = w.fd == LIVE;
            w.fd = ORPHAN;
            live
        };
        if live {
            hub_unwatch(key);
            // A re-arm that won the path meanwhile gets its watch put back.
            if state.inner.locked().get(key).is_some_and(|w| w.fd == LIVE) {
                let _ = hub_watch(key);
            }
        }
        true
    }

    fn has_orphans(state: &WatcherState) -> bool {
        state.inner.locked().values().any(|w| w.fd == ORPHAN)
    }

    /// Returns the paths of the folders it watches again.
    fn rearm(state: &WatcherState) -> Vec<String> {
        let orphans: Vec<String> = {
            let inner = state.inner.locked();
            inner.iter().filter(|(_, w)| w.fd == ORPHAN).map(|(p, _)| p.clone()).collect()
        };
        let mut back = Vec::new();
        for path in orphans {
            let is_dir = std::fs::metadata(crate::paths::real(&path)).is_ok_and(|m| m.is_dir());
            if super::is_ejecting(&path) || !is_dir || hub_watch(&path).is_err() {
                continue;
            }
            let mut inner = state.inner.locked();
            match inner.get_mut(&path) {
                Some(w) => {
                    w.fd = LIVE;
                    back.push(path);
                }
                // Released while the watch was added.
                None => hub_unwatch(&path),
            }
        }
        back
    }

    #[tauri::command(async)]
    pub fn watch_path(
        window: tauri::Window,
        state: tauri::State<'_, WatcherState>,
        path: String,
    ) -> Result<(), String> {
        if let Some(id) = add_watch(&state, path.clone())? {
            let mut owners = state.owners.locked();
            owners.entry(window.label().to_string()).or_default().push((path, id));
        }
        Ok(())
    }

    /// Returns the serial of the watch, or `None` if it took no reference.
    fn add_watch(state: &WatcherState, path: String) -> Result<Option<usize>, String> {
        if DEAD.load(Ordering::Relaxed) {
            return Err("file watcher stopped".to_string());
        }
        if super::is_ejecting(&path) {
            return Ok(None);
        }
        if let Some(w) = state.inner.locked().get_mut(&path) {
            w.refs += 1;
            return Ok(Some(w.serial));
        }
        // Add with no lock held. A stalled volume makes this slow.
        hub_watch(&path).map_err(|e| e.to_string())?;
        let mut inner = state.inner.locked();
        // Another call won. Both added the same kernel watch, so there is nothing to undo.
        if let Some(w) = inner.get_mut(&path) {
            w.refs += 1;
            return Ok(Some(w.serial));
        }
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        inner.insert(path, Watch { fd: LIVE, refs: 1, id, serial: id });
        Ok(Some(id))
    }

    #[tauri::command(async)]
    pub fn watch_files(
        window: tauri::Window,
        state: tauri::State<'_, WatcherState>,
        paths: Vec<String>,
    ) -> Result<(), String> {
        // Take the generation while the sets are locked. Calls then apply in order.
        let (gen, union) = {
            let mut sets = state.file_sets.locked();
            sets.insert(window.label().to_string(), paths);
            (next_files_gen(), union_of(&sets))
        };
        apply_files(&state, gen, union)
    }

    fn next_files_gen() -> u64 {
        FILES_GEN.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn union_of(sets: &HashMap<String, Vec<String>>) -> Vec<String> {
        let mut seen = HashSet::new();
        sets.values()
            .flatten()
            .filter(|p| seen.insert(p.as_str()))
            .cloned()
            .collect()
    }

    fn apply_files(state: &WatcherState, gen: u64, paths: Vec<String>) -> Result<(), String> {
        if HUB.locked().is_none() {
            return Err("file watcher unavailable".to_string());
        }
        if DEAD.load(Ordering::Relaxed) {
            return Err("file watcher stopped".to_string());
        }
        let wanted: Vec<String> = paths
            .into_iter()
            .filter(|p| !super::is_ejecting(p))
            .take(MAX_FILE_WATCHES)
            .collect();
        // Add before the lock. A slow volume then blocks no other call.
        // Files already watched are added again: a replaced file has a new inode, and
        // `notify` drops the watch of a file that its watched folder saw leave.
        // Regular files only, as in `kq`.
        let mut armed: HashSet<&str> = HashSet::new();
        // The watch limit is no one path's fault: it fails every add, and the
        // kernel watches already out stay out. Forgetting an entry it refused
        // would drop the bookkeeping of a live watch; the next round retries.
        let mut limited: HashSet<&str> = HashSet::new();
        for p in &wanted {
            if !is_regular(p) {
                continue;
            }
            match hub_watch(p) {
                Ok(()) => {
                    armed.insert(p.as_str());
                }
                Err(Refused::Limit) => {
                    limited.insert(p.as_str());
                }
                Err(Refused::Other(_)) => {}
            }
        }
        if !limited.is_empty() {
            eprintln!(
                "watcher: inotify watch limit reached, {} of {} files not watched",
                limited.len(),
                wanted.len()
            );
        }
        let stale_live: Vec<String> = {
            let mut files = state.files.locked();
            if gen < FILES_APPLIED.load(Ordering::Relaxed) {
                // A newer call owns the set. Take back what it does not hold — after
                // the lock is down: these are round trips too.
                let back: Vec<&str> = armed.iter().filter(|p| !files.contains_key(**p)).cloned().collect();
                drop(files);
                for p in back {
                    hub_unwatch(p);
                }
                return Ok(());
            }
            FILES_APPLIED.store(gen, Ordering::Relaxed);
            let keep: HashSet<&String> = wanted.iter().collect();
            let stale: Vec<String> = files.keys().filter(|k| !keep.contains(k)).cloned().collect();
            let mut stale_live = Vec::new();
            for k in stale {
                if let Some(w) = files.remove(&k) {
                    if w.fd == LIVE {
                        stale_live.push(k);
                    }
                }
            }
            for p in &wanted {
                if armed.contains(p.as_str()) {
                    if !files.contains_key(p) {
                        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
                        files.insert(p.clone(), Watch { fd: LIVE, refs: 1, id, serial: id });
                    }
                } else if !limited.contains(p.as_str()) {
                    // Gone or unwatchable for its own sake: forget it, as before.
                    files.remove(p);
                }
            }
            stale_live
        };
        // The unwatch round trips run with no lock, as the watch adds above. A
        // concurrent call that re-armed a path meanwhile gets its watch put back.
        for k in stale_live {
            hub_unwatch(&k);
            if state.files.locked().contains_key(&k) {
                let _ = hub_watch(&k);
            }
        }
        if !limited.is_empty() && armed.is_empty() {
            // The limit refused every path that is still there. Say so, so the
            // caller can tell a full failure from a quiet success.
            return Err("inotify watch limit reached".to_string());
        }
        Ok(())
    }

    pub fn release_under(state: &WatcherState, prefix: &str) -> usize {
        let under = |p: &str| p == prefix || p.starts_with(&format!("{prefix}/"));
        let mut dropped = 0;
        let mut live: Vec<String> = Vec::new();
        // Bookkeeping first, round trips after: the maps must not stay locked across
        // notify's replies. An ejecting volume takes no new watches, so nothing has
        // to be put back here.
        for map in [&state.inner, &state.files] {
            let mut m = map.locked();
            let gone: Vec<String> = m.keys().filter(|k| under(k)).cloned().collect();
            for k in gone {
                if let Some(w) = m.remove(&k) {
                    dropped += 1;
                    if w.fd == LIVE {
                        live.push(k);
                    }
                }
            }
        }
        for k in live {
            hub_unwatch(&k);
        }
        dropped
    }

    /// Watch again what `release_under` dropped. The volume stayed mounted.
    pub fn rewatch_under(state: &WatcherState, prefix: &str) {
        let under = |p: &str| p == prefix || p.starts_with(&format!("{prefix}/"));
        let held: Vec<(String, String, usize)> = state
            .owners
            .locked()
            .iter()
            .flat_map(|(w, held)| {
                held.iter().filter(|(p, _)| under(p)).map(move |(p, id)| (w.clone(), p.clone(), *id))
            })
            .collect();
        for (window, path, old) in held {
            // Add with no lock held. A stalled volume makes this slow.
            let Ok(Some(id)) = add_watch(state, path.clone()) else { continue };
            let mut owners = state.owners.locked();
            match owners.get_mut(&window).and_then(|h| h.iter_mut().find(|e| e.0 == path && e.1 == old)) {
                Some(entry) => entry.1 = id,
                // The window released it meanwhile.
                None => {
                    drop(owners);
                    release(state, &path, id);
                }
            }
        }
        let (gen, union) = (next_files_gen(), union_of(&state.file_sets.locked()));
        let _ = apply_files(state, gen, union);
    }

    #[tauri::command(async)]
    pub fn unwatch_path(window: tauri::Window, state: tauri::State<'_, WatcherState>, path: String) {
        let id = {
            let mut owners = state.owners.locked();
            let Some(held) = owners.get_mut(window.label()) else { return };
            let Some(i) = held.iter().position(|(p, _)| p == &path) else { return };
            held.swap_remove(i).1
        };
        release(&state, &path, id);
    }

    pub fn forget_window(state: &WatcherState, label: &str) {
        let held = state.owners.locked().remove(label).unwrap_or_default();
        for (path, id) in held {
            release(state, &path, id);
        }
        let next = {
            let mut sets = state.file_sets.locked();
            sets.remove(label).map(|_| (next_files_gen(), union_of(&sets)))
        };
        if let Some((gen, union)) = next {
            let _ = apply_files(state, gen, union);
        }
    }

    fn release(state: &WatcherState, path: &str, serial: usize) {
        let live = {
            let mut inner = state.inner.locked();
            let Some(w) = inner.get_mut(path).filter(|w| w.serial == serial) else { return };
            w.refs -= 1;
            if w.refs > 0 {
                return;
            }
            inner.remove(path).unwrap().fd == LIVE
        };
        // The unwatch round trip runs with no lock, as in the adds. A concurrent
        // add that won the path meanwhile gets its watch put back.
        if live {
            hub_unwatch(path);
            if state.inner.locked().contains_key(path) {
                let _ = hub_watch(path);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use notify::event::{CreateKind, DataChange, Flag, RemoveKind};

        #[test]
        fn a_stale_owner_does_not_release_a_newer_watch() {
            let state = WatcherState::default();
            state.inner.locked().insert("/x".into(), Watch { fd: ORPHAN, refs: 1, id: 7, serial: 7 });
            release(&state, "/x", 3);
            assert!(state.inner.locked().contains_key("/x"));
            release(&state, "/x", 7);
            assert!(state.inner.locked().is_empty());
        }

        #[test]
        fn opening_an_item_is_not_a_change() {
            assert_eq!(classify(&EventKind::Access(AccessKind::Open(AccessMode::Any))), None);
            assert_eq!(classify(&EventKind::Access(AccessKind::Close(AccessMode::Read))), None);
            assert_eq!(
                classify(&EventKind::Access(AccessKind::Close(AccessMode::Write))),
                Some(Change::Content)
            );
            assert_eq!(classify(&EventKind::Create(CreateKind::File)), Some(Change::Entries));
        }

        fn watch() -> Watch {
            Watch { fd: ORPHAN, refs: 1, id: 1, serial: 1 }
        }

        #[test]
        fn an_overflow_reports_watched_files_too() {
            let state = WatcherState::default();
            state.inner.locked().insert("/d".into(), watch());
            state.files.locked().insert("/d/f".into(), watch());
            let ev = notify::Event::new(EventKind::Other).set_flag(Flag::Rescan);
            let (mut hits, gone) = route(&state, &ev);
            hits.sort();
            assert_eq!(hits, [("/d".to_string(), false), ("/d/f".to_string(), true)]);
            assert!(gone.is_empty());
        }

        #[test]
        fn a_rearm_drains_the_events_that_queued_before_it() {
            let state = WatcherState::default();
            state.inner.locked().insert("/d".into(), watch());
            state.files.locked().insert("/d/f".into(), watch());
            let (tx, rx) = std::sync::mpsc::channel();
            tx.send(Ok(notify::Event::new(EventKind::Create(CreateKind::Folder)).add_path("/d/new".into())))
                .unwrap();
            tx.send(Ok(notify::Event::new(EventKind::Remove(RemoveKind::File)).add_path("/d/f".into())))
                .unwrap();

            let mut pending = HashSet::new();
            let mut deadline = None;
            let mut rearm_at = None;
            drain_queued(&rx, &state, &mut pending, &mut deadline, &mut rearm_at);

            // The create reports the folder, the remove forgets the file, and
            // both are out of the channel before a re-arm adds a fresh watch.
            assert_eq!(
                pending,
                HashSet::from([("/d".to_string(), false), ("/d/f".to_string(), true)])
            );
            assert!(state.files.locked().is_empty());
            assert!(deadline.is_some());
        }

        #[test]
        fn a_panic_in_a_round_marks_the_watcher_dead() {
            let (tx, rx) = std::sync::mpsc::channel();
            let state = WatcherState::default();
            state.files.locked().insert("/p".into(), watch());
            tx.send(Ok(notify::Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any)))
                .add_path("/p".into())))
            .unwrap();
            // The panic must be contained in `run`: the thread ends normally
            // instead of unwinding out, and DEAD is set so callers give up.
            let thread = std::thread::spawn(move || run(rx, &state, |_, _| panic!("emit blew up")));
            thread.join().unwrap();
            assert!(DEAD.load(Ordering::Relaxed));
            DEAD.store(false, Ordering::Relaxed);
        }

        #[test]
        fn a_folder_reports_its_entries_and_a_file_its_data() {
            let state = WatcherState::default();
            state.inner.locked().insert("/d".into(), watch());
            state.files.locked().insert("/d/f".into(), watch());
            let ev = |kind| notify::Event::new(kind).add_path("/d/f".into());

            let (hits, gone) = route(&state, &ev(EventKind::Modify(ModifyKind::Data(DataChange::Any))));
            assert_eq!(hits, [("/d/f".to_string(), true)]);
            assert!(gone.is_empty());

            let (hits, gone) = route(&state, &ev(EventKind::Remove(RemoveKind::File)));
            assert_eq!(hits, [("/d/f".to_string(), true), ("/d".to_string(), false)]);
            assert_eq!(gone, [("/d/f".to_string(), true)]);

            let own = notify::Event::new(EventKind::Remove(RemoveKind::Folder)).add_path("/d".into());
            assert_eq!(route(&state, &own).1, [("/d".to_string(), false)]);
        }

        /// Waits for one event. Others before it are skipped.
        fn saw(rx: &Receiver<(String, String)>, event: &str, path: &str) -> bool {
            let end = Instant::now() + Duration::from_secs(5);
            while let Ok(got) = rx.recv_timeout(end.saturating_duration_since(Instant::now())) {
                if got.0 == event && got.1 == path {
                    return true;
                }
            }
            false
        }

        #[test]
        fn changes_on_disk_reach_the_webview() {
            let dir = std::env::temp_dir().join(format!("doftar-ino-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.to_str().unwrap().to_string();
            let file = format!("{path}/f");
            std::fs::write(&file, b"x").unwrap();

            let state: &'static WatcherState = Box::leak(Box::default());
            let events = start_hub().unwrap();
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                run(events, state, |e, p| {
                    let _ = tx.send((e.to_string(), p.to_string()));
                })
            });

            let serial = add_watch(state, path.clone()).unwrap().unwrap();
            apply_files(state, next_files_gen(), vec![file.clone()]).unwrap();

            // Reading must stay silent, or a reload would cause the next reload.
            let _ = std::fs::read_dir(&dir).unwrap().count();
            let _ = std::fs::read(&file).unwrap();
            assert!(rx.recv_timeout(Duration::from_millis(400)).is_err());

            std::fs::write(&file, b"more").unwrap();
            assert!(saw(&rx, "fs:file", &file));
            std::fs::write(dir.join("new"), b"x").unwrap();
            assert!(saw(&rx, "fs:changed", &path));

            // A new file at the path of a watched one, as an editor saves.
            std::fs::write(dir.join("tmp"), b"replaced").unwrap();
            std::fs::rename(dir.join("tmp"), &file).unwrap();
            assert!(saw(&rx, "fs:file", &file));
            while rx.recv_timeout(Duration::from_millis(400)).is_ok() {}
            std::fs::write(&file, b"again").unwrap();
            assert!(saw(&rx, "fs:file", &file));

            std::fs::remove_dir_all(&dir).unwrap();
            assert!(saw(&rx, "fs:changed", &path));
            assert!(has_orphans(state));
            std::fs::create_dir(&dir).unwrap();
            // The re-arm reports the folder.
            assert!(saw(&rx, "fs:changed", &path));
            assert!(!has_orphans(state));
            while rx.recv_timeout(Duration::from_millis(400)).is_ok() {}
            std::fs::write(dir.join("later"), b"x").unwrap();
            assert!(saw(&rx, "fs:changed", &path));

            release(state, &path, serial);
            assert!(state.inner.locked().is_empty());
            while rx.recv_timeout(Duration::from_millis(400)).is_ok() {}
            std::fs::write(dir.join("unseen"), b"x").unwrap();
            assert!(rx.recv_timeout(Duration::from_millis(400)).is_err());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
