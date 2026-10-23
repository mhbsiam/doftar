//! Compress and extract with the tools macOS ships (`ditto`, `tar`), so
//! archives match what Finder makes and opens.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

use crate::fsops::{is_plain_dir, label, partial_path, path_str, split_ext, unique_name};
use crate::jobs::{self, Job, OpResult, Progress, Step};
use crate::quarantine;

enum RunError {
    Cancelled,
    Failed(String),
}

/// Runs `cmd` to completion, killing it if the job is cancelled.
fn run_cancellable(cmd: Command, job: &Job) -> Result<(), RunError> {
    run_watched(cmd, job, || None)
}

/// `run_cancellable`, also killing `cmd` when `watch`, asked every tick
/// while it runs, gives a reason to stop.
fn run_watched(
    mut cmd: Command,
    job: &Job,
    mut watch: impl FnMut() -> Option<String>,
) -> Result<(), RunError> {
    let mut child = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| RunError::Failed(e.to_string()))?;
    // Drained as it arrives: a child that writes more than the pipe holds
    // would otherwise block forever while we poll for its exit.
    let stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut msg = String::new();
        if let Some(mut err) = stderr {
            let _ = err.read_to_string(&mut msg);
        }
        msg
    });
    loop {
        if job.cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(RunError::Cancelled);
        }
        if let Some(reason) = watch() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(RunError::Failed(reason));
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                let msg = reader.join().unwrap_or_default();
                let msg = msg.trim();
                return Err(RunError::Failed(if msg.is_empty() {
                    format!("exited with {status}")
                } else {
                    msg.to_string()
                }));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(RunError::Failed(e.to_string())),
        }
    }
}

fn remove_any(p: &Path) {
    match fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => {
            let _ = fs::remove_dir_all(p);
        }
        Ok(_) => {
            let _ = fs::remove_file(p);
        }
        Err(_) => {}
    }
}

fn fail(res: &mut OpResult, what: &Path, err: RunError) {
    match err {
        RunError::Cancelled => res.cancelled = true,
        RunError::Failed(msg) => res.errors.push(format!("\"{}\": {msg}", label(what))),
    }
}

/// Zips `paths` next to the first one: `Name.zip` for a single item,
/// `Archive.zip` for several. Undo trashes the new archive.
pub fn compress_sync(paths: &[String], job: &Job) -> OpResult {
    let mut res = OpResult::default();
    let Some(first) = paths.first().map(Path::new) else {
        return res;
    };
    let Some(dir) = first.parent() else {
        res.errors.push(format!("\"{}\": has no parent folder", label(first)));
        return res;
    };
    let name = if paths.len() == 1 { label(first) } else { "Archive".to_string() };
    job.set_items_total(1);
    job.set_current(&name);

    let partial = partial_path(dir);
    let mut stage: Option<PathBuf> = None;
    let mut cmd = Command::new("/usr/bin/ditto");
    cmd.args(["-c", "-k", "--sequesterRsrc"]);
    if paths.len() == 1 {
        // For a folder, --keepParent keeps its own name at the archive root;
        // for a plain file it would add the containing folder, so skip it.
        if first.is_dir() {
            cmd.arg("--keepParent");
        }
        cmd.arg(first);
    } else {
        // ditto takes one source, so gather the items (cloned, not copied,
        // where the volume allows) under a staging folder first.
        let staging = partial_path(dir);
        if let Err(e) = fs::create_dir(&staging) {
            res.errors.push(format!("\"{name}\": {e}"));
            return res;
        }
        for p in paths {
            let src = Path::new(p);
            let target = staging.join(label(src));
            if fs::symlink_metadata(&target).is_ok() {
                res.errors.push(format!("\"{}\": another item has the same name", label(src)));
                remove_any(&staging);
                return res;
            }
            // Copying a big folder takes a while, so a cancel stops it too.
            let mut cp = Command::new("/bin/cp");
            cp.arg("-cR").arg(src).arg(&target);
            if let Err(e) = run_cancellable(cp, job) {
                remove_any(&staging);
                match e {
                    RunError::Cancelled => res.cancelled = true,
                    RunError::Failed(_) => {
                        res.errors.push(format!("\"{}\": couldn't be read", label(src)))
                    }
                }
                return res;
            }
        }
        cmd.arg(&staging);
        stage = Some(staging);
    }
    cmd.arg(&partial);

    let outcome = run_cancellable(cmd, job);
    if let Some(s) = &stage {
        remove_any(s);
    }
    match outcome {
        Ok(()) => {
            match place_unique(&partial, dir, &name, ".zip") {
                Ok(final_path) => res.inverse.push(Step::trash(path_str(&final_path))),
                Err(e) => {
                    remove_any(&partial);
                    res.errors.push(format!("\"{name}\": {e}"));
                }
            }
        }
        Err(e) => {
            remove_any(&partial);
            fail(&mut res, first, e);
        }
    }
    job.item_done();
    res
}

