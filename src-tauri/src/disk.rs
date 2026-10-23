use serde::Serialize;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;

use crate::jobs::{job_key, Cancels};

const TOP_FILES: usize = 100;

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub bytes: u64,
    pub files: u64,
    pub current: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TopFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_ms: u64,
    pub category: &'static str,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FolderUse {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub is_dir: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CategoryUse {
    pub key: &'static str,
    pub bytes: u64,
    pub files: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiskReport {
    pub root: String,
    pub total_bytes: u64,
    pub total_files: u64,
    pub folders: Vec<FolderUse>,
    pub categories: Vec<CategoryUse>,
    pub top_files: Vec<TopFile>,
    pub scanned_ms: u64,
    pub cancelled: bool,
    pub skipped: Vec<String>,
    /// Folders that couldn't be read (macOS hasn't let Doftar into them,
    /// say), so what's in them isn't in the totals.
    pub unreadable: u64,
}

static CANCELS: Cancels = Cancels::new();

#[tauri::command]
pub fn cancel_disk_scan(webview: tauri::Webview, scan_id: u64) {
    CANCELS.cancel(job_key(&webview, scan_id));
}

fn category(ext: &str, in_app: bool) -> &'static str {
    if in_app {
        return "apps";
    }
    match ext {
        "app" | "dmg" | "pkg" | "ipa" => "apps",
        "jpg" | "jpeg" | "png" | "gif" | "heic" | "heif" | "tif" | "tiff" | "bmp" | "webp"
        | "raw" | "cr2" | "nef" | "arw" | "dng" | "psd" | "svg" | "ai" => "images",
        "mov" | "mp4" | "m4v" | "avi" | "mkv" | "webm" | "wmv" | "flv" | "mpg" | "mpeg" => "video",
        "mp3" | "m4a" | "aac" | "wav" | "flac" | "aiff" | "aif" | "ogg" | "opus" | "wma" => "audio",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "pages" | "numbers" | "key"
        | "txt" | "rtf" | "md" | "csv" | "epub" | "odt" => "documents",
        "zip" | "gz" | "tgz" | "bz2" | "xz" | "7z" | "rar" | "tar" | "iso" => "archives",
        "rs" | "js" | "ts" | "tsx" | "jsx" | "py" | "c" | "h" | "cpp" | "hpp" | "java" | "go"
        | "swift" | "kt" | "rb" | "php" | "json" | "html" | "css" | "sh" | "o" | "a" | "dylib"
        | "class" | "jar" | "pyc" | "map" => "code",
        _ => "other",
    }
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn mtime_ms(m: &fs::Metadata) -> u64 {
    if m.mtime() < 0 {
        return 0;
    }
    m.mtime() as u64 * 1000 + (m.mtime_nsec().max(0) as u64) / 1_000_000
}

fn cloud_label(root: &Path, path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_str()?;
    let parent = path.parent()?;
    if parent == root {
        return match name {
            "Dropbox" => Some("Dropbox"),
            "Google Drive" | "GoogleDrive" => Some("Google Drive"),
            "Box" | "Box Sync" => Some("Box"),
            "MEGA" => Some("MEGA"),
            "pCloud Drive" => Some("pCloud"),
            n if n.starts_with("OneDrive") => Some("OneDrive"),
            _ => None,
        };
    }
    if parent.file_name()? == "Library" && parent.parent()? == root {
        return match name {
            "CloudStorage" => Some("Cloud storage"),
            "Mobile Documents" => Some("iCloud Drive"),
            _ => None,
        };
    }
    None
}

/// A file at least this big gets a block of its own in the folder map.
const BIG_FILE: u64 = 1 << 20;
/// Folders smaller than this fold into their parent's "smaller items" once
/// the scan is done, which keeps the map small in memory.
const KEEP_DIR: u64 = 256 << 10;
/// The most folders and big files a scan records for the map; beyond it,
/// what it finds counts towards the nearest one recorded.
const MAX_NODES: usize = 1_000_000;
/// Kinds of file, in the order a node counts their bytes.
const CATS: [&str; 8] = ["apps", "images", "video", "audio", "documents", "archives", "code", "other"];

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Dir,
    /// An app bundle, shown as one block like a file.
    App,
    File,
}

