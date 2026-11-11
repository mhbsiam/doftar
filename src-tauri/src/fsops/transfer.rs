//! Copy and move: partial files, name claims, conflicts and the transfer jobs.

use crate::lock::Locked;
use super::*;

pub(super) static PARTIAL_SEQ: AtomicU64 = AtomicU64::new(0);

pub(crate) fn partial_path(dir: &Path) -> PathBuf {
    note_partial_dir(dir);
    let n = PARTIAL_SEQ.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".wf-partial-{}-{n}", std::process::id()))
}

/// Lists the folders that got a partial copy in the run with process id `pid`.
pub(super) fn partial_journal(pid: u32) -> Option<PathBuf> {
    crate::thumbs::cache_root().map(|r| r.join("partials").join(pid.to_string()))
}

/// A crash or force quit leaves partial copies behind. The next launch finds them through this list.
pub(super) fn note_partial_dir(dir: &Path) {
    use std::io::Write;
    static NOTED: std::sync::Mutex<std::collections::BTreeSet<PathBuf>> =
        std::sync::Mutex::new(std::collections::BTreeSet::new());
    let mut noted = NOTED.locked();
    if cfg!(test) || !noted.insert(dir.to_path_buf()) {
        return;
    }
    let Some(journal) = partial_journal(std::process::id()) else { return };
    let _ = journal.parent().map(fs::create_dir_all);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&journal) {
        let _ = f.write_all(&[dir.as_os_str().as_bytes(), b"\n"].concat());
    }
}

/// Removes the partial copies of earlier runs that ended without cleaning up.
// shortcut: a folder on a drive that isn't mounted at launch keeps its leftover, journal entries aren't retried.
pub fn sweep_stale_partials() {
    if let Some(dir) = partial_journal(0).and_then(|j| j.parent().map(Path::to_path_buf)) {
        sweep_journals(&dir);
    }
}