/// Everything macOS's own `tar` (libarchive) reads, so no extra unarchiver is
/// needed: tarballs, 7-Zip, RAR (including RAR 5), disk-image ISOs, Windows
/// cabinets, XAR, cpio and LHA. Longer suffixes come first for `archive_stem`.
const TAR_SUFFIXES: [&str; 15] = [
    ".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".tbz2", ".txz", ".tar",
    ".7z", ".rar", ".iso", ".cab", ".xar", ".cpio", ".lzh", ".lha",
];

/// Whether `extract_sync` can open a file with this name.
pub fn is_extractable(name: &str) -> bool {
    let n = name.to_lowercase();
    n.ends_with(".zip") || TAR_SUFFIXES.iter().any(|s| n.ends_with(s))
}

/// Whether an archive entry name could land outside the extraction folder.
fn escapes_destination(entry: &str) -> bool {
    entry.starts_with('/') || entry.split('/').any(|part| part == "..")
}

/// An entry name as the folder it lands in sees it: no leading "./" or
/// trailing "/", and case-folded, as APFS is case-insensitive by default.
fn entry_key(entry: &str) -> String {
    let mut e = entry;
    while let Some(rest) = e.strip_prefix("./") {
        e = rest;
    }
    e.trim_end_matches('/').to_lowercase()
}

/// Whether an entry would be written inside a symlink the archive itself
/// makes (`link -> /etc`, then `link/payload`), which would carry it out of
/// the extraction folder whatever its name says.
fn writes_through_symlink(names: &[&str], is_link: &[bool]) -> bool {
    let links: std::collections::HashSet<String> = names
        .iter()
        .zip(is_link)
        .filter(|(_, &l)| l)
        .map(|(n, _)| entry_key(n))
        .collect();
    !links.is_empty()
        && names.iter().any(|n| {
            let key = entry_key(n);
            let parts: Vec<&str> = key.split('/').collect();
            (1..parts.len()).any(|i| links.contains(&parts[..i].join("/")))
        })
}

fn listing(cmd: &mut Command) -> Option<String> {
    match cmd.output() {
        Ok(out) if out.status.success() => Some(String::from_utf8_lossy(&out.stdout).into_owned()),
        _ => None,
    }
}

/// Whether any entry in `archive` lands outside its own folder, by its name
/// or by way of a symlink entry. Zips are listed with `unzip`, everything else
/// with `tar` (libarchive reads the same formats it extracts); the long
/// listing, line for line the same entries, says which are symlinks (`l`).
/// A listing that fails or doesn't line up is treated as unsafe.
fn lists_escaping_entries(archive: &Path, zip: bool) -> bool {
    let (names, long) = if zip {
        (
            listing(Command::new("/usr/bin/unzip").arg("-Z1").arg(archive)),
            // With a pattern, zipinfo prints only the entry lines.
            listing(Command::new("/usr/bin/unzip").arg("-Zs").arg(archive).arg("*")),
        )
    } else {
        (
            listing(Command::new("/usr/bin/tar").arg("-tf").arg(archive)),
            listing(Command::new("/usr/bin/tar").arg("-tvf").arg(archive)),
        )
    };
    let (Some(names), Some(long)) = (names, long) else { return true };
    let names: Vec<&str> = names.lines().collect();
    if names.iter().any(|n| escapes_destination(n)) {
        return true;
    }
    let is_link: Vec<bool> = long.lines().map(|l| l.starts_with('l')).collect();
    is_link.len() != names.len() || writes_through_symlink(&names, &is_link)
}