/// A folder or big file while a scan records it. `bytes` is its own files
/// until the scan is done, then everything under it.
struct RawNode {
    parent: u32,
    name: Box<str>,
    bytes: u64,
    kind: Kind,
    cats: [u64; 8],
}

fn cat_index(cat: &str) -> usize {
    CATS.iter().position(|c| *c == cat).unwrap_or(CATS.len() - 1)
}

struct Scan<'a> {
    root: &'a Path,
    skipped: Vec<String>,
    cancel: &'a AtomicBool,
    emit: &'a mut dyn FnMut(&ScanProgress),
    seen: HashSet<(u64, u64)>,
    heap: BinaryHeap<Reverse<(u64, String, u64)>>,
    cats: HashMap<&'static str, (u64, u64)>,
    nodes: Vec<RawNode>,
    bytes: u64,
    files: u64,
    unreadable: u64,
    last: Instant,
}

impl<'a> Scan<'a> {
    fn skip_cloud(&mut self, path: &Path) -> bool {
        let Some(label) = cloud_label(self.root, path) else { return false };
        if !self.skipped.iter().any(|l| l == label) {
            self.skipped.push(label.to_string());
        }
        true
    }

    /// Records a folder or big file under `parent`; `parent` itself when the
    /// map is full.
    fn node(&mut self, parent: u32, path: &Path, kind: Kind) -> u32 {
        if self.nodes.len() >= MAX_NODES {
            return parent;
        }
        let name = path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
        self.nodes.push(RawNode { parent, name: name.into(), bytes: 0, kind, cats: [0; 8] });
        (self.nodes.len() - 1) as u32
    }

    fn add_file(&mut self, m: &fs::Metadata, path: &Path, in_app: bool, at: u32) -> u64 {
        self.files += 1;
        if m.nlink() > 1 && !self.seen.insert((m.dev(), m.ino())) {
            return 0;
        }
        let size = m.blocks() * 512;
        self.bytes += size;
        let ext = ext_of(path);
        let cat = category(&ext, in_app);
        let c = self.cats.entry(cat).or_default();
        c.0 += size;
        c.1 += 1;
        let beats = self.heap.len() < TOP_FILES
            || self.heap.peek().is_some_and(|Reverse((min, _, _))| size > *min);
        if !in_app && size > 0 && beats {
            self.heap
                .push(Reverse((size, path.to_string_lossy().into_owned(), mtime_ms(m))));
            if self.heap.len() > TOP_FILES {
                self.heap.pop();
            }
        }
        let at = if !in_app && size >= BIG_FILE { self.node(at, path, Kind::File) } else { at };
        let n = &mut self.nodes[at as usize];
        n.bytes += size;
        n.cats[cat_index(cat)] += size;
        size
    }

    /// Walks the folder `root`, recorded as node `at`.
    fn walk(&mut self, root: &Path, dev: u64, in_app: bool, at: u32) -> Option<u64> {
        let before = self.bytes;
        let mut stack = vec![(root.to_path_buf(), in_app, at)];
        while let Some((dir, in_app, at)) = stack.pop() {
            if self.cancel.load(Ordering::Relaxed) {
                return None;
            }
            let Ok(rd) = fs::read_dir(&dir) else {
                self.unreadable += 1;
                continue;
            };
            for item in rd.flatten() {
                let Ok(m) = item.metadata() else { continue };
                let ft = m.file_type();
                if ft.is_symlink() {
                    continue;
                }
                let path = item.path();
                if ft.is_dir() {
                    if m.dev() == dev && !self.skip_cloud(&path) {
                        // Inside an app bundle everything counts towards the bundle.
                        let (app, node) = if in_app {
                            (true, at)
                        } else if ext_of(&path) == "app" {
                            (true, self.node(at, &path, Kind::App))
                        } else {
                            (false, self.node(at, &path, Kind::Dir))
                        };
                        stack.push((path, app, node));
                    }
                } else {
                    self.add_file(&m, &path, in_app, at);
                }
            }
            if self.last.elapsed() >= Duration::from_millis(100) {
                self.last = Instant::now();
                (self.emit)(&ScanProgress {
                    bytes: self.bytes,
                    files: self.files,
                    current: dir.to_string_lossy().into_owned(),
                });
            }
        }
        Some(self.bytes - before)
    }
}

