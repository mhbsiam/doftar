use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use crate::guard;
use crate::launcher::{applescript_quote, shell_quote};
use crate::jobs::{self, Job, JobGuard, OpResult, Progress, Step};
use crate::tags::Tag;
use tauri::ipc::Channel;

fn strerr<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn unix_ms(t: std::io::Result<std::time::SystemTime>) -> u64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_hidden: bool,
    pub is_symlink: bool,
    pub is_alias: bool,
    pub is_package: bool,
    pub size: u64,
    pub modified_ms: u64,
    pub created_ms: u64,
    pub ext: String,
    /// Device and inode. Survives renames and same-volume moves.
    pub file_id: String,
    /// Finder tags, oldest first. A folder listing reads them only for labelled items.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<Tag>,
    /// The content of the cloud file is not on this Mac.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_dataless: bool,
}

fn file_id_of(meta: &fs::Metadata) -> String {
    format!("{}:{}", meta.dev(), meta.ino())
}

pub fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.') || name == "desktop.ini" || name.starts_with("._") || name == "Icon\r"
}

#[cfg(target_os = "macos")]
const UF_HIDDEN: u32 = 0x8000;

pub(crate) fn has_hidden_flag(meta: &fs::Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt as _;
        meta.st_flags() & UF_HIDDEN != 0
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = meta;
        false
    }
}

pub const PACKAGE_EXTS: &[&str] = &[
    "app", "bundle", "framework", "pages", "numbers", "key", "xcodeproj",
    "xcworkspace", "playground", "photoslibrary", "band", "sparsebundle",
    "plugin", "prefpane", "qlgenerator", "kext", "docset", "rtfd", "appex",
    "xpc", "saver", "mdimporter", "xcarchive",
];

pub(crate) fn is_package_dir(path: &Path, ext: &str) -> bool {
    if PACKAGE_EXTS.contains(&ext) {
        return true;
    }
    if ext.is_empty() {
        return false;
    }
    let info = path.join("Contents").join("Info.plist");
    if !info.is_file() {
        return false;
    }
    plist::Value::from_file(&info)
        .ok()
        .and_then(|v| {
            v.as_dictionary()
                .and_then(|d| d.get("LSTypeIsPackage"))
                .and_then(|b| b.as_boolean())
        })
        .unwrap_or(false)
}

/// Finder alias files are smaller. Skip the alias check for bigger files.
pub(crate) const ALIAS_MAX_BYTES: u64 = 4 * 1024 * 1024;

pub fn build_entry(
    p: &Path,
    name: String,
    lmeta: fs::Metadata,
    show_hidden: bool,
) -> Option<FileEntry> {
    let mut entry = build_entry_untagged(p, name, lmeta, show_hidden)?;
    entry.tags = crate::tags::read(p);
    Some(entry)
}

pub(crate) fn build_entry_untagged(
    p: &Path,
    name: String,
    lmeta: fs::Metadata,
    show_hidden: bool,
) -> Option<FileEntry> {
    let hidden = is_hidden_name(&name) || has_hidden_flag(&lmeta);
    if !show_hidden && hidden {
        return None;
    }
    let is_symlink = lmeta.file_type().is_symlink();
    let meta = if is_symlink {
        fs::metadata(p).unwrap_or_else(|_| lmeta.clone())
    } else {
        lmeta
    };
    let is_dir = meta.is_dir();
    let raw_ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let is_package = is_dir && is_package_dir(p, &raw_ext);
    let ext = if is_dir && !is_package {
        String::new()
    } else {
        raw_ext
    };
    Some(FileEntry {
        name,
        path: p.to_string_lossy().to_string(),
        is_dir,
        is_hidden: hidden,
        is_symlink,
        is_alias: meta.is_file() && meta.len() <= ALIAS_MAX_BYTES && crate::alias::is_alias_file(p),
        is_package,
        size: if is_dir { 0 } else { meta.len() },
        modified_ms: unix_ms(meta.modified()),
        created_ms: unix_ms(meta.created()),
        ext,
        file_id: file_id_of(&meta),
        tags: Vec::new(),
        is_dataless: !is_dir && crate::thumbs::is_dataless(&meta),
    })
}

mod copy;
mod delete;
mod list;
mod steps;
mod terminal;
mod transfer;

use copy::*;
pub use delete::*;
pub use list::*;
pub use steps::*;
pub use terminal::*;
pub use transfer::*;

/// True when `dest_dir` is `source` or inside it. Compares device and inode up the real path
/// of `dest_dir`. Symlinks, firmlinks and letter case cannot fool it.
/// A symlink `source` is moved as the link, so it contains nothing.
fn is_within_subtree(source: &Path, dest_dir: &Path) -> bool {
    let Ok(s) = fs::symlink_metadata(source) else { return false };
    if !s.is_dir() {
        return false;
    }
    let d = fs::canonicalize(dest_dir).unwrap_or_else(|_| dest_dir.to_path_buf());
    d.ancestors()
        .filter_map(|p| fs::metadata(p).ok())
        .any(|m| m.dev() == s.dev() && m.ino() == s.ino())
}

/// True when replacing `container` with `item` would lose `item`.
/// This is the case when `item` is inside `container`, or is a symlink to it or into it.
fn holds_item(container: &Path, item: &Path) -> bool {
    item.parent().is_some_and(|p| is_within_subtree(container, p))
        || fs::canonicalize(item).is_ok_and(|real| is_within_subtree(container, &real))
        || same_inode(fs::metadata(item), fs::symlink_metadata(container))
}

