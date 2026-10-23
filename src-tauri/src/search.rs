use serde::Serialize;
use std::collections::HashMap;
use std::borrow::Cow;
use std::fs;
use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

use crate::fsops::{build_entry, is_hidden_name, FileEntry, PACKAGE_EXTS};
use crate::jobs::{job_key, Cancels, JobKey};

const MAX_RESULTS: usize = 5000;
const BATCH: usize = 64;
const BATCH_EVERY: Duration = Duration::from_millis(120);
const SCAN_MAX_VISITED: usize = 400_000;
const SCAN_MAX_TIME: Duration = Duration::from_secs(20);

static CANCELS: Cancels = Cancels::new();

/// The mdfind each running search waits on.
fn pids() -> &'static Mutex<HashMap<JobKey, u32>> {
    static PIDS: OnceLock<Mutex<HashMap<JobKey, u32>>> = OnceLock::new();
    PIDS.get_or_init(Default::default)
}

#[tauri::command]
pub fn cancel_search(webview: tauri::Webview, search_id: u64) {
    let key = job_key(&webview, search_id);
    CANCELS.cancel(key.clone());
    if let Some(&pid) = pids().lock().unwrap().get(&key) {
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchSummary {
    pub count: usize,
    pub truncated: bool,
    pub source: &'static str,
}

struct Sink {
    chan: Option<Channel<Vec<FileEntry>>>,
    pending: Vec<FileEntry>,
    last: Instant,
    count: usize,
}

impl Sink {
    fn new(chan: Channel<Vec<FileEntry>>) -> Self {
        Sink { chan: Some(chan), pending: Vec::new(), last: Instant::now(), count: 0 }
    }
    fn push(&mut self, e: FileEntry) {
        self.count += 1;
        self.pending.push(e);
        if self.pending.len() >= BATCH || self.last.elapsed() >= BATCH_EVERY {
            self.flush();
        }
    }
    fn flush(&mut self) {
        self.last = Instant::now();
        if self.pending.is_empty() {
            return;
        }
        let batch = std::mem::take(&mut self.pending);
        if let Some(c) = &self.chan {
            let _ = c.send(batch);
        }
    }
    fn full(&self) -> bool {
        self.count >= MAX_RESULTS
    }
}

fn predicate(query: &str) -> String {
    // `*` and `?` are Spotlight wildcards; the scan fallback treats them
    // literally, so escape them here to match.
    format!("kMDItemFSName == \"*{}*\"cd", escape(query))
}

fn escape(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('*', "\\*")
        .replace('?', "\\?")
}

/// Items carrying any of `names` (any tag at all when empty), ignoring case.
fn tag_predicate(names: &[String]) -> String {
    if names.is_empty() {
        return "kMDItemUserTags == \"*\"".to_string();
    }
    names
        .iter()
        .map(|n| format!("kMDItemUserTags == \"{}\"c", escape(n)))
        .collect::<Vec<_>>()
        .join(" || ")
}

fn has_tag(e: &FileEntry, names: &[String]) -> bool {
    if names.is_empty() {
        return !e.tags.is_empty();
    }
    e.tags
        .iter()
        .any(|t| names.iter().any(|n| n.to_lowercase() == t.name.to_lowercase()))
}

fn is_package_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .map(|e| PACKAGE_EXTS.contains(&e.to_string_lossy().to_lowercase().as_str()))
        .unwrap_or(false)
}

fn buried(root: &Path, path: &Path, show_hidden: bool) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return true;
    };
    let mut parts: Vec<_> = rel.components().collect();
    parts.pop();
    parts.iter().any(|c| {
        let n = c.as_os_str().to_string_lossy();
        (!show_hidden && is_hidden_name(&n)) || is_package_name(&n)
    })
}

/// `p`, from mdfind, under `root` as the search was given it. Spotlight
/// answers with real paths, so under a root reached through a symlink
/// (`real_root` its resolved path) every result would otherwise fall
/// outside it.
fn under_root<'a>(root: &Path, real_root: Option<&Path>, p: &'a Path) -> Cow<'a, Path> {
    match real_root.filter(|_| !p.starts_with(root)).map(|r| p.strip_prefix(r)) {
        Some(Ok(rest)) => Cow::Owned(root.join(rest)),
        _ => Cow::Borrowed(p),
    }
}

fn spotlight_disabled(root: &str) -> bool {
    Command::new("/usr/bin/mdutil")
        .args(["-s", root])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("Indexing disabled"))
        .unwrap_or(false)
}