pub(super) fn sweep_journals(dir: &Path) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for journal in rd.flatten() {
        let Some(pid) = journal.file_name().to_str().and_then(|n| n.parse::<i32>().ok()) else { continue };
        // A live pid may be another Doftar that is still copying.
        let alive = unsafe { libc::kill(pid, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        if pid as u32 == std::process::id() || alive {
            continue;
        }
        let prefix = format!(".wf-partial-{pid}-");
        for line in fs::read(journal.path()).unwrap_or_default().split(|&b| b == b'\n') {
            let Ok(items) = fs::read_dir(std::ffi::OsStr::from_bytes(line)) else { continue };
            for item in items.flatten() {
                if item.file_name().as_bytes().starts_with(prefix.as_bytes()) {
                    remove_path(&item.path());
                }
            }
        }
        let _ = fs::remove_file(journal.path());
    }
}

pub(super) fn copy_to_unique(
    from: &Path,
    dest_dir: &Path,
    name: &str,
    job: &Job,
) -> Result<PathBuf, String> {
    let plain_dir = is_plain_dir(from);
    // Copy to a hidden name, then claim a free one. An "already exists" error inside the tree is then a real error.
    let partial = partial_path(dest_dir);
    if let Err(e) = copy_item(from, &partial, job) {
        remove_path(&partial);
        return Err(strerr(e));
    }
    claim_name(&partial, dest_dir, name, plain_dir).map_err(|e| {
        remove_path(&partial);
        strerr(e)
    })
}

/// Renames `from` into `dest_dir` as `name`, or the first free "name_copy_N".
/// Never overwrites an item, even one that arrives meanwhile.
pub(super) fn claim_name(from: &Path, dest_dir: &Path, name: &str, plain_dir: bool) -> std::io::Result<PathBuf> {
    let mut n = 0usize;
    loop {
        let candidate = dest_dir.join(copy_candidate(name, n, plain_dir));
        n += 1;
        match rename_excl(from, &candidate) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
}

/// Renames `from` to `to` in one step, only if nothing is at `to`.
pub(crate) fn rename_excl(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let c = |p: &Path| {
        std::ffi::CString::new(p.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))
    };
    let (f, t) = (c(from)?, c(to)?);
    if unsafe { libc::renamex_np(f.as_ptr(), t.as_ptr(), libc::RENAME_EXCL) } == 0 {
        return Ok(());
    }
    let err = std::io::Error::last_os_error();
    match err.raw_os_error() {
        Some(libc::ENOTSUP) | Some(libc::EINVAL) => rename_claimed(from, to),
        _ => Err(err),
    }
}

/// `rename_excl` for volumes without RENAME_EXCL (some SMB, exFAT).
/// Claim `to` first with a step that fails if `to` exists: a hard link for a file,
/// an empty folder for a folder. A rename replaces only an empty folder.
pub(super) fn rename_claimed(from: &Path, to: &Path) -> std::io::Result<()> {
    let kind = fs::symlink_metadata(from)?.file_type();
    if kind.is_dir() {
        fs::create_dir(to)?;
        return fs::rename(from, to).inspect_err(|_| {
            let _ = fs::remove_dir(to);
        });
    }
    if kind.is_file() {
        match fs::hard_link(from, to) {
            Ok(()) => {
                return fs::remove_file(from).inspect_err(|_| {
                    let _ = fs::remove_file(to);
                })
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Err(e),
            Err(_) => {}
        }
    }
    // shortcut: a link, or a file on a volume without hard links, uses check-then-rename. It can race.
    if exists(to) {
        return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
    }
    fs::rename(from, to)
}

pub(super) struct Moved {
    pub(super) to: PathBuf,
    pub(super) leftover: Option<Leftover>,
    pub(super) trashed_old: Option<String>,
}

/// A cross-volume move whose copy landed but whose original could not be removed.
pub(super) struct Leftover {
    warning: String,
    /// False when removing a folder stopped partway. The copy is then the only complete version.
    original_intact: bool,
}

/// What `make_room` did with the replaced item: nothing, or kept in the Trash or set aside, for undo.
pub(super) enum Room {
    Empty,
    Kept(String),
}

impl Room {
    /// Returns where the old item went, for undo.
    fn settle(self) -> Option<String> {
        match self {
            Room::Kept(p) => Some(p),
            Room::Empty => None,
        }
    }
}

pub(super) static ASIDE_SEQ: AtomicU64 = AtomicU64::new(0);
pub(super) const ASIDE_MARK: &str = ".doftar-aside-";

/// True for a name made by `set_aside`. `discard_asides` removes only these.
pub(crate) fn is_aside_name(name: &str) -> bool {
    name.starts_with('.') && name.contains(ASIDE_MARK)
}

/// Moves `p` to a hidden name beside it, on a volume with no Trash, so undo can restore it.
/// The name is unique across restarts. `discard_asides` removes it later.
pub(super) fn set_aside(p: &Path) -> std::io::Result<PathBuf> {
    let dir = p.parent().unwrap_or(Path::new("/"));
    let stamp = unix_ms(Ok(std::time::SystemTime::now()));
    loop {
        let n = ASIDE_SEQ.fetch_add(1, Ordering::Relaxed);
        let aside = dir.join(format!(".{}{ASIDE_MARK}{stamp}-{n}", label(p)));
        match rename_excl(p, &aside) {
            Ok(()) => return Ok(aside),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
}

pub(super) fn make_room(to: &Path, replace: bool) -> Result<Room, String> {
    if !(replace && exists(to)) {
        return Ok(Room::Empty);
    }
    match trash_one(&path_str(to)) {
        Ok(Some(t)) => Ok(Room::Kept(t)),
        Ok(None) => Ok(Room::Empty),
        Err(e) if e == NO_TRASH => Ok(Room::Kept(path_str(&set_aside(to).map_err(strerr)?))),
        Err(e) => Err(e),
    }
}

/// Puts back the item `make_room` moved off `to`.
/// If something else took its place, the item stays in the Trash or beside it.
pub(super) fn restore_room(to: &Path, room: Room) {
    if let Room::Kept(p) = room {
        let _ = rename_excl(Path::new(&p), to);
    }
}

/// Deletes `set_aside` items after the undo history forgets them. Ignores other paths.
#[tauri::command(async)]
pub fn discard_asides(paths: Vec<String>) {
    for p in paths {
        let p = Path::new(&p);
        if is_aside_name(&label(p)) && guard::check(p).is_ok() {
            remove_path(p);
        }
    }
}

pub(super) fn move_item(
    from: &Path,
    dest_dir: &Path,
    name: &str,
    job: &Job,
    force_cross_volume: bool,
    replace: bool,
) -> Result<Moved, String> {
    let is_dir = fs::symlink_metadata(from).map(|m| m.is_dir()).unwrap_or(false);
    let plain_dir = is_plain_dir(from);
    // Put the item at its name, never over an item that arrived meanwhile.
    // With `replace`, move the old item off first.
    let land = |item: &Path| -> std::io::Result<(PathBuf, Room)> {
        if !replace {
            return claim_name(item, dest_dir, name, plain_dir).map(|to| (to, Room::Empty));
        }
        let to = dest_dir.join(name);
        let room = make_room(&to, true).map_err(std::io::Error::other)?;
        match rename_excl(item, &to) {
            Ok(()) => Ok((to, room)),
            Err(e) => {
                restore_room(&to, room);
                Err(e)
            }
        }
    };
    if !force_cross_volume {
        match land(from) {
            Ok((to, room)) => {
                return Ok(Moved {
                    to,
                    leftover: None,
                    trashed_old: room.settle(),
                })
            }
            Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {}
            Err(e) => return Err(strerr(e)),
        }
    }
    let partial = partial_path(dest_dir);
    let original = match copy_verified(from, &partial, job) {
        Ok(rev) => rev,
        Err(e) => {
            remove_path(&partial);
            return Err(strerr(e));
        }
    };
    let (to, room) = land(&partial).map_err(|e| {
        remove_path(&partial);
        strerr(e)
    })?;
    // A failed folder removal can leave part of the contents.
    let leftover = if tree_revision(from).ok().as_ref() != Some(&original) {
        Some(Leftover {
            warning: format!("\"{name}\": copied, but the original changed meanwhile, so it was kept too"),
            original_intact: true,
        })
    } else {
        remove_path_checked(from).err().map(|e| Leftover {
            warning: if is_dir {
                format!(
                    "\"{name}\": copied, but removing the original stopped partway ({e}). \
                     The copy is complete; what's left of the original is still where it was"
                )
            } else {
                format!("\"{name}\": copied, but the original couldn't be removed ({e})")
            },
            original_intact: !is_dir,
        })
    };
    Ok(Moved {
        to,
        leftover,
        trashed_old: room.settle(),
    })
}

pub(super) fn copy_replacing(
    from: &Path,
    dest_dir: &Path,
    name: &str,
    job: &Job,
) -> Result<(PathBuf, Option<String>), String> {
    let to = dest_dir.join(name);
    let partial = partial_path(dest_dir);
    if let Err(e) = copy_item(from, &partial, job) {
        remove_path(&partial);
        return Err(strerr(e));
    }
    let trashed = match make_room(&to, true) {
        Ok(t) => t,
        Err(e) => {
            remove_path(&partial);
            return Err(e);
        }
    };
    if let Err(e) = rename_excl(&partial, &to) {
        remove_path(&partial);
        restore_room(&to, trashed);
        return Err(strerr(e));
    }
    Ok((to, trashed.settle()))
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Resolution {
    Replace,
    Skip,
    KeepBoth,
}

pub type Resolutions = HashMap<String, Resolution>;

/// Names one transfer already put into its destination.
/// A second source with the same name must not replace the first arrival,
/// or undo restores the wrong item. It keeps both instead.
#[derive(Default)]
pub(super) struct Placed(std::collections::HashSet<String>);

impl Placed {
    /// Fold case. APFS and HFS+ are case-insensitive by default.
    fn key(name: &str) -> String {
        name.to_lowercase()
    }

    fn add(&mut self, arrived: &Path) {
        self.0.insert(Self::key(&label(arrived)));
    }

    fn guard(&self, name: &str, decision: Resolution) -> Resolution {
        if decision == Resolution::Replace && self.0.contains(&Self::key(name)) {
            Resolution::KeepBoth
        } else {
            decision
        }
    }
}

pub(super) fn decide(from: &Path, dest: &Path, name: &str, resolutions: &Resolutions) -> Resolution {
    if !exists(&dest.join(name)) || same_dir(from.parent(), dest) {
        return Resolution::KeepBoth;
    }
    resolutions
        .get(&path_str(from))
        .copied()
        .unwrap_or(Resolution::KeepBoth)
}

pub(super) fn copy_one(
    src: &str,
    dest: &Path,
    job: &Job,
    res: &mut OpResult,
    resolutions: &Resolutions,
    placed: &mut Placed,
) {
    let from = Path::new(src);
    let Some(name) = from.file_name().map(|s| s.to_string_lossy().to_string()) else {
        res.errors.push(format!("invalid source path: {src}"));
        job.item_done();
        return;
    };
    if is_within_subtree(from, dest) {
        res.errors
            .push(format!("Can't put \"{name}\" into itself or its own subfolder"));
        job.item_done();
        return;
    }
    let decision = placed.guard(&name, decide(from, dest, &name, resolutions));
    if decision == Resolution::Skip {
        job.item_done();
        return;
    }
    if decision == Resolution::Replace && holds_item(&dest.join(&name), from) {
        res.errors
            .push(format!("Can't replace \"{name}\" with an item inside it"));
        job.item_done();
        return;
    }
    job.set_current(&name);
    let done = if decision == Resolution::Replace {
        copy_replacing(from, dest, &name, job).map(|(p, trashed)| {
            placed.add(&p);
            let mut undo = vec![Step::trash(path_str(&p))];
            if let Some(old) = trashed {
                undo.push(Step::moved(old, path_str(&p)));
            }
            undo
        })
    } else {
        copy_to_unique(from, dest, &name, job).map(|p| {
            placed.add(&p);
            vec![Step::trash(path_str(&p))]
        })
    };
    match done {
        Ok(undo) => res.inverse.extend(undo),
        Err(_) if job.cancelled() => res.cancelled = true,
        Err(e) => res.errors.push(format!("\"{name}\": {e}")),
    }
    job.item_done();
}

pub(super) fn move_one(
    src: &str,
    dest: &Path,
    job: &Job,
    res: &mut OpResult,
    force_cross_volume: bool,
    resolutions: &Resolutions,
    placed: &mut Placed,
) {
    let from = Path::new(src);
    let Some(name) = from.file_name().map(|s| s.to_string_lossy().to_string()) else {
        res.errors.push(format!("invalid source path: {src}"));
        job.item_done();
        return;
    };
    if is_within_subtree(from, dest) {
        res.errors
            .push(format!("Can't move \"{name}\" into itself or its own subfolder"));
        job.item_done();
        return;
    }
    if same_dir(from.parent(), dest) {
        job.item_done();
        return;
    }
    if let Err(e) = guard::check(from) {
        res.errors.push(format!("\"{name}\": {e}"));
        job.item_done();
        return;
    }
    let decision = placed.guard(&name, decide(from, dest, &name, resolutions));
    if decision == Resolution::Skip {
        job.item_done();
        return;
    }
    if decision == Resolution::Replace && holds_item(&dest.join(&name), from) {
        res.errors
            .push(format!("Can't replace \"{name}\" with an item inside it"));
        job.item_done();
        return;
    }
    job.set_current(&name);
    match move_item(
        from,
        dest,
        &name,
        job,
        force_cross_volume,
        decision == Resolution::Replace,
    ) {
        Ok(Moved {
            to,
            leftover: None,
            trashed_old,
        }) => {
            placed.add(&to);
            res.inverse.push(Step::moved(path_str(&to), src.to_string()));
            if let Some(old) = trashed_old {
                res.inverse.push(Step::moved(old, path_str(&to)));
            }
        }
        Ok(Moved {
            to,
            leftover: Some(left),
            trashed_old,
        }) => {
            // The copy landed but the original stayed. Undo removes the copy and restores the replaced item,
            // only while the original is whole. After a partial folder removal the copy stays.
            placed.add(&to);
            res.errors.push(left.warning);
            if left.original_intact {
                res.inverse.push(Step::trash(path_str(&to)));
                if let Some(old) = trashed_old {
                    res.inverse.push(Step::moved(old, path_str(&to)));
                }
            }
        }
        Err(_) if job.cancelled() => res.cancelled = true,
        Err(e) => res.errors.push(format!("\"{name}\": {e}")),
    }
    job.item_done();
}

#[derive(Clone, Copy)]
pub(super) enum Mode {
    Copy,
    Move,
    Drop { force_copy: bool },
}

pub(super) fn run_transfer(
    sources: &[String],
    dest_dir: &str,
    mode: Mode,
    resolutions: &Resolutions,
    job: &JobGuard,
) -> OpResult {
    let dest = Path::new(dest_dir);
    let copies = |s: &str| match mode {
        Mode::Copy => true,
        Mode::Move => false,
        Mode::Drop { force_copy } => force_copy || !on_same_volume(Path::new(s), dest),
    };
    let heavy: Vec<String> = sources
        .iter()
        .filter(|s| copies(s) || !on_same_volume(Path::new(s), dest))
        .cloned()
        .collect();
    job.set_items_total(sources.len());
    jobs::start_scan(job, heavy, Some(dest));
    let mut res = OpResult::default();
    let mut placed = Placed::default();
    for src in sources {
        job.wait_while_paused();
        if job.cancelled() {
            res.cancelled = true;
            break;
        }
        if copies(src) {
            copy_one(src, dest, job, &mut res, resolutions, &mut placed);
        } else {
            move_one(src, dest, job, &mut res, false, resolutions, &mut placed);
        }
        if res.cancelled {
            break;
        }
    }
    // A job that stopped itself failed. It was not cancelled by the user.
    if let Some(why) = job.abort_reason() {
        res.cancelled = false;
        res.errors.push(why);
    }
    res
}

#[tauri::command]
pub async fn copy_paths(
    sources: Vec<String>,
    dest_dir: String,
    resolutions: Resolutions,
    verify: bool,
    job_id: u64,
    on_progress: Channel<Progress>,
) -> Result<OpResult, String> {
    jobs::blocking(move || {
        let job = jobs::begin(job_id, on_progress);
        job.set_verify(verify);
        run_transfer(&sources, &dest_dir, Mode::Copy, &resolutions, &job)
    })
    .await
}

#[tauri::command]
pub async fn move_paths(
    sources: Vec<String>,
    dest_dir: String,
    resolutions: Resolutions,
    verify: bool,
    job_id: u64,
    on_progress: Channel<Progress>,
) -> Result<OpResult, String> {
    jobs::blocking(move || {
        let job = jobs::begin(job_id, on_progress);
        job.set_verify(verify);
        run_transfer(&sources, &dest_dir, Mode::Move, &resolutions, &job)
    })
    .await
}

pub(super) fn on_same_volume(src: &Path, dest: &Path) -> bool {
    match (fs::symlink_metadata(src), fs::metadata(dest)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev(),
        _ => false,
    }
}

#[tauri::command(async)]
pub fn drop_moves(sources: Vec<String>, dest_dir: String) -> bool {
    let dest = Path::new(&dest_dir);
    !sources.is_empty() && sources.iter().all(|s| on_same_volume(Path::new(s), dest))
}

#[tauri::command(async)]
pub fn drop_plan(sources: Vec<String>, dest_dir: String) -> Vec<bool> {
    let dest = Path::new(&dest_dir);
    sources
        .iter()
        .map(|s| on_same_volume(Path::new(s), dest))
        .collect()
}

#[tauri::command]
pub async fn transfer_paths(
    sources: Vec<String>,
    dest_dir: String,
    force_copy: bool,
    resolutions: Resolutions,
    verify: bool,
    job_id: u64,
    on_progress: Channel<Progress>,
) -> Result<OpResult, String> {
    jobs::blocking(move || {
        let job = jobs::begin(job_id, on_progress);
        job.set_verify(verify);
        run_transfer(&sources, &dest_dir, Mode::Drop { force_copy }, &resolutions, &job)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSide {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub source: ConflictSide,
    pub existing: ConflictSide,
    pub can_replace: bool,
}

pub(super) fn conflict_side(p: &Path) -> Option<ConflictSide> {
    let meta = fs::metadata(p).or_else(|_| fs::symlink_metadata(p)).ok()?;
    Some(ConflictSide {
        path: path_str(p),
        name: label(p),
        is_dir: meta.is_dir(),
        size: if meta.is_dir() { 0 } else { meta.len() },
        modified_ms: unix_ms(meta.modified()),
    })
}

#[tauri::command(async)]
pub fn find_conflicts(sources: Vec<String>, dest_dir: String) -> Vec<Conflict> {
    let dest = Path::new(&dest_dir);
    sources
        .iter()
        .filter_map(|s| {
            let from = Path::new(s);
            let name = from.file_name()?;
            let target = dest.join(name);
            if !exists(&target) || same_dir(from.parent(), dest) {
                return None;
            }
            let source = conflict_side(from)?;
            let existing = conflict_side(&target)?;
            let can_replace =
                source.is_dir == existing.is_dir && !holds_item(&target, from);
            Some(Conflict {
                source,
                existing,
                can_replace,
            })
        })
        .collect()
}