fn same_inode(a: std::io::Result<fs::Metadata>, b: std::io::Result<fs::Metadata>) -> bool {
    matches!((a, b), (Ok(a), Ok(b)) if a.dev() == b.dev() && a.ino() == b.ino())
}

/// False when the dot is part of the name, as in "Project v1.2".
fn plausible_ext(ext: &str) -> bool {
    (1..=12).contains(&ext.len())
        && ext.chars().all(|c| c.is_ascii_alphanumeric())
        && ext.chars().any(|c| c.is_ascii_alphabetic())
}

/// Splits `name` into stem and extension with its dot. "a.tar.gz" is ("a", ".tar.gz").
/// A plain folder, a dot file and an implausible extension keep the whole name as the stem.
pub(crate) fn split_ext(name: &str, plain_dir: bool) -> (&str, &str) {
    let Some(i) = name.rfind('.').filter(|&i| i > 0 && !plain_dir) else {
        return (name, "");
    };
    if !plausible_ext(&name[i + 1..]) {
        return (name, "");
    }
    let stem = &name[..i];
    match stem.rfind('.') {
        Some(j) if j > 0 && stem[j + 1..].eq_ignore_ascii_case("tar") => name.split_at(j),
        _ => name.split_at(i),
    }
}

pub(crate) fn is_plain_dir(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.is_dir())
        && !is_package_dir(
            p,
            &p.extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default(),
        )
}

fn copy_candidate(name: &str, n: usize, plain_dir: bool) -> String {
    if n == 0 {
        return name.to_string();
    }
    let (stem, ext) = split_ext(name, plain_dir);
    format!("{}_copy_{}{}", stem, n, ext)
}