/// Streams what Spotlight finds for `predicate` under `root` (everywhere it
/// indexes when `None`), keeping the entries `keep` accepts.
fn run_spotlight(
    key: &JobKey,
    root: Option<&str>,
    predicate: &str,
    show_hidden: bool,
    keep: impl Fn(&FileEntry) -> bool,
    cancel: &AtomicBool,
    sink: &mut Sink,
) -> bool {
    let mut cmd = Command::new("/usr/bin/mdfind");
    if let Some(root) = root {
        cmd.args(["-onlyin", root]);
    }
    let child = cmd
        .arg(predicate)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return false };
    pids().lock().unwrap().insert(key.clone(), child.id());
    if cancel.load(Ordering::Relaxed) {
        // Cancelled before the pid was there to signal.
        let _ = child.kill();
    }
    let root_path = Path::new(root.unwrap_or("/"));
    let real_root = fs::canonicalize(root_path).ok().filter(|r| r != root_path);
    if let Some(out) = child.stdout.take() {
        // Read raw bytes: `.lines()` would stop the whole stream at the first
        // non-UTF-8 name (SMB/NFS/exFAT) and report the search as complete.
        for line in BufReader::new(out).split(b'\n').map_while(Result::ok) {
            if cancel.load(Ordering::Relaxed) || sink.full() {
                break;
            }
            let line = OsString::from_vec(line);
            let p = under_root(root_path, real_root.as_deref(), Path::new(&line));
            let p = p.as_ref();
            if p == root_path || buried(root_path, p, show_hidden) {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(p) else { continue };
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if let Some(e) = build_entry(p, name, meta, show_hidden).filter(|e| keep(e)) {
                sink.push(e);
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    // The pid is dead now; a late cancel must not signal whatever reuses it.
    pids().lock().unwrap().remove(key);
    true
}

fn run_scan(
    root: &Path,
    query: &str,
    show_hidden: bool,
    cancel: &AtomicBool,
    sink: &mut Sink,
) -> bool {
    let needle = query.to_lowercase();
    let started = Instant::now();
    let mut visited = 0usize;
    let mut queue = std::collections::VecDeque::from([root.to_path_buf()]);
    while let Some(dir) = queue.pop_front() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for item in rd.flatten() {
            if cancel.load(Ordering::Relaxed) {
                return false;
            }
            if sink.full() || visited >= SCAN_MAX_VISITED || started.elapsed() > SCAN_MAX_TIME {
                return true;
            }
            visited += 1;
            let name = item.file_name().to_string_lossy().to_string();
            if !show_hidden && is_hidden_name(&name) {
                continue;
            }
            let Ok(meta) = item.metadata() else { continue };
            let path = item.path();
            let descend = meta.is_dir() && !meta.file_type().is_symlink() && !is_package_name(&name);
            if name.to_lowercase().contains(&needle) {
                if let Some(e) = build_entry(&path, name, meta, show_hidden) {
                    sink.push(e);
                }
            }
            if descend {
                queue.push_back(path);
            }
        }
    }
    false
}

/// Walks `root` for items carrying any of `names` (any tag when empty), for
/// places Spotlight doesn't index. Folder listings read tags only for items
/// with a Finder label, so tags without a colour go unseen here.
fn run_tag_scan(
    root: &Path,
    names: &[String],
    show_hidden: bool,
    cancel: &AtomicBool,
    sink: &mut Sink,
) -> bool {
    let started = Instant::now();
    let mut visited = 0usize;
    let mut queue = std::collections::VecDeque::from([root.to_path_buf()]);
    while let Some(dir) = queue.pop_front() {
        let Ok(entries) = crate::fsops::list_dir_sync(&dir.to_string_lossy(), show_hidden) else {
            continue;
        };
        for e in entries {
            if cancel.load(Ordering::Relaxed) {
                return false;
            }
            if sink.full() || visited >= SCAN_MAX_VISITED || started.elapsed() > SCAN_MAX_TIME {
                return true;
            }
            visited += 1;
            if e.is_dir && !e.is_package && !e.is_symlink {
                queue.push_back(PathBuf::from(&e.path));
            }
            if has_tag(&e, names) {
                sink.push(e);
            }
        }
    }
    false
}

/// Streams the items carrying any of `names` (any tag when empty) under
/// `root`, or everywhere Spotlight indexes when `root` is `None`.
#[tauri::command]
pub async fn search_tags(
    root: Option<String>,
    names: Vec<String>,
    show_hidden: bool,
    search_id: u64,
    on_batch: Channel<Vec<FileEntry>>,
    webview: tauri::Webview,
) -> Result<SearchSummary, String> {
    let key = job_key(&webview, search_id);
    crate::jobs::blocking(move || {
        if let Some(r) = &root {
            if !Path::new(r).is_dir() {
                return Err(format!("{r} isn't a folder"));
            }
        }
        let cancel = CANCELS.begin(key.clone());
        let mut sink = Sink::new(on_batch);
        let mut source = "spotlight";
        let mut truncated = false;
        // Unlike a name search, finding nothing is a real answer here (most
        // folders have no tagged items), so only a volume Spotlight says it
        // doesn't index is walked instead.
        let indexed = root.as_deref().map_or(true, |r| !spotlight_disabled(r));
        let ran = indexed
            && run_spotlight(
                &key,
                root.as_deref(),
                &tag_predicate(&names),
                show_hidden,
                // Spotlight catches up with tag changes a moment late; the
                // tags just read from the item have the last word.
                |e| has_tag(e, &names),
                &cancel,
                &mut sink,
            );
        if !ran {
            if let Some(r) = &root {
                source = "scan";
                truncated = run_tag_scan(Path::new(r), &names, show_hidden, &cancel, &mut sink);
            }
        } else if sink.full() {
            truncated = true;
        }
        sink.flush();
        CANCELS.end(&key, &cancel);
        Ok(SearchSummary { count: sink.count, truncated, source })
    })
    .await?
}

#[tauri::command]
pub async fn search_dir(
    root: String,
    query: String,
    show_hidden: bool,
    search_id: u64,
    on_batch: Channel<Vec<FileEntry>>,
    webview: tauri::Webview,
) -> Result<SearchSummary, String> {
    let key = job_key(&webview, search_id);
    crate::jobs::blocking(move || search_dir_sync(root, query, show_hidden, key, on_batch)).await?
}

fn search_dir_sync(
    root: String,
    query: String,
    show_hidden: bool,
    key: JobKey,
    on_batch: Channel<Vec<FileEntry>>,
) -> Result<SearchSummary, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(SearchSummary { count: 0, truncated: false, source: "spotlight" });
    }
    if !Path::new(&root).is_dir() {
        return Err(format!("{root} isn't a folder"));
    }
    let cancel = CANCELS.begin(key.clone());
    let mut sink = Sink::new(on_batch);
    let mut source = "spotlight";
    let mut truncated = false;
    let via_spotlight = !spotlight_disabled(&root)
        && run_spotlight(
            &key,
            Some(&root),
            &predicate(&query),
            show_hidden,
            |_| true,
            &cancel,
            &mut sink,
        );
    // mdutil only knows the volume's state: ~/Library, Spotlight privacy
    // exclusions and fresh or network volumes report "enabled" yet mdfind
    // finds nothing there. Treat an empty Spotlight answer as "not indexed".
    let spotlight_empty = sink.count == 0 && !cancel.load(Ordering::Relaxed);
    if !via_spotlight || spotlight_empty {
        source = "scan";
        truncated = run_scan(Path::new(&root), &query, show_hidden, &cancel, &mut sink);
    } else if sink.full() {
        truncated = true;
    }
    sink.flush();
    CANCELS.end(&key, &cancel);
    Ok(SearchSummary { count: sink.count, truncated, source })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sink() -> Sink {
        Sink { chan: None, pending: Vec::new(), last: Instant::now(), count: 0 }
    }

    #[test]
    fn predicate_escapes_quotes_and_backslashes() {
        assert_eq!(predicate("a\"b\\c"), "kMDItemFSName == \"*a\\\"b\\\\c*\"cd");
    }

    #[test]
    fn scan_finds_nested_matches_and_skips_hidden_and_packages() {
        let base = std::env::temp_dir().join(format!("wf-search-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("a/b")).unwrap();
        fs::create_dir_all(base.join(".git")).unwrap();
        fs::create_dir_all(base.join("Tool.app/Contents")).unwrap();
        fs::write(base.join("a/b/Report.pdf"), "x").unwrap();
        fs::write(base.join("report-notes.txt"), "x").unwrap();
        fs::write(base.join(".git/report-hidden"), "x").unwrap();
        fs::write(base.join("Tool.app/Contents/report-inner"), "x").unwrap();
        let cancel = AtomicBool::new(false);

        let mut s = sink();
        assert!(!run_scan(&base, "REPORT", false, &cancel, &mut s));
        assert_eq!(s.count, 2);

        let mut s = sink();
        run_scan(&base, "report", true, &cancel, &mut s);
        assert_eq!(s.count, 3, "hidden shown, package interior still skipped");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn buried_detects_hidden_and_package_ancestors() {
        let root = Path::new("/r");
        assert!(buried(root, Path::new("/r/.git/x"), false));
        assert!(!buried(root, Path::new("/r/.git/x"), true));
        assert!(buried(root, Path::new("/r/T.app/Contents/x"), true));
        assert!(!buried(root, Path::new("/r/.hidden"), false), "the item itself is judged by build_entry");
        assert!(!buried(root, Path::new("/r/a/b"), false));
    }

    #[test]
    fn spotlight_results_map_back_under_a_symlinked_root() {
        let root = Path::new("/var/folders/x");
        let real = Some(Path::new("/private/var/folders/x"));
        let p = Path::new("/private/var/folders/x/a/b.txt");
        assert_eq!(under_root(root, real, p), Path::new("/var/folders/x/a/b.txt"));
        assert_eq!(under_root(root, real, Path::new("/private/var/folders/x")), root);
        let elsewhere = Path::new("/Users/me/b.txt");
        assert_eq!(under_root(root, real, elsewhere), elsewhere, "left for buried() to drop");
        let plain = Path::new("/var/folders/x/c");
        assert_eq!(under_root(root, None, plain), plain);
    }

    #[test]
    fn cancelled_scan_stops() {
        let base = std::env::temp_dir().join(format!("wf-search2-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join("x.txt"), "x").unwrap();
        let cancel = AtomicBool::new(true);
        let mut s = sink();
        run_scan(&base, "x", false, &cancel, &mut s);
        assert_eq!(s.count, 0);
        fs::remove_dir_all(&base).unwrap();
    }
}
