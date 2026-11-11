use crate::lock::Locked;
use std::collections::HashMap;
use std::sync::Mutex;

#[cfg(target_os = "macos")]
pub use kq::*;

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

#[cfg(not(target_os = "macos"))]
pub fn init(_app: tauri::AppHandle) {}

#[cfg(not(target_os = "macos"))]
#[tauri::command(async)]
pub fn watch_path(
    _window: tauri::Window,
    _state: tauri::State<'_, WatcherState>,
    _path: String,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command(async)]
pub fn watch_files(
    _window: tauri::Window,
    _state: tauri::State<'_, WatcherState>,
    _paths: Vec<String>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command(async)]
pub fn unwatch_path(_window: tauri::Window, _state: tauri::State<'_, WatcherState>, _path: String) {}

#[cfg(not(target_os = "macos"))]
pub fn forget_window(_state: &WatcherState, _label: &str) {}

#[cfg(not(target_os = "macos"))]
pub fn rewatch_under(_state: &WatcherState, _prefix: &str) {}

#[cfg(not(target_os = "macos"))]
pub fn release_under(_state: &WatcherState, _prefix: &str) -> usize {
    0
}