/// Renames `from` into `dir` under a free name made from `base` and `ext`,
/// never over an item that takes that name in the meantime.
fn place_unique(from: &Path, dir: &Path, base: &str, ext: &str) -> std::io::Result<PathBuf> {
    let mut tries = 0;
    loop {
        let target = dir.join(unique_name(dir, base, ext));
        match rename_excl(from, &target) {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && tries < 100 => tries += 1,
            done => return done.map(|()| target),
        }
    }
}

#[cfg(target_os = "macos")]
fn rename_excl(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let cstr = |p: &Path| {
        CString::new(p.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))
    };
    let (f, t) = (cstr(from)?, cstr(to)?);
    // SAFETY: both are valid NUL-terminated paths.
    if unsafe { libc::renamex_np(f.as_ptr(), t.as_ptr(), libc::RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn rename_excl(from: &Path, to: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(to).is_ok() {
        return Err(std::io::ErrorKind::AlreadyExists.into());
    }
    fs::rename(from, to)
}

fn archive_stem(name: &str) -> String {
    let lower = name.to_lowercase();
    for suffix in std::iter::once(".zip").chain(TAR_SUFFIXES) {
        if lower.ends_with(suffix) {
            return name[..name.len() - suffix.len()].to_string();
        }
    }
    name.to_string()
}

/// What an archive's listing says it holds once extracted.
#[derive(Debug, PartialEq)]
struct Declared {
    entries: u64,
    bytes: u64,
}

/// The totals `unzip -Zt` prints: "9 files, 671 bytes uncompressed, ...".
fn parse_zip_totals(out: &str) -> Option<Declared> {
    let mut words = out.lines().last()?.split_whitespace();
    let entries = words.next()?.parse().ok()?;
    words.next()?;
    let bytes = words.next()?.parse().ok()?;
    Some(Declared { entries, bytes })
}

/// Sums the size column of a `tar -tv` listing: the number just before the
/// date ("Oct 22"), found that way because owner and group names can hold
/// spaces. `None` when a line doesn't read that way, so a listing in another
/// shape never passes for a small archive.
fn parse_tar_listing(out: &str) -> Option<Declared> {
    const MONTHS: [&str; 12] =
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let mut d = Declared { entries: 0, bytes: 0 };
    for line in out.lines().filter(|l| !l.trim().is_empty()) {
        let words: Vec<&str> = line.split_whitespace().collect();
        let size = (4..words.len().saturating_sub(1)).find_map(|i| {
            let day = words[i + 1].parse::<u8>().is_ok_and(|n| (1..=31).contains(&n));
            (MONTHS.contains(&words[i]) && day).then(|| words[i - 1].parse::<u64>().ok())?
        })?;
        d.entries += 1;
        d.bytes = d.bytes.saturating_add(size);
    }
    Some(d)
}

fn declared_size(archive: &Path, zip: bool) -> Option<Declared> {
    let out = if zip {
        Command::new("/usr/bin/unzip").arg("-Zt").arg(archive).output()
    } else {
        Command::new("/usr/bin/tar").arg("-tvf").arg(archive).output()
    }
    .ok()
    .filter(|o| o.status.success())?;
    let text = String::from_utf8_lossy(&out.stdout);
    if zip {
        parse_zip_totals(&text)
    } else {
        parse_tar_listing(&text)
    }
}

/// The most an extraction may write before it is stopped as a zip bomb:
/// what the archive declares, plus room for each entry's last block and
/// some slack for metadata.
fn write_allowance(d: &Declared) -> u64 {
    d.bytes
        .saturating_add(d.bytes / 8)
        .saturating_add(d.entries.saturating_mul(8192))
        .saturating_add(64 << 20)
}

/// Space the files under `p` take on disk.
fn allocated_bytes(p: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = fs::symlink_metadata(p) else { return 0 };
    let own = meta.blocks() * 512;
    if !meta.is_dir() {
        return own;
    }
    fs::read_dir(p)
        .map(|rd| rd.flatten().map(|e| allocated_bytes(&e.path())).sum::<u64>())
        .unwrap_or(0)
        + own
}

fn size_text(bytes: u64) -> String {
    let units = ["bytes", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1000.0 && i + 1 < units.len() {
        v /= 1000.0;
        i += 1;
    }
    if i == 0 {
        format!("{bytes} bytes")
    } else {
        format!("{v:.1} {}", units[i])
    }
}

/// Extracts like Finder: a lone top-level item lands next to the archive
/// under its own name; anything else goes into a folder named after the
/// archive. Undo trashes the result.
pub fn extract_sync(path: &str, job: &Job) -> OpResult {
    let mut res = OpResult::default();
    let archive = Path::new(path);
    let name = label(archive);
    let Some(dir) = archive.parent() else {
        res.errors.push(format!("\"{name}\": has no parent folder"));
        return res;
    };
    if !is_extractable(&name) {
        res.errors.push(format!("\"{name}\": isn't an archive Doftar can extract"));
        return res;
    }
    job.set_items_total(1);
    job.set_current(&name);

    let tmp = partial_path(dir);
    if let Err(e) = fs::create_dir(&tmp) {
        res.errors.push(format!("\"{name}\": {e}"));
        return res;
    }
    // Check the entry names first: a crafted archive could name a path
    // outside the folder we extract into.
    let zip = name.to_lowercase().ends_with(".zip");
    if lists_escaping_entries(archive, zip) {
        remove_any(&tmp);
        res.errors.push(format!("\"{name}\": contains paths outside its own folder, so it wasn't extracted"));
        return res;
    }
    // A small archive can unpack to far more than the disk holds. Refuse
    // one whose own listing says it can't fit; and since that listing can
    // lie, stop one that writes well past it. Free space is the cheap
    // signal; the extracted files are measured when it drops by more than
    // allowed (so other apps writing to the disk can't trip this), and every
    // so often anyway, as macOS may free purgeable space while it writes.
    let declared = declared_size(archive, zip);
    let free_at_start = fs2::available_space(dir).ok();
    // Against the disk's size, not its free space: macOS frees purgeable
    // space as an extraction needs it, which free space doesn't count.
    if let (Some(d), Ok(disk)) = (&declared, fs2::total_space(dir)) {
        if d.bytes > disk {
            remove_any(&tmp);
            res.errors.push(format!(
                "\"{name}\": unpacks to {}, more than the whole disk holds ({})",
                size_text(d.bytes),
                size_text(disk)
            ));
            return res;
        }
    }
    let allowed = declared.as_ref().map(write_allowance);
    let mut measured_at = Instant::now();
    let mut measured_once = false;
    let watch = || {
        let (Some(start), Some(allowed)) = (free_at_start, allowed) else { return None };
        let used = start.saturating_sub(fs2::available_space(dir).ok()?);
        let since = measured_at.elapsed();
        let dropped = used > allowed && (!measured_once || since >= Duration::from_secs(2));
        if !dropped && since < Duration::from_secs(15) {
            return None;
        }
        measured_once = true;
        measured_at = Instant::now();
        (allocated_bytes(&tmp) > allowed)
            .then(|| "unpacks to far more than it says, so extracting it was stopped".to_string())
    };
    let mut cmd;
    if zip {
        cmd = Command::new("/usr/bin/ditto");
        cmd.args(["-x", "-k"]).arg(archive).arg(&tmp);
    } else {
        cmd = Command::new("/usr/bin/tar");
        cmd.arg("-xf").arg(archive).arg("-C").arg(&tmp);
    }
    if let Err(e) = run_watched(cmd, job, watch) {
        remove_any(&tmp);
        fail(&mut res, archive, e);
        job.item_done();
        return res;
    }
    // A downloaded archive is quarantined; what came out of it must be too,
    // so Gatekeeper still checks an app or script inside it on first run.
    // `ditto` and `tar` don't carry the mark over on their own.
    if let Some(mark) = quarantine::read(archive) {
        if let Ok(rd) = fs::read_dir(&tmp) {
            for e in rd.flatten() {
                quarantine::apply_tree(&e.path(), &mark);
            }
        }
    }

    let items: Vec<PathBuf> = fs::read_dir(&tmp)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    let n = label(p);
                    n != "__MACOSX" && n != ".DS_Store"
                })
                .collect()
        })
        .unwrap_or_default();

    let placed = if let [only] = items.as_slice() {
        let n = label(only);
        let (base, ext) = split_ext(&n, is_plain_dir(only));
        place_unique(only, dir, base, ext)
    } else {
        place_unique(&tmp, dir, &archive_stem(&name), "")
    };
    match placed {
        Ok(target) => res.inverse.push(Step::trash(path_str(&target))),
        Err(e) => res.errors.push(format!("\"{name}\": {e}")),
    }
    remove_any(&tmp);
    job.item_done();
    res
}