/// A folder, app or big file in the folder map, with everything under it.
struct MapEntry {
    name: Box<str>,
    bytes: u64,
    kind: Kind,
    /// The kind of file that takes most of its space, as an index into `CATS`.
    cat: u8,
    children: Vec<u32>,
}

/// What a scan found, folder by folder, for the folder map; node 0 is the
/// folder scanned.
pub struct SizeTree {
    root: String,
    nodes: Vec<MapEntry>,
}

impl SizeTree {
    /// Adds every node's size into its parent's (a child is always recorded
    /// after its parent), then keeps the big ones, children largest first.
    fn build(root: &Path, mut raw: Vec<RawNode>) -> SizeTree {
        for i in (1..raw.len()).rev() {
            let (bytes, cats, parent) = (raw[i].bytes, raw[i].cats, raw[i].parent);
            let p = &mut raw[parent as usize];
            p.bytes += bytes;
            for (a, b) in p.cats.iter_mut().zip(cats) {
                *a += b;
            }
        }
        // A kept node's parent is at least as big, so it is kept too.
        let keep = |i: usize, n: &RawNode| {
            i == 0 || n.parent == 0 || n.kind == Kind::File || n.bytes >= KEEP_DIR
        };
        let mut index = vec![u32::MAX; raw.len()];
        let mut nodes: Vec<MapEntry> = Vec::new();
        for (i, n) in raw.iter().enumerate() {
            if !keep(i, n) {
                continue;
            }
            index[i] = nodes.len() as u32;
            let cat = (0..CATS.len()).max_by_key(|&c| n.cats[c]).filter(|&c| n.cats[c] > 0);
            nodes.push(MapEntry {
                name: n.name.clone(),
                bytes: n.bytes,
                kind: n.kind,
                cat: cat.unwrap_or(CATS.len() - 1) as u8,
                children: Vec::new(),
            });
            if i > 0 {
                let p = index[n.parent as usize] as usize;
                let me = nodes.len() as u32 - 1;
                nodes[p].children.push(me);
            }
        }
        for i in 0..nodes.len() {
            let mut kids = std::mem::take(&mut nodes[i].children);
            kids.sort_by_key(|&k| Reverse(nodes[k as usize].bytes));
            nodes[i].children = kids;
        }
        SizeTree { root: root.to_string_lossy().into_owned(), nodes }
    }

    /// The node at `path`, found by name from the folder scanned.
    fn find(&self, path: &str) -> Option<usize> {
        let rest = path.strip_prefix(self.root.as_str())?;
        if !rest.is_empty() && !rest.starts_with('/') && !self.root.ends_with('/') {
            return None;
        }
        let mut at = 0usize;
        for part in rest.split('/').filter(|p| !p.is_empty()) {
            at = self.nodes[at]
                .children
                .iter()
                .map(|&c| c as usize)
                .find(|&c| &*self.nodes[c].name == part)?;
        }
        Some(at)
    }

    fn slice(&self, at: usize, path: &str, depth: u8) -> MapNode {
        let n = &self.nodes[at];
        let kind = match n.kind {
            Kind::Dir => "dir",
            Kind::App => "app",
            Kind::File => "file",
        };
        let children = (depth > 0 && n.kind == Kind::Dir).then(|| {
            let mut out = Vec::new();
            let mut shown = 0u64;
            for &c in &n.children {
                let child = &self.nodes[c as usize];
                if child.bytes == 0 {
                    continue;
                }
                if out.len() >= MAP_MAX_CHILDREN
                    || (child.bytes as f64) < n.bytes as f64 * MAP_MIN_SHARE
                {
                    break;
                }
                shown += child.bytes;
                let child_path = if path.ends_with('/') {
                    format!("{path}{}", child.name)
                } else {
                    format!("{path}/{}", child.name)
                };
                out.push(self.slice(c as usize, &child_path, depth - 1));
            }
            let rest = n.bytes.saturating_sub(shown);
            if rest > 0 {
                out.push(MapNode {
                    name: "Smaller items".into(),
                    path: None,
                    bytes: rest,
                    kind: "rest",
                    cat: CATS[n.cat as usize],
                    children: None,
                });
            }
            out
        });
        MapNode {
            name: n.name.to_string(),
            path: Some(path.to_string()),
            bytes: n.bytes,
            kind,
            cat: CATS[n.cat as usize],
            children,
        }
    }

