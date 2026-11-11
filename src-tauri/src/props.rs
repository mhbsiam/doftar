use crate::jobs::{job_key, Cancels, JobKey};
use crate::tags::Tag;
use serde::Serialize;
use std::collections::HashSet;
use std::ffi::CStr;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInfo {
    pub size: u64,
    pub size_on_disk: u64,
    pub mode: u32,
    pub owner: String,
    pub group: String,
    pub created_ms: u64,
    pub modified_ms: u64,
    pub accessed_ms: u64,
    pub symlink_target: Option<String>,
    pub tags: Vec<Tag>,
    pub default_app: Option<String>,
    /// Has the quarantine mark that macOS sets on downloads. Gatekeeper checks it at first open.
    pub quarantined: bool,
    /// Download source that the browser recorded: the file address, then usually the page.
    pub where_froms: Vec<String>,
}

fn ms(secs: i64, nanos: i64) -> u64 {
    if secs < 0 {
        return 0;
    }
    secs as u64 * 1000 + (nanos.max(0) as u64) / 1_000_000
}

// item_info runs concurrently (multi-select Properties). The non-_r variants return shared static storage.
fn user_name(uid: u32) -> String {
    let mut pw: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0u8; 4096];
    let mut out: *mut libc::passwd = std::ptr::null_mut();
    let rc = unsafe {
        libc::getpwuid_r(uid, &mut pw, buf.as_mut_ptr() as *mut _, buf.len(), &mut out)
    };
    if rc != 0 || out.is_null() {
        return uid.to_string();
    }
    unsafe { CStr::from_ptr(pw.pw_name).to_string_lossy().into_owned() }
}

fn group_name(gid: u32) -> String {
    let mut gr: libc::group = unsafe { std::mem::zeroed() };
    let mut buf = vec![0u8; 4096];
    let mut out: *mut libc::group = std::ptr::null_mut();
    let rc = unsafe {
        libc::getgrgid_r(gid, &mut gr, buf.as_mut_ptr() as *mut _, buf.len(), &mut out)
    };
    if rc != 0 || out.is_null() {
        return gid.to_string();
    }
    unsafe { CStr::from_ptr(gr.gr_name).to_string_lossy().into_owned() }
}

#[tauri::command(async)]
pub fn item_info(path: String) -> Result<ItemInfo, String> {
    let p = Path::new(&path);
    let lmeta = fs::symlink_metadata(p).map_err(|e| e.to_string())?;
    let symlink_target = lmeta
        .file_type()
        .is_symlink()
        .then(|| fs::read_link(p).ok().map(|t| t.to_string_lossy().into_owned()))
        .flatten();
    let meta = fs::metadata(p).unwrap_or_else(|_| lmeta.clone());
    let created = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(ItemInfo {
        size: if meta.is_dir() { 0 } else { meta.len() },
        size_on_disk: meta.blocks() * 512,
        mode: meta.mode() & 0o7777,
        owner: user_name(meta.uid()),
        group: group_name(meta.gid()),
        created_ms: created,
        modified_ms: ms(meta.mtime(), meta.mtime_nsec()),
        accessed_ms: ms(meta.atime(), meta.atime_nsec()),
        symlink_target,
        tags: crate::tags::read(p),
        default_app: crate::openwith::default_app(&path),
        quarantined: crate::quarantine::is_quarantined(p),
        where_froms: crate::quarantine::where_froms(p),
    })
}

#[derive(Serialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SizeProgress {
    pub bytes: u64,
    pub on_disk: u64,
    pub files: u64,
    pub folders: u64,
    pub done: bool,
    pub cancelled: bool,
    /// The folder could not be read at all, for example because macOS denies access. The counts are not an answer.
    pub denied: bool,
    /// Inner folders that could not be read. The counts leave them out.
    pub unreadable: u64,
}

static CANCELS: Cancels = Cancels::new();

#[tauri::command]
pub fn cancel_size(webview: tauri::Webview, job_id: u64) {
    CANCELS.cancel(job_key(&webview, job_id));
}

pub(crate) fn read_chunks(path: &Path, cancel: &AtomicBool, mut eat: impl FnMut(&[u8])) -> Result<bool, String> {
    use std::io::Read;
    // Check before opening. Opening a named pipe waits for a writer forever.
    if !fs::metadata(path).map_err(|e| e.to_string())?.is_file() {
        return Err("Only a file has a checksum".to_string());
    }
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(true);
        }
        eat(&buf[..n]);
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Checksums {
    pub sha256: String,
    pub sha1: String,
    pub md5: String,
}

fn checksums_of(path: &Path, cancel: &AtomicBool) -> Result<Option<Checksums>, String> {
    use sha2::Digest;
    let (mut a, mut b, mut c) = (sha2::Sha256::new(), sha1::Sha1::new(), md5::Md5::new());
    let done = read_chunks(path, cancel, |buf| {
        a.update(buf);
        b.update(buf);
        c.update(buf);
    })?;
    Ok(done.then(|| Checksums {
        sha256: hex(&a.finalize()),
        sha1: hex(&b.finalize()),
        md5: hex(&c.finalize()),
    }))
}

/// `cancel_size` with the same `job_id` stops it. It then answers `None`.
#[tauri::command]
pub async fn file_checksums(path: String, job_id: u64, webview: tauri::Webview) -> Result<Option<Checksums>, String> {
    let key = job_key(&webview, job_id);
    crate::jobs::blocking(move || {
        let cancel = CANCELS.begin(key.clone());
        let out = checksums_of(Path::new(&path), &cancel);
        CANCELS.end(&key, &cancel);
        out
    })
    .await?
}