#[tauri::command]
pub async fn compress_paths(
    paths: Vec<String>,
    job_id: u64,
    on_progress: Channel<Progress>,
) -> Result<OpResult, String> {
    jobs::blocking(move || {
        let job = jobs::begin(job_id, on_progress);
        compress_sync(&paths, &job)
    })
    .await
}

#[tauri::command]
pub async fn extract_archive(
    path: String,
    job_id: u64,
    on_progress: Channel<Progress>,
) -> Result<OpResult, String> {
    jobs::blocking(move || {
        let job = jobs::begin(job_id, on_progress);
        extract_sync(&path, &job)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("wf-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn entries_written_inside_an_archived_symlink_escape() {
        assert!(writes_through_symlink(&["link", "link/payload"], &[true, false]));
        assert!(writes_through_symlink(&["./a/LINK", "./a/link/x/y"], &[true, false]));
        assert!(!writes_through_symlink(&["link", "linked/payload"], &[true, false]));
        assert!(!writes_through_symlink(&["dir/", "dir/a"], &[false, false]));
    }

    #[test]
    fn archives_holding_symlinks_still_extract() {
        let base = scratch("links");
        let src = base.join("src");
        fs::create_dir_all(src.join("dir")).unwrap();
        fs::write(src.join("dir/a b.txt"), "a").unwrap();
        std::os::unix::fs::symlink("/etc", src.join("link")).unwrap();
        let ok = |cmd: &mut Command| assert!(cmd.current_dir(&src).status().unwrap().success());
        ok(Command::new("/usr/bin/zip").args(["-qry", "../t.zip", "."]));
        ok(Command::new("/usr/bin/tar").args(["-cf", "../t.tar", "."]));
        assert!(!lists_escaping_entries(&base.join("t.zip"), true));
        assert!(!lists_escaping_entries(&base.join("t.tar"), false));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn folder_round_trips_through_zip() {
        let base = scratch("zip-folder");
        fs::create_dir_all(base.join("Docs/sub")).unwrap();
        fs::write(base.join("Docs/sub/a.txt"), "hello").unwrap();
        let job = jobs::detached();

        let made = compress_sync(&[path_str(&base.join("Docs"))], &job);
        assert!(made.errors.is_empty(), "{:?}", made.errors);
        let zip = base.join("Docs.zip");
        assert!(zip.is_file());
        assert_eq!(made.inverse, vec![Step::trash(path_str(&zip))]);

        fs::remove_dir_all(base.join("Docs")).unwrap();
        let out = extract_sync(&path_str(&zip), &job);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        assert_eq!(fs::read_to_string(base.join("Docs/sub/a.txt")).unwrap(), "hello");
        assert!(fs::read_dir(&base).unwrap().flatten().all(|e| !label(&e.path()).starts_with(".wf-partial")));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn several_items_become_archive_zip_and_unzip_into_a_folder() {
        let base = scratch("zip-multi");
        fs::write(base.join("a.txt"), "a").unwrap();
        fs::write(base.join("b.txt"), "b").unwrap();
        let job = jobs::detached();

        let made = compress_sync(&[path_str(&base.join("a.txt")), path_str(&base.join("b.txt"))], &job);
        assert!(made.errors.is_empty(), "{:?}", made.errors);
        assert!(base.join("Archive.zip").is_file());

        let again = compress_sync(&[path_str(&base.join("a.txt")), path_str(&base.join("b.txt"))], &job);
        assert!(again.errors.is_empty(), "{:?}", again.errors);
        assert!(base.join("Archive (2).zip").is_file(), "name collisions get a suffix");

        let out = extract_sync(&path_str(&base.join("Archive.zip")), &job);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        assert_eq!(fs::read_to_string(base.join("Archive/a.txt")).unwrap(), "a");
        assert_eq!(fs::read_to_string(base.join("Archive/b.txt")).unwrap(), "b");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn single_file_zip_extracts_in_place_without_clobbering() {
        let base = scratch("zip-file");
        fs::write(base.join("note.txt"), "n").unwrap();
        let job = jobs::detached();
        let made = compress_sync(&[path_str(&base.join("note.txt"))], &job);
        assert!(made.errors.is_empty(), "{:?}", made.errors);
        assert!(base.join("note.txt.zip").is_file());

        let out = extract_sync(&path_str(&base.join("note.txt.zip")), &job);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        assert_eq!(fs::read_to_string(base.join("note (2).txt")).unwrap(), "n");
        assert_eq!(fs::read_to_string(base.join("note.txt")).unwrap(), "n");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn tar_gz_extracts_and_cancel_leaves_nothing_behind() {
        let base = scratch("tar");
        fs::create_dir_all(base.join("pkg")).unwrap();
        fs::write(base.join("pkg/x.txt"), "x").unwrap();
        let status = Command::new("/usr/bin/tar")
            .args(["-czf"])
            .arg(base.join("pkg.tar.gz"))
            .arg("-C")
            .arg(&base)
            .arg("pkg")
            .status()
            .unwrap();
        assert!(status.success());
        fs::remove_dir_all(base.join("pkg")).unwrap();
        let job = jobs::detached();
        let out = extract_sync(&path_str(&base.join("pkg.tar.gz")), &job);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        assert_eq!(fs::read_to_string(base.join("pkg/x.txt")).unwrap(), "x");

        let cancelled = jobs::detached();
        cancelled.cancel();
        let out = extract_sync(&path_str(&base.join("pkg.tar.gz")), &cancelled);
        assert!(out.cancelled);
        assert!(fs::read_dir(&base).unwrap().flatten().all(|e| !label(&e.path()).starts_with(".wf-partial")));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn listings_give_the_declared_size() {
        assert_eq!(
            parse_zip_totals("9 files, 671 bytes uncompressed, 367 bytes compressed:  45.3%\n"),
            Some(Declared { entries: 9, bytes: 671 })
        );
        assert_eq!(parse_zip_totals("garbage"), None);
        let tar = "drwxr-xr-x  0 siam   wheel       0 Oct 22 22:45 p kg/\n\
                   -rw-r--r--  0 siam   wheel       5 Oct 22 22:45 p kg/a b.txt\n\
                   lrwxr-xr-x  0 0      0           0 Oct 22 22:45 p kg/l -> ../x\n\
                   -rw-r--r--  0 501    0          10 Oct 22  2020 p kg/sub/c\n\
                   -rw-r--r--  0 ad user  domain users 7 Jan  3  2021 p kg/Oct 22 x\n";
        assert_eq!(parse_tar_listing(tar), Some(Declared { entries: 5, bytes: 22 }));
        assert_eq!(parse_tar_listing("-rw-r--r-- something odd\n"), None);
        assert!(write_allowance(&Declared { entries: 1, bytes: 10 }) > 10);
        assert_eq!(write_allowance(&Declared { entries: u64::MAX, bytes: u64::MAX }), u64::MAX);
        assert_eq!(size_text(999), "999 bytes");
        assert_eq!(size_text(1_500_000_000), "1.5 GB");

        let base = scratch("declared");
        fs::create_dir_all(base.join("pkg")).unwrap();
        fs::write(base.join("pkg/x.txt"), vec![1u8; 1234]).unwrap();
        let job = jobs::detached();
        compress_sync(&[path_str(&base.join("pkg"))], &job);
        let d = declared_size(&base.join("pkg.zip"), true).unwrap();
        assert!(d.bytes >= 1234, "{d:?}");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_watched_run_stops_when_the_watch_says_so() {
        let base = scratch("bomb");
        fs::create_dir_all(base.join("out")).unwrap();
        fs::write(base.join("out/big.bin"), vec![3u8; 2 << 20]).unwrap();
        assert!(allocated_bytes(&base.join("out")) >= 2 << 20);
        let mut sleep = Command::new("/bin/sleep");
        sleep.arg("5");
        let started = Instant::now();
        let out = run_watched(sleep, &jobs::detached(), || Some("too big".to_string()));
        assert!(matches!(out, Err(RunError::Failed(m)) if m == "too big"));
        assert!(started.elapsed() < Duration::from_secs(2));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn extraction_and_compression_leave_dangling_links_alone() {
        let base = scratch("zip-dangle");
        fs::write(base.join("note.txt"), "n").unwrap();
        let job = jobs::detached();
        compress_sync(&[path_str(&base.join("note.txt"))], &job);
        fs::remove_file(base.join("note.txt")).unwrap();
        let outside = base.join("outside.txt");
        std::os::unix::fs::symlink(&outside, base.join("note.txt")).unwrap();
        let out = extract_sync(&path_str(&base.join("note.txt.zip")), &job);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        assert_eq!(fs::read_to_string(base.join("note (2).txt")).unwrap(), "n");
        assert!(fs::symlink_metadata(base.join("note.txt")).unwrap().file_type().is_symlink());
        assert!(!outside.exists());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn cancelling_a_multi_item_compress_stops_while_gathering() {
        let base = scratch("zip-cancel");
        fs::write(base.join("a.txt"), "a").unwrap();
        fs::write(base.join("b.txt"), "b").unwrap();
        let job = jobs::detached();
        job.cancel();
        let res = compress_sync(&[path_str(&base.join("a.txt")), path_str(&base.join("b.txt"))], &job);
        assert!(res.cancelled && res.errors.is_empty(), "{:?}", res.errors);
        let left: Vec<_> = fs::read_dir(&base).unwrap().flatten().map(|e| label(&e.path())).collect();
        assert_eq!(left.len(), 2, "{left:?}");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn entry_names_that_leave_the_folder_are_refused() {
        assert!(escapes_destination("../evil"));
        assert!(escapes_destination("a/../../evil"));
        assert!(escapes_destination("/etc/passwd"));
        assert!(!escapes_destination("folder/file..txt"));
        assert!(!escapes_destination("a/b/c.txt"));
    }

    #[test]
    fn recognises_extractable_names() {
        assert!(is_extractable("A.ZIP") && is_extractable("a.tar.gz") && is_extractable("a.tgz"));
        assert!(is_extractable("a.7z") && is_extractable("B.RAR") && is_extractable("disc.iso"));
        assert!(!is_extractable("a.gz") && !is_extractable("a.txt"));
        assert_eq!(archive_stem("Photos.tar.gz"), "Photos");
        assert_eq!(archive_stem("Photos.7z"), "Photos");
    }

    #[test]
    fn seven_zip_extracts_with_the_system_tar() {
        let base = scratch("7z");
        fs::create_dir_all(base.join("src/inner")).unwrap();
        fs::write(base.join("src/a.txt"), "a").unwrap();
        fs::write(base.join("src/inner/b.txt"), "b").unwrap();
        let status = Command::new("/usr/bin/tar")
            .args(["--format", "7zip", "-cf"])
            .arg(base.join("Bundle.7z"))
            .arg("-C")
            .arg(base.join("src"))
            .args(["a.txt", "inner"])
            .status()
            .unwrap();
        assert!(status.success());
        let job = jobs::detached();
        let out = extract_sync(&path_str(&base.join("Bundle.7z")), &job);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        // Two top-level items: they go into a folder named after the archive.
        assert_eq!(fs::read_to_string(base.join("Bundle/a.txt")).unwrap(), "a");
        assert_eq!(fs::read_to_string(base.join("Bundle/inner/b.txt")).unwrap(), "b");
        fs::remove_dir_all(&base).unwrap();
    }
}