    /// Takes the items at `paths` off the map, their sizes off every folder
    /// above them.
    fn forget(&mut self, paths: &[String]) {
        for path in paths {
            let Some(at) = self.find(path) else { continue };
            let bytes = self.nodes[at].bytes;
            if bytes == 0 {
                continue;
            }
            let mut chain = Vec::new();
            let mut cur = 0usize;
            let rest = &path[self.root.len()..];
            for part in rest.split('/').filter(|p| !p.is_empty()) {
                chain.push(cur);
                let Some(next) = self.nodes[cur]
                    .children
                    .iter()
                    .map(|&c| c as usize)
                    .find(|&c| &*self.nodes[c].name == part)
                else {
                    break;
                };
                cur = next;
            }
            for i in chain {
                self.nodes[i].bytes = self.nodes[i].bytes.saturating_sub(bytes);
            }
            self.nodes[at].bytes = 0;
        }
    }
}

/// Children smaller than this share of their folder fold into "Smaller items".
const MAP_MIN_SHARE: f64 = 0.004;
const MAP_MAX_CHILDREN: usize = 80;

/// A piece of the folder map as the page draws it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MapNode {
    pub name: String,
    /// None for "Smaller items".
    pub path: Option<String>,
    pub bytes: u64,
    /// "dir", "app", "file" or "rest".
    pub kind: &'static str,
    pub cat: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<MapNode>>,
}

/// The folder map from the last scan that finished.
static TREE: Mutex<Option<SizeTree>> = Mutex::new(None);

/// The folder map at `path`, `depth` levels down; none when the last scan
/// that finished doesn't cover it (or nothing was scanned since Doftar
/// started).
#[tauri::command(async)]
pub fn disk_map(path: String, depth: u8) -> Option<MapNode> {
    let tree = TREE.lock().unwrap();
    let tree = tree.as_ref()?;
    let at = tree.find(&path)?;
    Some(tree.slice(at, &path, depth.min(3)))
}

/// Items moved to the Trash or deleted from the Disk view leave the map.
#[tauri::command(async)]
pub fn disk_map_forget(paths: Vec<String>) {
    if let Some(tree) = TREE.lock().unwrap().as_mut() {
        tree.forget(&paths);
    }
}