fn same_dir(a: Option<&Path>, b: &Path) -> bool {
    let Some(a) = a else { return false };
    // Check identity first. `canonicalize` does not resolve firmlinks.
    if same_inode(fs::metadata(a), fs::metadata(b)) {
        return true;
    }
    let ca = fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let cb = fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

pub(crate) fn unique_name(dir: &Path, base: &str, ext: &str) -> String {
    let mut name = format!("{}{}", base, ext);
    let mut n = 2;
    // A dangling symlink holds a name too. A write to it goes to its target.
    while exists(&dir.join(&name)) {
        name = format!("{} ({}){}", base, n, ext);
        n += 1;
    }
    name
}

pub(crate) fn path_str(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

pub(crate) fn label(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path_str(p))
}

fn exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

fn remove_path(p: &Path) {
    let _ = remove_path_checked(p);
}

fn remove_path_checked(p: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(p),
        Ok(_) => fs::remove_file(p),
        Err(_) => Ok(()),
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn a_copy_with_one_changed_byte_fails_verification() {
        let base = scratch("verify");
        fs::create_dir_all(base.join("src/sub")).unwrap();
        fs::write(base.join("src/a"), "12345").unwrap();
        fs::write(base.join("src/sub/b"), "678").unwrap();
        let job = jobs::detached();
        copy_item(&base.join("src"), &base.join("dst"), &job).unwrap();
        verify_tree(&base.join("src"), &base.join("dst"), &job).unwrap();
        // Same size, so the count and byte totals of a move would not notice.
        fs::write(base.join("dst/sub/b"), "679").unwrap();
        let err = verify_tree(&base.join("src"), &base.join("dst"), &job).unwrap_err();
        assert!(err.to_string().contains("didn't match"), "{err}");
        fs::remove_dir_all(&base).unwrap();
    }

    fn scratch(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("wf-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn launch_removes_partials_of_dead_runs_only() {
        let base = scratch("sweep");
        let (dest, journals) = (base.join("dest"), base.join("journals"));
        fs::create_dir_all(dest.join(".wf-partial-1-0")).unwrap();
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let dead = child.id();
        child.wait().unwrap();
        let live = std::process::id();
        for pid in [dead, live] {
            fs::create_dir_all(dest.join(format!(".wf-partial-{pid}-0"))).unwrap();
            fs::create_dir_all(&journals).unwrap();
            fs::write(journals.join(pid.to_string()), [dest.as_os_str().as_bytes(), b"\n"].concat()).unwrap();
        }
        sweep_journals(&journals);
        assert!(!dest.join(format!(".wf-partial-{dead}-0")).exists());
        assert!(dest.join(format!(".wf-partial-{live}-0")).exists());
        // Another run's partial, not in this journal, stays.
        assert!(dest.join(".wf-partial-1-0").exists());
        assert!(!journals.join(dead.to_string()).exists());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_new_text_file_never_overwrites() {
        let base = scratch("new-text");
        let make = || {
            tauri::async_runtime::block_on(create_text_file(
                path_str(&base),
                "Disk usage".into(),
                ".csv".into(),
                "a,b\n".into(),
            ))
            .unwrap()
        };
        let (first, second) = (make(), make());
        assert_ne!(first, second);
        assert_eq!(fs::read_to_string(&second).unwrap(), "a,b\n");
        assert!(guard::check(&dirs::home_dir().unwrap().join("Downloads/x.csv")).is_ok());
    }

    #[test]
    fn undoing_a_new_item_or_rename_spares_a_replacement() {
        let base = scratch("undo-id");
        let job = jobs::detached();
        let replace = |p: &Path| {
            fs::write(base.join("other"), "other").unwrap();
            fs::rename(base.join("other"), p).unwrap();
        };

        let made = create_file(path_str(&base)).unwrap();
        let Step::Trash { path, .. } = &made else { panic!("{made:?}") };
        replace(Path::new(path));
        let res = run_steps(std::slice::from_ref(&made), &job);
        assert!(res.errors[0].contains("replaced"), "{:?}", res.errors);
        assert_eq!(res.failed, vec![made.clone()]);
        assert_eq!(fs::read_to_string(path).unwrap(), "other");

        fs::write(base.join("a"), "a").unwrap();
        let undo = rename_path(path_str(&base.join("a")), path_str(&base.join("b"))).unwrap();
        replace(&base.join("b"));
        let res = run_steps(&[undo], &job);
        assert!(res.errors[0].contains("replaced"), "{:?}", res.errors);
        assert!(!base.join("a").exists());
        assert_eq!(fs::read_to_string(base.join("b")).unwrap(), "other");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_cancelled_undo_hands_back_the_steps_it_did_not_run() {
        let base = scratch("undo-left");
        fs::write(base.join("a"), "a").unwrap();
        let steps = vec![Step::trash(path_str(&base.join("a"))), Step::trash(path_str(&base.join("b")))];
        let job = jobs::detached();
        job.cancel();
        let res = run_steps(&steps, &job);
        assert!(res.cancelled);
        assert_eq!(res.left, steps);
        assert!(res.inverse.is_empty());
        assert!(base.join("a").exists());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn copying_never_overwrites_an_item_already_there() {
        let base = scratch("excl");
        fs::write(base.join("src"), "new").unwrap();
        fs::write(base.join("dst"), "old").unwrap();
        let job = jobs::detached();
        assert!(copy_item(&base.join("src"), &base.join("dst"), &job).is_err());
        assert_eq!(fs::read_to_string(base.join("dst")).unwrap(), "old");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_verified_copy_counts_every_item_but_metadata_files() {
        let base = scratch("verify");
        fs::create_dir_all(base.join("src/sub")).unwrap();
        fs::write(base.join("src/a"), "12345").unwrap();
        fs::write(base.join("src/sub/b"), "678").unwrap();
        let job = jobs::detached();
        copy_verified(&base.join("src"), &base.join("dst"), &job).unwrap();
        fs::write(base.join("dst/._a"), "metadata").unwrap();
        fs::write(base.join("src/.DS_Store"), "finder").unwrap();
        assert_eq!(tree_stats(&base.join("dst")).unwrap(), (4, 8));
        assert_eq!(tree_stats(&base.join("src")).unwrap(), tree_stats(&base.join("dst")).unwrap());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn warp_strings_keep_newlines_inside_the_quotes() {
        assert_eq!(yaml_str("a \"b\"\nc\\"), "\"a \\\"b\\\"\\nc\\\\\"");
    }

    #[test]
    fn transfer_moves_on_same_volume_and_copies_when_forced() {
        let base = scratch("xfer");
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        fs::write(base.join("a.txt"), "a").unwrap();
        fs::write(base.join("b.txt"), "b").unwrap();
        let d = dest.to_string_lossy().to_string();
        let job = jobs::detached();

        let a = base.join("a.txt").to_string_lossy().to_string();
        assert!(drop_moves(vec![a.clone()], d.clone()));
        let res = run_transfer(std::slice::from_ref(&a), &d, Mode::Drop { force_copy: false }, &Resolutions::new(), &job);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert!(!base.join("a.txt").exists());
        assert!(dest.join("a.txt").exists());
        assert_eq!(
            res.inverse,
            vec![Step::moved(path_str(&dest.join("a.txt")), a)]
        );

        let b = base.join("b.txt").to_string_lossy().to_string();
        let res = run_transfer(&[b], &d, Mode::Drop { force_copy: true }, &Resolutions::new(), &job);
        assert!(res.errors.is_empty());
        assert!(base.join("b.txt").exists());
        assert!(dest.join("b.txt").exists());
        assert_eq!(
            res.inverse,
            vec![Step::trash(path_str(&dest.join("b.txt")))]
        );

        let res = run_transfer(std::slice::from_ref(&d), &d, Mode::Drop { force_copy: false }, &Resolutions::new(), &job);
        assert_eq!(res.errors.len(), 1);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn copy_preserves_xattrs_links_and_names() {
        let base = scratch("copy");
        let src = base.join("src");
        let dest = base.join("dest");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::create_dir_all(&dest).unwrap();
        fs::write(src.join("a.txt"), "hi").unwrap();
        fs::write(src.join("sub/b.txt"), "yo").unwrap();
        std::os::unix::fs::symlink("a.txt", src.join("link")).unwrap();
        let tag = "com.apple.metadata:_kMDItemUserTags";
        assert!(std::process::Command::new("xattr")
            .args(["-w", tag, "Red"])
            .arg(src.join("a.txt"))
            .status()
            .unwrap()
            .success());
        let job = jobs::detached();

        let first = copy_to_unique(&src, &dest, "src", &job).unwrap();
        let second = copy_to_unique(&src, &dest, "src", &job).unwrap();
        let file = copy_to_unique(&src.join("a.txt"), &dest, "a.txt", &job).unwrap();
        let file2 = copy_to_unique(&src.join("a.txt"), &dest, "a.txt", &job).unwrap();
        assert_eq!(first, dest.join("src"));
        assert_eq!(second, dest.join("src_copy_1"));
        assert_eq!(file, dest.join("a.txt"));
        assert_eq!(file2, dest.join("a_copy_1.txt"));
        assert_eq!(fs::read_to_string(first.join("sub/b.txt")).unwrap(), "yo");
        assert!(fs::symlink_metadata(first.join("link"))
            .unwrap()
            .file_type()
            .is_symlink());
        let out = std::process::Command::new("xattr")
            .args(["-p", tag])
            .arg(first.join("a.txt"))
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "Red");
        let leftovers = fs::read_dir(&dest).unwrap().flatten();
        assert!(!leftovers.into_iter().any(|e| e.file_name().to_string_lossy().starts_with(".wf-partial")));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn rename_excl_never_overwrites() {
        let base = scratch("excl");
        fs::write(base.join("a"), "a").unwrap();
        fs::write(base.join("b"), "b").unwrap();
        let e = rename_excl(&base.join("a"), &base.join("b")).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(base.join("b")).unwrap(), "b");
        rename_excl(&base.join("a"), &base.join("c")).unwrap();
        assert!(rename_path(path_str(&base.join("c")), path_str(&base.join("b"))).is_err());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_link_to_the_item_being_replaced_holds_it() {
        let base = scratch("holdlink");
        fs::create_dir_all(base.join("dest")).unwrap();
        fs::write(base.join("dest/a.txt"), "only copy").unwrap();
        std::os::unix::fs::symlink(base.join("dest/a.txt"), base.join("a.txt")).unwrap();
        assert!(holds_item(&base.join("dest/a.txt"), &base.join("a.txt")));
        fs::write(base.join("b.txt"), "other").unwrap();
        assert!(!holds_item(&base.join("dest/a.txt"), &base.join("b.txt")));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn case_only_rename_matches_other_unicode_spellings() {
        let base = scratch("nfd");
        let nfd = base.join("re\u{301}sume\u{301}.txt");
        fs::write(&nfd, "cv").unwrap();
        assert!(same_file_case_only(&nfd, &base.join("R\u{e9}sum\u{e9}.txt")));
        fs::write(base.join("other.txt"), "o").unwrap();
        assert!(rename_taken(path_str(&base.join("other.txt")), path_str(&base.join("R\u{e9}sum\u{e9}.txt"))));
        assert!(!rename_taken(path_str(&nfd), path_str(&base.join("R\u{e9}sum\u{e9}.txt"))));
        rename_path(path_str(&nfd), path_str(&base.join("R\u{e9}sum\u{e9}.txt"))).unwrap();
        // Two hard links are two names, not one spelled two ways.
        fs::write(base.join("x"), "x").unwrap();
        fs::hard_link(base.join("x"), base.join("y")).unwrap();
        assert!(!same_file_case_only(&base.join("x"), &base.join("y")));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_firmlinked_path_is_the_same_folder() {
        let base = scratch("firm");
        let real = fs::canonicalize(&base).unwrap();
        let via = Path::new("/System/Volumes/Data").join(real.strip_prefix("/").unwrap());
        if via.exists() {
            assert!(same_dir(Some(&base), &via));
        }
        assert!(!same_dir(Some(&base), &std::env::temp_dir()));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_tree_revision_sees_any_change_in_the_original() {
        let base = scratch("treerev");
        fs::create_dir_all(base.join("src/sub")).unwrap();
        fs::write(base.join("src/sub/f.txt"), "OLD").unwrap();
        let before = tree_revision(&base.join("src")).unwrap();
        fs::write(base.join("src/.DS_Store"), "x").unwrap();
        assert_eq!(tree_revision(&base.join("src")).unwrap(), before);
        // Same size, written in place.
        let f = fs::File::options().write(true).open(base.join("src/sub/f.txt")).unwrap();
        f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
        assert_ne!(tree_revision(&base.join("src")).unwrap(), before);
        let before = tree_revision(&base.join("src")).unwrap();
        fs::write(base.join("src/new.txt"), "").unwrap();
        assert_ne!(tree_revision(&base.join("src")).unwrap(), before);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_move_never_lands_over_an_item_already_there() {
        let base = scratch("noclobber");
        fs::create_dir_all(base.join("dest")).unwrap();
        fs::write(base.join("a.txt"), "MOVED").unwrap();
        fs::write(base.join("dest/a.txt"), "UNRELATED WORK").unwrap();
        let job = jobs::detached();
        for cross in [true, false] {
            let moved = move_item(&base.join("a.txt"), &base.join("dest"), "a.txt", &job, cross, false).unwrap();
            assert_eq!(moved.to, base.join("dest/a_copy_1.txt"));
            assert_eq!(fs::read_to_string(base.join("dest/a.txt")).unwrap(), "UNRELATED WORK");
            assert!(moved.trashed_old.is_none());
            fs::rename(&moved.to, base.join("a.txt")).unwrap();
        }
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn permanent_delete_keeps_an_item_replaced_since_it_was_confirmed() {
        let base = scratch("delid");
        let p = base.join("a.txt");
        fs::write(&p, "confirmed").unwrap();
        let id = jobs::file_id(&p);
        fs::write(base.join("b.txt"), "replacement").unwrap();
        fs::rename(base.join("b.txt"), &p).unwrap();
        let job = jobs::detached();
        let res = delete_permanently_sync(&[path_str(&p)], Some(&[id]), &job);
        assert_eq!(res.errors.len(), 1);
        assert_eq!(fs::read_to_string(&p).unwrap(), "replacement");
        let res = delete_permanently_sync(&[path_str(&p)], Some(&[jobs::file_id(&p)]), &job);
        assert!(res.errors.is_empty() && !p.exists());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_failed_cross_volume_move_leaves_nothing_at_the_destination() {
        let base = scratch("placeholder");
        fs::create_dir_all(base.join("src/sub")).unwrap();
        fs::create_dir_all(base.join("dest")).unwrap();
        let job = jobs::detached();
        job.cancel();
        assert!(move_item(&base.join("src"), &base.join("dest"), "src", &job, true, false).is_err());
        assert!(!base.join("dest/src").exists());
        assert!(base.join("src/sub").exists());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn data_copy_reports_every_byte() {
        let base = scratch("progress");
        let src = base.join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("big.bin"), vec![7u8; 3 << 20]).unwrap();
        fs::write(src.join("sub/small.bin"), vec![1u8; 1000]).unwrap();
        let job = jobs::detached();
        macos_copy::copy(&src, &base.join("out"), &job, false).unwrap();
        assert_eq!(job.bytes_done(), (3 << 20) + 1000);
        assert_eq!(fs::read(base.join("out/sub/small.bin")).unwrap().len(), 1000);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn cancelled_copy_leaves_nothing_behind() {
        let base = scratch("cancel");
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        fs::write(base.join("a.txt"), "a").unwrap();
        let job = jobs::detached();
        job.cancel();
        let res = run_transfer(
            &[path_str(&base.join("a.txt"))],
            &path_str(&dest),
            Mode::Copy,
            &Resolutions::new(),
            &job,
        );
        assert!(res.cancelled);
        assert!(res.inverse.is_empty());
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);

        let src = base.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("big.bin"), vec![0u8; 2 << 20]).unwrap();
        let job = jobs::detached();
        job.cancel();
        assert!(copy_to_unique(&src, &dest, "src", &job).is_err());
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn cross_volume_move_is_atomic_and_leaves_no_scratch() {
        let base = scratch("xvol");
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        let src = base.join("tree");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("sub/f.txt"), "x").unwrap();
        fs::write(base.join("one.txt"), "1").unwrap();
        let job = jobs::detached();

        let moved = move_item(&src, &dest, "tree", &job, true, false).unwrap();
        assert!(moved.leftover.is_none());
        assert_eq!(moved.to, dest.join("tree"));
        assert!(!src.exists());
        assert_eq!(fs::read_to_string(dest.join("tree/sub/f.txt")).unwrap(), "x");
        let moved = move_item(&base.join("one.txt"), &dest, "one.txt", &job, true, false).unwrap();
        assert_eq!(fs::read_to_string(moved.to).unwrap(), "1");
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 2);

        let keep = base.join("keep");
        fs::create_dir_all(&keep).unwrap();
        fs::write(keep.join("k.txt"), "k").unwrap();
        let job = jobs::detached();
        job.cancel();
        assert!(move_item(&keep, &dest, "keep", &job, true, false).is_err());
        assert!(keep.join("k.txt").exists());
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 2);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn drop_plan_answers_per_source() {
        let base = scratch("plan");
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        fs::write(base.join("a.txt"), "a").unwrap();
        let plan = drop_plan(
            vec![path_str(&base.join("a.txt")), "/nonexistent/x".into()],
            path_str(&dest),
        );
        assert_eq!(plan, vec![true, false]);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn permanent_delete_removes_trees_and_honours_cancel() {
        let base = scratch("del");
        let tree = base.join("tree");
        fs::create_dir_all(tree.join("sub")).unwrap();
        fs::write(tree.join("sub/f.txt"), "x").unwrap();
        fs::write(base.join("keep.txt"), "k").unwrap();
        let job = jobs::detached();
        remove_tree(&tree, &job).unwrap();
        assert!(!tree.exists());

        let job = jobs::detached();
        job.cancel();
        assert!(remove_tree(&base.join("keep.txt"), &job).is_err());
        assert!(base.join("keep.txt").exists());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn steps_round_trip_through_trash() {
        let base = scratch("steps");
        let file = base.join("note.txt");
        fs::write(&file, "n").unwrap();
        let job = jobs::detached();
        let p = path_str(&file);

        let res = run_steps(&[Step::trash(p.clone())], &job);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert!(!file.exists());
        assert_eq!(res.inverse.len(), 1);

        let back = run_steps(&res.inverse, &job);
        assert!(back.errors.is_empty(), "{:?}", back.errors);
        assert_eq!(fs::read_to_string(&file).unwrap(), "n");
        assert_eq!(back.inverse.len(), 1);

        let renamed = base.join("renamed.txt");
        let res = run_steps(
            &[Step::moved(p.clone(), path_str(&renamed))],
            &job,
        );
        assert!(renamed.exists() && !file.exists());
        let res = run_steps(&res.inverse, &job);
        assert!(file.exists() && !renamed.exists());
        assert!(res.errors.is_empty());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn network_filesystems_are_recognised_and_the_boot_volume_is_local() {
        for t in ["smbfs", "afpfs", "nfs", "webdav"] {
            assert!(is_network_fs(t), "{t}");
        }
        for t in ["apfs", "hfs", "msdos", "exfat", ""] {
            assert!(!is_network_fs(t), "{t}");
        }
        assert!(!is_network_volume("/"), "the boot volume is local");
        assert!(!is_network_volume("/definitely/not/here"));
    }

    /// Needs a mounted share with no Trash, such as WebDAV:
    /// `DOFTAR_TEST_SHARE=/Volumes/server cargo test share -- --ignored`
    #[test]
    #[ignore = "needs DOFTAR_TEST_SHARE"]
    fn share_without_trash_offers_delete_and_replaces_in_place() {
        let share = PathBuf::from(std::env::var("DOFTAR_TEST_SHARE").unwrap());
        assert!(is_network_volume(&path_str(&share)));
        let dir = share.join(format!("wf-share-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let on_share = dir.join("a.txt");
        fs::write(&on_share, "old").unwrap();

        let res = trash_paths_sync(&[path_str(&on_share)]);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert_eq!(res.no_trash, [path_str(&on_share)]);
        assert!(on_share.exists());

        let local = scratch("share-src");
        fs::write(local.join("a.txt"), "new").unwrap();
        let (to, aside) = copy_replacing(&local.join("a.txt"), &dir, "a.txt", &jobs::detached()).unwrap();
        assert_eq!(to, on_share);
        let aside = PathBuf::from(aside.expect("the old item is set aside for undo"));
        assert!(is_aside_name(&label(&aside)));
        assert_eq!(fs::read_to_string(&on_share).unwrap(), "new");
        assert_eq!(fs::read_to_string(&aside).unwrap(), "old");
        let left = fs::read_dir(&dir).unwrap().flatten();
        assert!(!left.into_iter().any(|e| e.file_name().to_string_lossy().starts_with(".wf-partial")));
        discard_asides(vec![path_str(&aside)]);
        assert!(!aside.exists());

        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&local).unwrap();
    }

    #[test]
    fn an_item_set_aside_is_hidden_beside_itself_and_only_asides_are_discarded() {
        let base = scratch("aside");
        fs::write(base.join("a.txt"), "old").unwrap();
        fs::write(base.join("keep.txt"), "mine").unwrap();
        let aside = set_aside(&base.join("a.txt")).unwrap();
        assert_eq!(aside.parent(), Some(base.as_path()));
        assert!(is_aside_name(&label(&aside)) && is_hidden_name(&label(&aside)));
        assert!(!base.join("a.txt").exists());
        assert_eq!(fs::read_to_string(&aside).unwrap(), "old");
        let again = set_aside(&base.join("keep.txt")).unwrap();
        assert_ne!(again, aside);
        fs::rename(&again, base.join("keep.txt")).unwrap();
        discard_asides(vec![path_str(&aside), path_str(&base.join("keep.txt")), path_str(&base)]);
        assert!(!aside.exists());
        assert_eq!(fs::read_to_string(base.join("keep.txt")).unwrap(), "mine");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn dir_stamp_changes_when_items_come_and_go_but_not_when_a_file_is_edited() {
        let base = scratch("stamp");
        fs::write(base.join("a.txt"), "1").unwrap();
        let path = path_str(&base);
        let first = dir_stamp(path.clone()).expect("stamp");

        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(base.join("a.txt"), "edited in place").unwrap();
        assert_eq!(dir_stamp(path.clone()).unwrap(), first, "an in-place edit leaves the folder's list alone");

        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(base.join("b.txt"), "new").unwrap();
        let added = dir_stamp(path.clone()).unwrap();
        assert_ne!(added, first, "a new item changes it");

        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::rename(base.join("b.txt"), base.join("c.txt")).unwrap();
        let renamed = dir_stamp(path.clone()).unwrap();
        assert_ne!(renamed, added, "a rename changes it");

        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::remove_file(base.join("c.txt")).unwrap();
        assert_ne!(dir_stamp(path).unwrap(), renamed, "a removal changes it");
        assert!(dir_stamp("/definitely/not/here".into()).is_none());
        fs::remove_dir_all(&base).unwrap();
    }

    fn is_link(p: &Path) -> bool {
        fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())
    }

    #[test]
    fn symlinks_are_copied_and_moved_as_links() {
        let base = scratch("links");
        let dest = base.join("dest");
        fs::create_dir_all(base.join("real")).unwrap();
        fs::create_dir_all(&dest).unwrap();
        fs::write(base.join("real/f.txt"), "f").unwrap();
        std::os::unix::fs::symlink("nowhere", base.join("dangling")).unwrap();
        std::os::unix::fs::symlink(base.join("real"), base.join("dirlink")).unwrap();
        let job = jobs::detached();

        let copied = copy_to_unique(&base.join("dangling"), &dest, "dangling", &job).unwrap();
        assert!(is_link(&copied));
        assert_eq!(fs::read_link(&copied).unwrap(), Path::new("nowhere"));
        let again = copy_to_unique(&base.join("dangling"), &dest, "dangling", &job).unwrap();
        assert_eq!(again, dest.join("dangling_copy_1"));

        let moved = move_item(&base.join("dirlink"), &dest, "dirlink", &job, true, false).unwrap();
        assert!(moved.leftover.is_none());
        assert!(is_link(&moved.to), "a link to a folder stays a link across volumes");
        assert!(!is_link(&base.join("dirlink")));
        assert_eq!(fs::read_to_string(base.join("real/f.txt")).unwrap(), "f");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn copy_names_split_only_real_extensions() {
        assert_eq!(copy_candidate("a.txt", 1, false), "a_copy_1.txt");
        assert_eq!(copy_candidate("a.tar.gz", 2, false), "a_copy_2.tar.gz");
        assert_eq!(copy_candidate("Project v1.2", 1, false), "Project v1.2_copy_1");
        assert_eq!(copy_candidate("Project v1.2", 1, true), "Project v1.2_copy_1");
        assert_eq!(copy_candidate("notes.final", 1, true), "notes.final_copy_1");
        assert_eq!(copy_candidate("Thing.app", 1, false), "Thing_copy_1.app");
        assert_eq!(copy_candidate(".zshrc", 1, false), ".zshrc_copy_1");
        assert_eq!(copy_candidate("song.mp3", 1, false), "song_copy_1.mp3");
        assert_eq!(copy_candidate("a.b c", 1, false), "a.b c_copy_1");

        let base = scratch("names");
        let dest = base.join("dest");
        fs::create_dir_all(base.join("Project v1.2/inner")).unwrap();
        fs::create_dir_all(base.join("Thing.app/Contents")).unwrap();
        fs::create_dir_all(&dest).unwrap();
        let job = jobs::detached();
        for _ in 0..2 {
            copy_to_unique(&base.join("Project v1.2"), &dest, "Project v1.2", &job).unwrap();
            copy_to_unique(&base.join("Thing.app"), &dest, "Thing.app", &job).unwrap();
        }
        assert!(dest.join("Project v1.2_copy_1/inner").is_dir());
        assert!(dest.join("Thing_copy_1.app/Contents").is_dir());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn into_itself_is_judged_by_the_real_folder() {
        let base = scratch("within");
        fs::create_dir_all(base.join("real/sub")).unwrap();
        std::os::unix::fs::symlink(base.join("real"), base.join("link")).unwrap();
        let real = base.join("real");
        assert!(is_within_subtree(&real, &real));
        assert!(is_within_subtree(&real, &base.join("link/sub")));
        assert!(is_within_subtree(&real, Path::new(&path_str(&real.join("SUB")).replace("/real/", "/REAL/"))));
        // A link moves as the link, so it can go into its target.
        assert!(!is_within_subtree(&base.join("link"), &real.join("sub")));
        assert!(!is_within_subtree(&real.join("sub"), &real));
        assert!(!is_within_subtree(&base.join("realx"), &real));

        let job = jobs::detached();
        let res = run_transfer(&[path_str(&base.join("link"))], &path_str(&real.join("sub")), Mode::Move, &Resolutions::new(), &job);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert!(is_link(&real.join("sub/link")));
        let res = run_transfer(&[path_str(&real)], &path_str(&real.join("sub/link/sub")), Mode::Copy, &Resolutions::new(), &job);
        assert_eq!(res.errors.len(), 1, "a folder reached through a link is still inside itself");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn dangling_links_hold_their_names() {
        let base = scratch("dangle");
        let outside = base.join("outside.txt");
        std::os::unix::fs::symlink(&outside, base.join("New Text Document.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, base.join("taken")).unwrap();
        fs::write(base.join("mine"), "m").unwrap();
        let dir = path_str(&base);

        assert!(path_exists(path_str(&base.join("taken"))));
        assert!(rename_path(path_str(&base.join("mine")), path_str(&base.join("taken"))).is_err());
        assert!(is_link(&base.join("taken")));
        let made = create_file(dir.clone()).unwrap();
        assert!(matches!(made, Step::Trash { path, .. } if path == path_str(&base.join("New Text Document (2).txt"))));
        assert!(!outside.exists(), "nothing written through the link");
        std::os::unix::fs::symlink(&outside, base.join("New folder")).unwrap();
        let made = create_dir(dir).unwrap();
        assert!(matches!(made, Step::Trash { path, .. } if path == path_str(&base.join("New folder (2)"))));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn permanent_delete_removes_locked_items() {
        let base = scratch("locked");
        fs::create_dir_all(base.join("tree")).unwrap();
        fs::write(base.join("tree/f.txt"), "x").unwrap();
        fs::write(base.join("one.txt"), "1").unwrap();
        let lock = |p: &Path| {
            assert!(std::process::Command::new("/usr/bin/chflags").arg("uchg").arg(p).status().unwrap().success())
        };
        lock(&base.join("tree/f.txt"));
        lock(&base.join("one.txt"));
        let job = jobs::detached();
        let res = delete_permanently_sync(&[path_str(&base.join("tree")), path_str(&base.join("one.txt"))], None, &job);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert!(!exists(&base.join("tree")) && !exists(&base.join("one.txt")));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn permanent_delete_keeps_a_repositorys_history() {
        let base = scratch("dotgit");
        fs::create_dir_all(base.join("repo/.Git")).unwrap();
        let res = delete_permanently_sync(&[path_str(&base.join("repo/.Git"))], None, &jobs::detached());
        assert_eq!(res.errors.len(), 1);
        assert!(exists(&base.join("repo/.Git")));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_partly_removed_original_keeps_its_only_complete_copy() {
        use std::os::unix::fs::PermissionsExt;
        let base = scratch("partial-move");
        let dest = base.join("dest");
        let src = base.join("tree");
        fs::create_dir_all(src.join("stuck")).unwrap();
        fs::create_dir_all(&dest).unwrap();
        fs::write(src.join("a.txt"), "a").unwrap();
        fs::write(src.join("stuck/b.txt"), "b").unwrap();
        // A locked file stops the folder's removal partway.
        let flags = |flag: &str, p: &Path| {
            assert!(std::process::Command::new("/usr/bin/chflags").args(["-R", flag]).arg(p).status().unwrap().success())
        };
        flags("uchg", &src.join("stuck/b.txt"));
        let job = jobs::detached();
        let mut res = OpResult::default();
        move_one(&path_str(&src), &dest, &job, &mut res, true, &Resolutions::new(), &mut Placed::default());
        flags("nouchg", &base);
        assert_eq!(res.errors.len(), 1, "{:?}", res.errors);
        assert!(res.errors[0].contains("copied, but"), "{:?}", res.errors);
        assert!(res.inverse.is_empty(), "undo must not trash the complete copy: {:?}", res.inverse);
        assert_eq!(fs::read_to_string(dest.join("tree/a.txt")).unwrap(), "a");

        // A file is never half removed, so undo can still remove the copy.
        let file = base.join("f.txt");
        fs::write(&file, "f").unwrap();
        let ro = base.join("ro");
        fs::create_dir_all(&ro).unwrap();
        let held = ro.join("f.txt");
        fs::rename(&file, &held).unwrap();
        fs::set_permissions(&ro, fs::Permissions::from_mode(0o500)).unwrap();
        let mut res = OpResult::default();
        move_one(&path_str(&held), &dest, &job, &mut res, true, &Resolutions::new(), &mut Placed::default());
        fs::set_permissions(&ro, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(res.errors.len(), 1, "{:?}", res.errors);
        assert_eq!(res.inverse, vec![Step::trash(path_str(&dest.join("f.txt")))]);
        fs::remove_dir_all(&base).unwrap();
    }

    fn resolve(src: &Path, r: Resolution) -> Resolutions {
        [(path_str(src), r)].into_iter().collect()
    }

    #[test]
    fn conflicts_are_found_unless_pasting_in_place() {
        let base = scratch("conf");
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        fs::write(base.join("a.txt"), "new").unwrap();
        fs::write(dest.join("a.txt"), "old").unwrap();
        fs::create_dir_all(base.join("d")).unwrap();
        fs::write(dest.join("d"), "file").unwrap();
        let srcs = vec![path_str(&base.join("a.txt")), path_str(&base.join("d"))];
        let found = find_conflicts(srcs, path_str(&dest));
        assert_eq!(found.len(), 2);
        assert!(found[0].can_replace);
        assert!(!found[1].can_replace);
        assert!(find_conflicts(vec![path_str(&dest.join("a.txt"))], path_str(&dest)).is_empty());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn replace_trashes_the_old_item_and_undo_restores_it() {
        let base = scratch("repl");
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        let src = base.join("a.txt");
        fs::write(&src, "new").unwrap();
        fs::write(dest.join("a.txt"), "old").unwrap();
        let job = jobs::detached();

        let res = run_transfer(
            &[path_str(&src)],
            &path_str(&dest),
            Mode::Copy,
            &resolve(&src, Resolution::Replace),
            &job,
        );
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "new");
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 1, "no scratch or copy left");

        let undone = run_steps(&res.inverse, &job);
        assert!(undone.errors.is_empty(), "{:?}", undone.errors);
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "old");
        assert!(src.exists());

        let redone = run_steps(&undone.inverse, &job);
        assert!(redone.errors.is_empty(), "{:?}", redone.errors);
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "new");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn same_named_sources_replace_once_and_undo_cleanly() {
        let base = scratch("repl2");
        let dest = base.join("dest");
        fs::create_dir_all(base.join("x")).unwrap();
        fs::create_dir_all(base.join("y")).unwrap();
        fs::create_dir_all(&dest).unwrap();
        let (x, y) = (base.join("x/a.txt"), base.join("y/a.txt"));
        fs::write(&x, "x").unwrap();
        fs::write(&y, "y").unwrap();
        fs::write(dest.join("a.txt"), "old").unwrap();
        let job = jobs::detached();
        let both: Resolutions = [(path_str(&x), Resolution::Replace), (path_str(&y), Resolution::Replace)]
            .into_iter()
            .collect();

        let res = run_transfer(&[path_str(&x), path_str(&y)], &path_str(&dest), Mode::Copy, &both, &job);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "x");
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 2, "the second is kept beside the first");

        let undone = run_steps(&res.inverse, &job);
        assert!(undone.errors.is_empty(), "{:?}", undone.errors);
        let left: Vec<_> = fs::read_dir(&dest).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from("a.txt")]);
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "old");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn undo_spares_an_item_that_took_the_copys_place() {
        let base = scratch("ident");
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        let src = base.join("a.txt");
        fs::write(&src, "mine").unwrap();
        let job = jobs::detached();

        let res = run_transfer(&[path_str(&src)], &path_str(&dest), Mode::Copy, &Resolutions::new(), &job);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        fs::remove_file(dest.join("a.txt")).unwrap();
        fs::write(dest.join("a.txt"), "someone else's").unwrap();

        let undone = run_steps(&res.inverse, &job);
        assert_eq!(undone.errors.len(), 1, "{:?}", undone.errors);
        assert!(undone.inverse.is_empty());
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "someone else's");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn move_replace_skip_and_keep_both() {
        let base = scratch("movr");
        let dest = base.join("dest");
        fs::create_dir_all(&dest).unwrap();
        let job = jobs::detached();
        let d = path_str(&dest);

        let a = base.join("a.txt");
        fs::write(&a, "A").unwrap();
        fs::write(dest.join("a.txt"), "old").unwrap();
        let res = run_transfer(&[path_str(&a)], &d, Mode::Move, &resolve(&a, Resolution::Replace), &job);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert!(!a.exists());
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "A");
        let undone = run_steps(&res.inverse, &job);
        assert!(undone.errors.is_empty(), "{:?}", undone.errors);
        assert_eq!(fs::read_to_string(&a).unwrap(), "A");
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "old");

        let res = run_transfer(&[path_str(&a)], &d, Mode::Move, &resolve(&a, Resolution::Skip), &job);
        assert!(res.errors.is_empty() && res.inverse.is_empty());
        assert!(a.exists());
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "old");

        let res = run_transfer(&[path_str(&a)], &d, Mode::Copy, &Resolutions::new(), &job);
        assert!(res.errors.is_empty());
        assert_eq!(fs::read_to_string(dest.join("a_copy_1.txt")).unwrap(), "A");
        assert_eq!(fs::read_to_string(dest.join("a.txt")).unwrap(), "old");
        fs::remove_dir_all(&base).unwrap();
    }
}
