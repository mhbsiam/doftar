//! Finds files with the same content under a folder, for the Disk usage page.

use crate::jobs::{self, Job, Progress};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use tauri::ipc::Channel;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DupeGroup {
    pub size: u64,
    pub paths: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DupeReport {
    /// Most wasted space first.
    pub groups: Vec<DupeGroup>,
    /// Bytes that all copies but one of each group take.
    pub wasted: u64,
    pub cancelled: bool,
    /// More groups exist than `GROUP_LIMIT`.
    pub truncated: bool,
}

const GROUP_LIMIT: usize = 500;
const HEAD: usize = 64 << 10;

type Digest = [u8; 32];

/// Collects files of `min` bytes or more by size. Skips symlinks, hidden items and the inside of packages:
/// copies there belong to an app or a tool, and removing one breaks it. `~/Library` is hidden by a flag, not by its name.
/// Skips files a cloud drive has not downloaded: reading one makes macOS fetch it. A file with several names counts once.
fn walk(dir: &Path, min: u64, job: &Job, by_size: &mut HashMap<u64, Vec<PathBuf>>, seen: &mut HashSet<(u64, u64)>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for item in rd.flatten() {
        if job.cancelled() {
            return;
        }
        let name = item.file_name();
        let name = name.to_string_lossy();
        if crate::fsops::is_hidden_name(&name) {
            continue;
        }
        let path = item.path();
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        if crate::fsops::has_hidden_flag(&meta) || crate::thumbs::is_dataless(&meta) {
            continue;
        }
        if meta.is_dir() {
            let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            if !crate::fsops::is_package_dir(&path, &ext) {
                walk(&path, min, job, by_size, seen);
            }
        } else if meta.is_file() && meta.len() >= min && seen.insert((meta.dev(), meta.ino())) {
            by_size.entry(meta.len()).or_default().push(path);
        }
    }
}

fn head_digest(path: &Path) -> Option<Digest> {
    use sha2::Digest as _;
    use std::io::Read;
    let mut buf = vec![0u8; HEAD];
    let mut f = fs::File::open(path).ok()?;
    let mut n = 0;
    while n < HEAD {
        match f.read(&mut buf[n..]).ok()? {
            0 => break,
            k => n += k,
        }
    }
    Some(sha2::Sha256::digest(&buf[..n]).into())
}

fn full_digest(path: &Path, job: &Job) -> Option<Digest> {
    use sha2::Digest as _;
    let mut h = sha2::Sha256::new();
    let whole = crate::props::read_chunks(path, job.cancel_flag(), |b| {
        h.update(b);
        job.add_bytes(b.len() as u64);
    })
    .ok()?;
    whole.then(|| h.finalize().into())
}

/// Splits `paths` into the sets that share a key. Sets of one are dropped. Unreadable files are left out.
fn split<K: std::hash::Hash + Eq>(paths: Vec<PathBuf>, key: impl Fn(&Path) -> Option<K>) -> Vec<Vec<PathBuf>> {
    let mut sets: HashMap<K, Vec<PathBuf>> = HashMap::new();
    for p in paths {
        if let Some(k) = key(&p) {
            sets.entry(k).or_default().push(p);
        }
    }
    sets.into_values().filter(|s| s.len() > 1).collect()
}

fn find(root: &Path, min_size: u64, job: &Job) -> DupeReport {
    let mut by_size = HashMap::new();
    job.set_current("Listing files");
    walk(root, min_size.max(1), job, &mut by_size, &mut HashSet::new());
    // Same size, then the same first 64 KB, then the same whole content. Each pass reads far less than the next.
    let mut groups = Vec::new();
    for (size, paths) in by_size.into_iter().filter(|(_, p)| p.len() > 1) {
        for close in split(paths, head_digest) {
            if job.cancelled() {
                break;
            }
            job.set_current(&crate::fsops::label(&close[0]));
            let same = if size as usize <= HEAD { vec![close] } else { split(close, |p| full_digest(p, job)) };
            for mut set in same {
                set.sort();
                groups.push(DupeGroup { size, paths: set.iter().map(|p| crate::fsops::path_str(p)).collect() });
            }
        }
    }
    let waste = |g: &DupeGroup| g.size.saturating_mul(g.paths.len() as u64 - 1);
    groups.sort_by(|a, b| waste(b).cmp(&waste(a)).then_with(|| a.paths.cmp(&b.paths)));
    let truncated = groups.len() > GROUP_LIMIT;
    groups.truncate(GROUP_LIMIT);
    DupeReport { wasted: groups.iter().map(waste).sum(), groups, cancelled: job.cancelled(), truncated }
}

/// Stop it with `cancel_job`. APFS clones of one file are reported too: they share storage, so removing one frees nothing.
#[tauri::command]
pub async fn find_duplicates(
    root: String,
    min_size: u64,
    job_id: u64,
    on_progress: Channel<Progress>,
) -> Result<DupeReport, String> {
    jobs::blocking(move || {
        let job = jobs::begin(job_id, on_progress);
        find(Path::new(&root), min_size, &job)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_real_copies_and_ignores_links_hidden_files_and_near_misses() {
        let base = std::env::temp_dir().join(format!("wf-dupes-{}", std::process::id()));
        fs::create_dir_all(base.join("sub/.hidden")).unwrap();
        let big = "x".repeat(HEAD + 10);
        fs::write(base.join("a.bin"), &big).unwrap();
        fs::write(base.join("sub/b.bin"), &big).unwrap();
        fs::hard_link(base.join("a.bin"), base.join("a-link.bin")).unwrap();
        std::os::unix::fs::symlink(base.join("a.bin"), base.join("a-sym.bin")).unwrap();
        fs::write(base.join("sub/.hidden/c.bin"), &big).unwrap();
        // Hidden the way ~/Library is: by a flag, with an ordinary name.
        fs::create_dir_all(base.join("Library")).unwrap();
        fs::write(base.join("Library/d.bin"), &big).unwrap();
        #[cfg(target_os = "macos")]
        assert!(std::process::Command::new("/usr/bin/chflags").arg("hidden").arg(base.join("Library")).status().unwrap().success());
        #[cfg(not(target_os = "macos"))]
        fs::remove_dir_all(base.join("Library")).unwrap();
        // The same size and the same first 64 KB. Only the full read tells it apart.
        fs::write(base.join("near.bin"), format!("{}{}", "x".repeat(HEAD), "y".repeat(10))).unwrap();
        fs::write(base.join("s1.txt"), "small").unwrap();
        fs::write(base.join("s2.txt"), "small").unwrap();

        let job = jobs::detached();
        let got = find(&base, 1, &job);
        let names = |g: &DupeGroup| -> Vec<String> {
            g.paths.iter().map(|p| p.rsplit('/').next().unwrap().to_string()).collect()
        };
        assert_eq!(got.groups.len(), 2, "{got:?}");
        // One of the two hard-linked names stands for the file. Which one depends on the listing order.
        let first = names(&got.groups[0]);
        assert_eq!(first.len(), 2, "{first:?}");
        assert!(first.contains(&"b.bin".to_string()) && first.iter().any(|n| n.starts_with("a")), "{first:?}");
        assert_eq!(names(&got.groups[1]), ["s1.txt", "s2.txt"]);
        assert_eq!(got.wasted, big.len() as u64 + 5);
        assert_eq!(find(&base, 1000, &job).groups.len(), 1, "small files are below the limit");
        fs::remove_dir_all(&base).unwrap();
    }
}