fn scan(
    root: &Path,
    cancel: &AtomicBool,
    emit: &mut dyn FnMut(&ScanProgress),
) -> Result<(DiskReport, SizeTree), String> {
    let meta = fs::symlink_metadata(root).map_err(|e| e.to_string())?;
    if !meta.is_dir() {
        return Err("Not a folder".into());
    }
    let dev = meta.dev();
    let mut s = Scan {
        root,
        skipped: Vec::new(),
        cancel,
        emit,
        seen: HashSet::new(),
        heap: BinaryHeap::new(),
        cats: HashMap::new(),
        nodes: vec![RawNode {
            parent: 0,
            name: root.to_string_lossy().into(),
            bytes: 0,
            kind: Kind::Dir,
            cats: [0; 8],
        }],
        bytes: 0,
        files: 0,
        unreadable: 0,
        last: Instant::now(),
    };

    let mut folders: Vec<FolderUse> = Vec::new();
    let mut loose = 0u64;
    let mut cancelled = false;
    let rd = fs::read_dir(root).map_err(|e| e.to_string())?;
    for item in rd.flatten() {
        let Ok(m) = item.metadata() else { continue };
        let ft = m.file_type();
        if ft.is_symlink() {
            continue;
        }
        let path = item.path();
        if ft.is_dir() {
            if m.dev() != dev || s.skip_cloud(&path) {
                continue;
            }
            let in_app = ext_of(&path) == "app";
            let node = s.node(0, &path, if in_app { Kind::App } else { Kind::Dir });
            let before = s.bytes;
            let done = s.walk(&path, dev, in_app, node);
            if done.is_none() {
                cancelled = true;
                break;
            }
            folders.push(FolderUse {
                name: item.file_name().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                bytes: s.bytes - before,
                is_dir: true,
            });
        } else {
            loose += s.add_file(&m, &path, false, 0);
        }
        if s.cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
    }
    if loose > 0 {
        folders.push(FolderUse {
            name: "Files in this folder".into(),
            path: root.to_string_lossy().into_owned(),
            bytes: loose,
            is_dir: false,
        });
    }
    folders.sort_by(|a, b| b.bytes.cmp(&a.bytes));

    let mut categories: Vec<CategoryUse> = s
        .cats
        .iter()
        .map(|(k, (b, n))| CategoryUse { key: k, bytes: *b, files: *n })
        .collect();
    categories.sort_by(|a, b| b.bytes.cmp(&a.bytes));

    let top_files = s
        .heap
        .into_sorted_vec()
        .into_iter()
        .map(|Reverse((size, path, modified_ms))| TopFile {
            name: Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            category: category(&ext_of(Path::new(&path)), false),
            path,
            size,
            modified_ms,
        })
        .collect();

    let report = DiskReport {
        root: root.to_string_lossy().into_owned(),
        total_bytes: s.bytes,
        total_files: s.files,
        folders,
        categories,
        top_files,
        scanned_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        cancelled,
        skipped: s.skipped,
        unreadable: s.unreadable,
    };
    Ok((report, SizeTree::build(root, s.nodes)))
}

