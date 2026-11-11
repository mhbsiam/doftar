//! Use the macOS tools `ditto` and `tar`. The archives then match Finder.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

use crate::fsops::{is_plain_dir, label, partial_path, path_str, rename_excl, split_ext, unique_name};
use crate::jobs::{self, Job, OpResult, Progress, Step};
use crate::quarantine;

enum RunError {
    Cancelled,
    Failed(String),
}

fn run_cancellable(cmd: Command, job: &Job) -> Result<(), RunError> {
    run_watched(cmd, job, || None)
}

/// Also kills `cmd` when `watch` returns a reason. `watch` runs every tick.
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
    // Drain stderr in a thread. A full pipe blocks the child while we poll.
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
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunError::Failed(e.to_string()));
            }
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

/// The zip goes next to the first path: `Name.zip` for one item, `Archive.zip` for more.
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
        // For a file, --keepParent adds the containing folder. Use it for folders only.
        if first.is_dir() {
            cmd.arg("--keepParent");
        }
        cmd.arg(first);
    } else {
        // ditto takes one source. Clone the items into a staging folder first.
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

/// All formats the macOS `tar` reads. Longer suffixes come first, for `archive_stem`.
const TAR_SUFFIXES: [&str; 15] = [
    ".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".tbz2", ".txz", ".tar",
    ".7z", ".rar", ".iso", ".cab", ".xar", ".cpio", ".lzh", ".lha",
];

pub fn is_extractable(name: &str) -> bool {
    let n = name.to_lowercase();
    n.ends_with(".zip") || TAR_SUFFIXES.iter().any(|s| n.ends_with(s))
}

fn escapes_destination(entry: &str) -> bool {
    entry.starts_with('/') || entry.split('/').any(|part| part == "..")
}

/// Remove a leading "./" and a trailing "/". Fold the case, because APFS ignores case by default.
fn entry_key(entry: &str) -> String {
    let mut e = entry;
    while let Some(rest) = e.strip_prefix("./") {
        e = rest;
    }
    e.trim_end_matches('/').to_lowercase()
}

/// True if an entry goes through a symlink of the archive (`link -> /etc`, then `link/payload`). That escapes the folder.
fn writes_through_symlink(names: &[&str], is_link: &[bool]) -> bool {
    let links: std::collections::HashSet<String> = names
        .iter()
        .zip(is_link)
        .filter(|(_, &l)| l)
        .map(|(n, _)| entry_key(n))
        .collect();
    // shortcut: no Unicode normalization (APFS treats NFC and NFD as one name). Refuse links with non-ASCII names. Add it if real archives fail.
    !links.is_empty()
        && names.iter().any(|n| !n.is_ascii() || {
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

/// The long listing marks symlinks with `l`. A listing that fails or does not match the names is unsafe.
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

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    /// As stored, without a leading "./" or a trailing "/".
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveListing {
    pub entries: Vec<ArchiveEntry>,
    /// The archive holds more than `LIST_LIMIT` entries.
    pub truncated: bool,
}

const LIST_LIMIT: usize = 50_000;

fn tidy(name: &str) -> String {
    let mut n = name;
    while let Some(rest) = n.strip_prefix("./") {
        n = rest;
    }
    n.trim_end_matches('/').to_string()
}

/// One line of `tar -tv`: the type letter, the size before the date, and the name after the time or year.
fn parse_tar_line(line: &str) -> Option<ArchiveEntry> {
    const MONTHS: [&str; 12] =
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let words: Vec<&str> = line.split_whitespace().collect();
    let at = (4..words.len().saturating_sub(2)).find(|&i| {
        MONTHS.contains(&words[i]) && words[i + 1].parse::<u8>().is_ok_and(|n| (1..=31).contains(&n))
    })?;
    let size = words[at - 1].parse().ok()?;
    // The name starts after month, day and time. Cut it from the line, because it can hold spaces.
    let mut rest = line;
    for w in &words[..at + 3] {
        rest = rest[rest.find(w)? + w.len()..].trim_start();
    }
    let name = rest.split(" -> ").next().unwrap_or(rest);
    let path = tidy(name);
    (!path.is_empty()).then(|| ArchiveEntry { path, size, is_dir: line.starts_with('d') })
}

fn list_sync(archive: &Path) -> Result<ArchiveListing, String> {
    let name = archive.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut entries = Vec::new();
    let mut truncated = false;
    if name.ends_with(".zip") {
        // The central directory only. Nothing is decompressed.
        let file = fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Can't read the archive: {e}"))?;
        truncated = zip.len() > LIST_LIMIT;
        for i in 0..zip.len().min(LIST_LIMIT) {
            let Ok(e) = zip.by_index_raw(i) else { continue };
            let Ok(name) = e.name() else { continue };
            let path = tidy(&name);
            if !path.is_empty() && !path.starts_with("__MACOSX") {
                entries.push(ArchiveEntry { path, size: e.size(), is_dir: e.is_dir() });
            }
        }
    } else {
        use std::io::{BufRead, BufReader};
        // Read line by line and stop tar at the limit. A huge archive then costs neither memory nor minutes.
        let mut child = Command::new("/usr/bin/tar")
            .env("LC_ALL", "C")
            .arg("-tvf")
            .arg(archive)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let lines = BufReader::new(child.stdout.take().ok_or("Can't read the archive")?).split(b'\n');
        for line in lines.map_while(Result::ok) {
            if entries.len() >= LIST_LIMIT {
                truncated = true;
                let _ = child.kill();
                break;
            }
            entries.extend(parse_tar_line(&String::from_utf8_lossy(&line)));
        }
        let ok = child.wait().is_ok_and(|s| s.success());
        if !ok && !truncated {
            return Err("Can't read the archive".to_string());
        }
    }
    Ok(ArchiveListing { entries, truncated })
}

/// What an archive holds, without extracting it. Names are text only and never touch the disk.
#[tauri::command]
pub async fn archive_list(path: String) -> Result<ArchiveListing, String> {
    crate::jobs::blocking(move || list_sync(Path::new(&path))).await?
}

/// Never replaces an item that takes the name first. Tries the next free name.
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

fn archive_stem(name: &str) -> String {
    let lower = name.to_lowercase();
    for suffix in std::iter::once(".zip").chain(TAR_SUFFIXES) {
        if lower.ends_with(suffix) {
            return name[..name.len() - suffix.len()].to_string();
        }
    }
    name.to_string()
}

#[derive(Debug, PartialEq)]
struct Declared {
    entries: u64,
    bytes: u64,
}

/// Parse the `unzip -Zt` line: "9 files, 671 bytes uncompressed, ...".
fn parse_zip_totals(out: &str) -> Option<Declared> {
    let mut words = out.lines().last()?.split_whitespace();
    let entries = words.next()?.parse().ok()?;
    words.next()?;
    let bytes = words.next()?.parse().ok()?;
    Some(Declared { entries, bytes })
}

/// Sum the size column of `tar -tv`. It is the number before the date ("Oct 22"), because owner names can hold spaces.
/// Return `None` for an unknown line shape. Then an odd listing never looks like a small archive.
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
        // The parser reads C locale month names.
        Command::new("/usr/bin/tar").env("LC_ALL", "C").arg("-tvf").arg(archive).output()
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

/// Write limit before we stop a zip bomb: declared size plus block and metadata slack.
fn write_allowance(d: &Declared) -> u64 {
    d.bytes
        .saturating_add(d.bytes / 8)
        .saturating_add(d.entries.saturating_mul(8192))
        .saturating_add(64 << 20)
}

fn allocated_bytes(p: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = fs::symlink_metadata(p) else { return 0 };
    let own = meta.blocks() * 512;
    if !meta.is_dir() {
        // Split by link count. A file with many names counts once.
        return own / meta.nlink().max(1);
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

/// Like Finder: one top-level item goes next to the archive. Other content goes in a folder named after the archive.
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
    // Check entry names first. A crafted archive can name a path outside the folder.
    let zip = name.to_lowercase().ends_with(".zip");
    if lists_escaping_entries(archive, zip) {
        remove_any(&tmp);
        res.errors.push(format!("\"{name}\": contains paths outside its own folder, so it wasn't extracted"));
        return res;
    }
    // Refuse an archive that declares more than the disk holds. The listing can lie, so also stop a write far past it.
    // Free space is the cheap signal. Measure the files only when it drops past the limit, so other apps do not trip it.
    // Also measure every 15 s, because macOS can free purgeable space.
    let Some(declared) = declared_size(archive, zip) else {
        remove_any(&tmp);
        res.errors.push(format!("\"{name}\": couldn't read what it holds, so it wasn't extracted"));
        return res;
    };
    let free_at_start = fs2::available_space(dir).ok();
    // Compare with the disk size, not free space. macOS frees purgeable space that free space does not count.
    if let Ok(disk) = fs2::total_space(dir) {
        if declared.bytes > disk {
            remove_any(&tmp);
            res.errors.push(format!(
                "\"{name}\": unpacks to {}, more than the whole disk holds ({})",
                size_text(declared.bytes),
                size_text(disk)
            ));
            return res;
        }
    }
    let allowed = write_allowance(&declared);
    let mut measured_at = Instant::now();
    let mut measured_once = false;
    let watch = || {
        let start = free_at_start?;
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
    // Copy the quarantine mark to the output, so Gatekeeper checks apps inside. `ditto` and `tar` do not copy it.
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

    #[test]
    fn lists_a_zip_and_a_tarball_without_extracting() {
        let base = std::env::temp_dir().join(format!("wf-arclist-{}", std::process::id()));
        fs::create_dir_all(base.join("src/sub dir")).unwrap();
        fs::write(base.join("src/a.txt"), "12345").unwrap();
        fs::write(base.join("src/sub dir/b c.txt"), "678").unwrap();
        let run = |cmd: &mut Command| assert!(cmd.current_dir(&base).status().unwrap().success());
        run(Command::new("/usr/bin/zip").args(["-qr", "t.zip", "src"]));
        run(Command::new("/usr/bin/tar").args(["-czf", "t.tar.gz", "src"]));
        for name in ["t.zip", "t.tar.gz"] {
            let mut got = list_sync(&base.join(name)).unwrap().entries;
            got.sort_by(|a, b| a.path.cmp(&b.path));
            let want = [("src", 0, true), ("src/a.txt", 5, false), ("src/sub dir", 0, true), ("src/sub dir/b c.txt", 3, false)];
            let got: Vec<_> = got.iter().map(|e| (e.path.as_str(), if e.is_dir { 0 } else { e.size }, e.is_dir)).collect();
            assert_eq!(got, want, "{name}");
        }
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_tar_line_with_a_link_and_an_escaping_name_is_only_text() {
        let e = parse_tar_line("lrwxr-xr-x  0 me staff 0 Oct 22 10:01 ../up -> /etc").unwrap();
        assert_eq!(e, ArchiveEntry { path: "../up".into(), size: 0, is_dir: false });
        let old = parse_tar_line("-rw-r--r--  0 Jo Smith staff 12 Jan  5  2019 ./My File.txt").unwrap();
        assert_eq!(old, ArchiveEntry { path: "My File.txt".into(), size: 12, is_dir: false });
    }

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
        // NFC link name and NFD file name are one folder on APFS.
        assert!(writes_through_symlink(&["caf\u{e9}", "cafe\u{301}/x"], &[true, false]));
        assert!(!writes_through_symlink(&["caf\u{e9}/x"], &[false]));
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
        let tar = "drwxr-xr-x  0 alex   wheel       0 Oct 22 22:45 p kg/\n\
                   -rw-r--r--  0 alex   wheel       5 Oct 22 22:45 p kg/a b.txt\n\
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
    fn a_zip_whose_local_header_lies_still_lands_inside() {
        use std::io::Write;
        // The listing reads the central directory. ditto reads the local header, renamed here to leave the folder.
        let base = scratch("zip-lies");
        let dest = base.join("a/b");
        fs::create_dir_all(&dest).unwrap();
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        w.start_file("ok/SAFEx.txt", zip::write::SimpleFileOptions::default()).unwrap();
        w.write_all(b"x").unwrap();
        let mut bytes = w.finish().unwrap().into_inner();
        let at = bytes.windows(12).position(|w| w == b"ok/SAFEx.txt").unwrap();
        bytes[at..at + 12].copy_from_slice(b"../../EVIL.t");
        fs::write(dest.join("t.zip"), bytes).unwrap();
        let _ = extract_sync(&path_str(&dest.join("t.zip")), &jobs::detached());
        assert!(!base.join("EVIL.t").exists() && !base.join("a/EVIL.t").exists());
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
        assert_eq!(fs::read_to_string(base.join("Bundle/a.txt")).unwrap(), "a");
        assert_eq!(fs::read_to_string(base.join("Bundle/inner/b.txt")).unwrap(), "b");
        fs::remove_dir_all(&base).unwrap();
    }
}