fn measure(paths: &[String], cancel: &AtomicBool, mut emit: impl FnMut(&SizeProgress)) -> SizeProgress {
    let mut total = SizeProgress::default();
    let mut seen: HashSet<(u64, u64)> = HashSet::new();
    let mut last = Instant::now();
    for root in paths {
        if paths.iter().any(|o| root.strip_prefix(o.trim_end_matches('/')).is_some_and(|r| r.starts_with('/') && o != root)) {
            continue;
        }
        // Follow a symlinked root, because the UI shows a link to a folder as a folder. Links inside the tree count as links.
        let Ok(meta) = fs::metadata(root).or_else(|_| fs::symlink_metadata(root)) else {
            total.denied = true;
            continue;
        };
        let root_dev = meta.dev();
        let mut stack = vec![(Path::new(root).to_path_buf(), meta)];
        while let Some((dir, meta)) = stack.pop() {
            if cancel.load(Ordering::Relaxed) {
                total.cancelled = true;
                return total;
            }
            if meta.is_dir() {
                let Ok(rd) = fs::read_dir(&dir) else {
                    if paths.iter().any(|r| Path::new(r) == dir) {
                        total.denied = true;
                    } else {
                        total.unreadable += 1;
                    }
                    continue;
                };
                for item in rd.flatten() {
                    let Ok(m) = item.metadata() else { continue };
                    if m.is_dir() {
                        if m.dev() == root_dev {
                            total.folders += 1;
                            stack.push((item.path(), m));
                        }
                    } else {
                        count_file(&m, &mut total, &mut seen);
                    }
                }
            } else {
                count_file(&meta, &mut total, &mut seen);
            }
            if last.elapsed() >= Duration::from_millis(100) {
                last = Instant::now();
                emit(&total);
            }
        }
    }
    total
}

fn count_file(m: &fs::Metadata, total: &mut SizeProgress, seen: &mut HashSet<(u64, u64)>) {
    total.files += 1;
    if m.nlink() > 1 && !seen.insert((m.dev(), m.ino())) {
        return;
    }
    total.bytes += m.len();
    total.on_disk += m.blocks() * 512;
}

#[tauri::command]
pub async fn folder_size(
    paths: Vec<String>,
    job_id: u64,
    on_progress: Channel<SizeProgress>,
    webview: tauri::Webview,
) -> Result<SizeProgress, String> {
    let key = job_key(&webview, job_id);
    crate::jobs::blocking(move || folder_size_sync(paths, key, on_progress)).await
}

fn folder_size_sync(paths: Vec<String>, key: JobKey, on_progress: Channel<SizeProgress>) -> SizeProgress {
    let cancel = CANCELS.begin(key.clone());
    let mut total = measure(&paths, &cancel, |p| {
        let _ = on_progress.send(p.clone());
    });
    CANCELS.end(&key, &cancel);
    total.done = !total.cancelled;
    let _ = on_progress.send(total.clone());
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_a_tree_once_per_hard_link_and_skips_symlinks() {
        let base = std::env::temp_dir().join(format!("wf-size-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("a/b")).unwrap();
        fs::write(base.join("a/one.bin"), vec![1u8; 1000]).unwrap();
        fs::write(base.join("a/b/two.bin"), vec![2u8; 500]).unwrap();
        fs::hard_link(base.join("a/one.bin"), base.join("a/b/one-link.bin")).unwrap();
        std::os::unix::fs::symlink("/", base.join("a/rootlink")).unwrap();
        let never = AtomicBool::new(false);

        let t = measure(&[path(&base.join("a"))], &never, |_| {});
        assert_eq!(t.bytes, 1501, "hard link counted once; the symlink itself is 1 byte");
        assert_eq!(t.folders, 1);
        assert_eq!(t.files, 4, "two files, the link, and the symlink itself");
        assert!(t.on_disk >= 1500);

        let single = measure(&[path(&base.join("a/one.bin"))], &never, |_| {});
        assert_eq!((single.files, single.bytes), (1, 1000));

        let stop = AtomicBool::new(true);
        assert!(measure(&[path(&base.join("a"))], &stop, |_| {}).cancelled);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn checksums_match_the_known_digests_and_stop_when_cancelled() {
        let f = std::env::temp_dir().join(format!("wf-sha-{}", std::process::id()));
        fs::write(&f, b"abc").unwrap();
        let never = AtomicBool::new(false);
        assert_eq!(checksums_of(&f, &AtomicBool::new(true)).unwrap(), None);
        assert!(checksums_of(&std::env::temp_dir(), &never).is_err());
        let all = checksums_of(&f, &never).unwrap().unwrap();
        assert_eq!(all.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(all.sha1, "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(all.md5, "900150983cd24fb0d6963f7d28e17f72");
        fs::remove_file(&f).unwrap();
    }

    fn path(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn item_info_reports_owner_and_mode() {
        let base = std::env::temp_dir().join(format!("wf-info-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let f = base.join("note.txt");
        fs::write(&f, "hello").unwrap();
        let info = item_info(path(&f)).unwrap();
        assert_eq!(info.size, 5);
        assert_ne!(info.mode & 0o400, 0, "owner can read");
        assert!(!info.owner.is_empty() && !info.group.is_empty());
        assert!(info.modified_ms > 0);
        fs::remove_dir_all(&base).unwrap();
    }
}