#[tauri::command]
pub async fn disk_scan(
    root: String,
    scan_id: u64,
    on_progress: Channel<ScanProgress>,
    webview: tauri::Webview,
) -> Result<DiskReport, String> {
    let key = job_key(&webview, scan_id);
    crate::jobs::blocking(move || {
        let cancel = CANCELS.begin(key.clone());
        let result = scan(Path::new(&root), &cancel, &mut |p| {
            let _ = on_progress.send(p.clone());
        });
        CANCELS.end(&key, &cancel);
        let (report, tree) = result?;
        if !report.cancelled {
            *TREE.lock().unwrap() = Some(tree);
        }
        Ok(report)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_a_tree_by_folder_kind_and_largest_files() {
        let base = std::env::temp_dir().join(format!("wf-disk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("media")).unwrap();
        fs::create_dir_all(base.join("Tool.app/Contents")).unwrap();
        fs::write(base.join("media/big.mov"), vec![1u8; 200_000]).unwrap();
        fs::write(base.join("media/pic.png"), vec![2u8; 50_000]).unwrap();
        fs::write(base.join("Tool.app/Contents/bin"), vec![3u8; 300_000]).unwrap();
        fs::write(base.join("loose.zip"), vec![4u8; 100_000]).unwrap();
        fs::hard_link(base.join("loose.zip"), base.join("media/link.zip")).unwrap();
        std::os::unix::fs::symlink("/", base.join("rootlink")).unwrap();
        fs::create_dir_all(base.join("Dropbox")).unwrap();
        fs::write(base.join("Dropbox/synced.bin"), vec![5u8; 400_000]).unwrap();
        fs::create_dir_all(base.join("Library/CloudStorage/OneDrive-Work")).unwrap();
        fs::write(base.join("Library/CloudStorage/OneDrive-Work/x.bin"), vec![6u8; 400_000]).unwrap();

        let never = AtomicBool::new(false);
        let (r, tree) = scan(&base, &never, &mut |_| {}).unwrap();
        assert!(!r.cancelled);
        assert_eq!(r.unreadable, 0);
        let mut skipped = r.skipped.clone();
        skipped.sort();
        assert_eq!(skipped, ["Cloud storage", "Dropbox"], "cloud folders are not read");
        assert!(r.top_files.iter().all(|f| f.size < 400_000), "nothing under them is counted");
        assert_eq!(r.total_files, 5, "symlink skipped, hard link still a file");
        let names: Vec<_> = r.top_files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["big.mov", "loose.zip", "pic.png"], "app bundle contents are not listed");
        assert_eq!(r.top_files[0].category, "video");
        let cat = |k: &str| r.categories.iter().find(|c| c.key == k).map(|c| c.bytes).unwrap_or(0);
        assert!(cat("apps") >= 300_000);
        assert!(cat("archives") >= 100_000 && cat("archives") < 200_000, "hard link counted once");
        assert_eq!(r.folders[0].name, "Tool.app");
        assert!(r.folders.iter().any(|f| !f.is_dir && f.bytes >= 100_000));

        assert_eq!(tree.nodes[0].bytes, r.total_bytes, "the map adds up to the scan");
        let root = base.to_string_lossy().into_owned();
        let map = tree.slice(0, &root, 1);
        let kids = map.children.unwrap();
        assert_eq!(kids.iter().map(|k| k.bytes).sum::<u64>(), r.total_bytes);
        let app = kids.iter().find(|k| k.name == "Tool.app").unwrap();
        assert_eq!((app.kind, app.cat), ("app", "apps"), "a bundle is one block");
        assert!(tree.find(&format!("{root}/Tool.app/Contents")).is_none());

        let stop = AtomicBool::new(true);
        assert!(scan(&base, &stop, &mut |_| {}).unwrap().0.cancelled);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn counts_the_folders_it_cannot_read() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("wf-disk-locked-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("open/locked")).unwrap();
        fs::write(base.join("open/locked/x.bin"), vec![1u8; 10_000]).unwrap();
        fs::create_dir_all(base.join("shut")).unwrap();
        let lock = |p: &str, mode| fs::set_permissions(base.join(p), fs::Permissions::from_mode(mode)).unwrap();
        lock("open/locked", 0o000);
        lock("shut", 0o000);

        let never = AtomicBool::new(false);
        let r = scan(&base, &never, &mut |_| {}).unwrap().0;
        lock("open/locked", 0o755);
        lock("shut", 0o755);
        fs::remove_dir_all(&base).unwrap();
        // Root can read anything, so there's nothing to count.
        if unsafe { libc::geteuid() } != 0 {
            assert_eq!(r.unreadable, 2, "nested and top-level");
            assert_eq!(r.total_files, 0);
        }
    }

    #[test]
    fn the_folder_map_keeps_big_files_and_forgets_trashed_ones() {
        let base = std::env::temp_dir().join(format!("wf-diskmap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("a/b")).unwrap();
        fs::write(base.join("a/b/huge.mov"), vec![1u8; 3 << 20]).unwrap();
        fs::write(base.join("a/note.txt"), vec![2u8; 4_000]).unwrap();
        fs::create_dir_all(base.join("a/tiny")).unwrap();
        fs::write(base.join("a/tiny/x.txt"), vec![3u8; 1_000]).unwrap();

        let never = AtomicBool::new(false);
        let (_, mut tree) = scan(&base, &never, &mut |_| {}).unwrap();
        let root = base.to_string_lossy().into_owned();
        assert!(tree.find(&format!("{root}/a/tiny")).is_none(), "small folders fold away");
        let a = format!("{root}/a");
        let map = tree.slice(tree.find(&a).unwrap(), &a, 2);
        let kids = map.children.as_ref().unwrap();
        assert_eq!(kids[0].name, "b");
        let huge = &kids[0].children.as_ref().unwrap()[0];
        assert_eq!((huge.kind, huge.cat), ("file", "video"));
        assert_eq!(huge.path.as_deref(), Some(&*format!("{a}/b/huge.mov")));
        assert!(kids.iter().any(|k| k.kind == "rest"), "the small files make one block");

        let before = tree.nodes[0].bytes;
        tree.forget(&[format!("{a}/b/huge.mov")]);
        assert!(tree.nodes[0].bytes <= before - (3 << 20));
        let b = format!("{a}/b");
        assert_eq!(tree.slice(tree.find(&b).unwrap(), &b, 1).bytes, 0);
        fs::remove_dir_all(&base).unwrap();
    }
}
