//! Fast directory listing on macOS.
//!
//! `read_dir` plus a `lstat` per entry costs one syscall per file. The
//! `getattrlistbulk` call returns the name and the attributes we show for many
//! entries per call, which is several times faster on large folders. Folders,
//! symlinks and special files, and any parse surprise or unsupported
//! filesystem, use the per-entry path, so results match `build_entry`.

use std::ffi::OsStr;
use std::fs;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use crate::fsops::{build_entry_untagged, is_hidden_name, FileEntry};

const VREG: u32 = 1;
const UF_HIDDEN: u32 = 0x8000;
const BUF_BYTES: usize = 256 * 1024;

const COMMON: libc::attrgroup_t = libc::ATTR_CMN_RETURNED_ATTRS
    | libc::ATTR_CMN_NAME
    | libc::ATTR_CMN_DEVID
    | libc::ATTR_CMN_OBJTYPE
    | libc::ATTR_CMN_CRTIME
    | libc::ATTR_CMN_MODTIME
    | libc::ATTR_CMN_FNDRINFO
    | libc::ATTR_CMN_FLAGS
    | libc::ATTR_CMN_FILEID;
const FILE: libc::attrgroup_t = libc::ATTR_FILE_DATALENGTH;

/// Reads `buf[at..]` as a `T`, or `None` when it would run past `end`.
fn take<T: Copy>(buf: &[u8], at: &mut usize, end: usize) -> Option<T> {
    let size = std::mem::size_of::<T>();
    if *at + size > end {
        return None;
    }
    // SAFETY: bounds checked above; `read_unaligned` tolerates any alignment.
    let v = unsafe { std::ptr::read_unaligned(buf.as_ptr().add(*at) as *const T) };
    *at += size;
    Some(v)
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Timespec {
    sec: i64,
    nsec: i64,
}

fn millis(t: Timespec) -> u64 {
    if t.sec < 0 {
        0
    } else {
        t.sec as u64 * 1000 + (t.nsec.max(0) as u64) / 1_000_000
    }
}

enum Parsed {
    Entry(FileEntry),
    /// Hidden entry the caller doesn't want.
    Skip,
    /// Needs the ordinary path (symlink, special file, or odd attributes),
    /// with the Finder label it reported.
    Fallback(Vec<u8>, u8),
}

fn parse_entry(
    dir: &Path,
    buf: &[u8],
    start: usize,
    end: usize,
    show_hidden: bool,
) -> Option<Parsed> {
    let mut at = start + 4; // skip the entry length
    let returned: [u32; 5] = take(buf, &mut at, end)?;
    let (common, file) = (returned[0], returned[3]);
    let wanted = COMMON & !libc::ATTR_CMN_RETURNED_ATTRS;
    if common & wanted != wanted {
        return None;
    }

    let name_at = at;
    let name_ref: [i32; 2] = take(buf, &mut at, end)?;
    let name_start = (name_at as i64 + name_ref[0] as i64) as usize;
    let name_len = (name_ref[1] as usize).saturating_sub(1); // drop the NUL
    let name_bytes = buf.get(name_start..name_start.checked_add(name_len)?)?;
    if name_start + name_len + 1 > end {
        return None;
    }

    let dev: u32 = take(buf, &mut at, end)?;
    let objtype: u32 = take(buf, &mut at, end)?;
    let created: Timespec = take(buf, &mut at, end)?;
    let modified: Timespec = take(buf, &mut at, end)?;
    // Attributes are packed in bit order: Finder info sits between the
    // modification time and the flags.
    let finder: [u8; 32] = take(buf, &mut at, end)?;
    let flags: u32 = take(buf, &mut at, end)?;
    let fileid: u64 = take(buf, &mut at, end)?;

    // Folders go through the ordinary path: firmlinked system folders report
    // different attributes (mtime, inode) through getattrlist than through
    // stat, and a folder is also where the package check needs the filesystem.
    // Symlinks and special files take it too. Regular files, the bulk of a
    // big listing, are fast-pathed.
    if objtype != VREG {
        return Some(Parsed::Fallback(name_bytes.to_vec(), crate::tags::label_of(&finder)));
    }
    if file & libc::ATTR_FILE_DATALENGTH == 0 {
        return None;
    }
    let size = take::<i64>(buf, &mut at, end)?.max(0) as u64;

    let name = String::from_utf8_lossy(name_bytes).to_string();
    let hidden = is_hidden_name(&name) || flags & UF_HIDDEN != 0;
    if !show_hidden && hidden {
        return Some(Parsed::Skip);
    }
    let path = dir.join(OsStr::from_bytes(name_bytes));
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    Some(Parsed::Entry(FileEntry {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir: false,
        is_hidden: hidden,
        is_symlink: false,
        is_alias: size <= crate::fsops::ALIAS_MAX_BYTES && crate::alias::finder_info_is_alias(&finder),
        is_package: false,
        size,
        modified_ms: millis(modified),
        created_ms: millis(created),
        ext,
        // Matches `MetadataExt::dev()`, which sign-extends the 32-bit st_dev.
        file_id: format!("{}:{}", dev as i32 as i64 as u64, fileid),
        tags: crate::tags::read_labelled(&path, crate::tags::label_of(&finder)),
    }))
}

/// Lists `dir`, or `None` if this path should use the ordinary listing.
pub fn list_dir(dir: &Path, show_hidden: bool) -> Option<Vec<FileEntry>> {
    let handle = fs::File::open(dir).ok()?;
    let mut list = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: COMMON,
        volattr: 0,
        dirattr: 0,
        fileattr: FILE,
        forkattr: 0,
    };
    // u64 backing keeps the buffer 8-byte aligned.
    let mut storage = vec![0u64; BUF_BYTES / 8];
    let mut entries = Vec::new();

    loop {
        // SAFETY: `storage` outlives the call and is BUF_BYTES long; `list` is
        // a valid attrlist; the fd is an open directory.
        let n = unsafe {
            libc::getattrlistbulk(
                handle.as_raw_fd(),
                &mut list as *mut libc::attrlist as *mut libc::c_void,
                storage.as_mut_ptr() as *mut libc::c_void,
                BUF_BYTES,
                libc::FSOPT_PACK_INVAL_ATTRS as u64,
            )
        };
        if n < 0 {
            return None;
        }
        if n == 0 {
            break;
        }
        // SAFETY: the kernel wrote at most BUF_BYTES bytes into `storage`.
        let buf = unsafe { std::slice::from_raw_parts(storage.as_ptr() as *const u8, BUF_BYTES) };
        let mut at = 0usize;
        for _ in 0..n {
            let mut cursor = at;
            let len: u32 = take(buf, &mut cursor, BUF_BYTES)?;
            let end = at.checked_add(len as usize)?;
            if len < 4 || end > BUF_BYTES {
                return None;
            }
            match parse_entry(dir, buf, at, end, show_hidden)? {
                Parsed::Entry(e) => entries.push(e),
                Parsed::Skip => {}
                Parsed::Fallback(name, label) => {
                    let path = dir.join(OsStr::from_bytes(&name));
                    let Ok(meta) = fs::symlink_metadata(&path) else {
                        at = end;
                        continue;
                    };
                    let name = String::from_utf8_lossy(&name).to_string();
                    if let Some(mut e) = build_entry_untagged(&path, name, meta, show_hidden) {
                        e.tags = crate::tags::read_labelled(&path, label);
                        entries.push(e);
                    }
                }
            }
            at = end;
        }
    }
    Some(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsops::build_entry;
    use std::os::unix::fs::symlink;
    use std::time::Instant;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!("wf-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    /// The per-entry listing the bulk path must agree with.
    fn slow(dir: &Path, show_hidden: bool) -> Vec<FileEntry> {
        let mut out = Vec::new();
        for item in fs::read_dir(dir).unwrap().flatten() {
            let name = item.file_name().to_string_lossy().to_string();
            let Ok(meta) = item.metadata() else { continue };
            if let Some(e) = build_entry(&item.path(), name, meta, show_hidden) {
                out.push(e);
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    fn fast(dir: &Path, show_hidden: bool) -> Vec<FileEntry> {
        let mut out = list_dir(dir, show_hidden).expect("bulk listing should work here");
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    fn same(a: &[FileEntry], b: &[FileEntry]) {
        assert_eq!(a.len(), b.len(), "entry counts differ");
        for (x, y) in a.iter().zip(b) {
            let key = |e: &FileEntry| {
                (
                    e.name.clone(), e.path.clone(), e.is_dir, e.is_hidden, e.is_symlink, e.is_alias,
                    e.is_package, e.size, e.modified_ms, e.created_ms, e.ext.clone(),
                    e.file_id.clone(),
                )
            };
            assert_eq!(key(x), key(y), "entry {} differs", x.name);
        }
    }

    #[test]
    fn matches_the_per_entry_listing() {
        let base = scratch("bulk-eq");
        fs::write(base.join("a.txt"), "hello").unwrap();
        fs::write(base.join("B.TXT"), "").unwrap();
        fs::write(base.join(".hidden"), "x").unwrap();
        fs::write(base.join("naïve ünïcode.md"), "u").unwrap();
        fs::write(base.join("no_ext"), "n").unwrap();
        fs::create_dir(base.join("plain")).unwrap();
        fs::create_dir(base.join("v1.2")).unwrap();
        fs::create_dir_all(base.join("Thing.app/Contents")).unwrap();
        fs::write(base.join("big.bin"), vec![7u8; 300_000]).unwrap();
        symlink("a.txt", base.join("link_file")).unwrap();
        symlink("plain", base.join("link_dir")).unwrap();
        symlink("nowhere", base.join("link_broken")).unwrap();
        crate::alias::make_aliases(vec![base.join("a.txt").to_string_lossy().to_string()]);
        let flagged = base.join("flagged");
        fs::write(&flagged, "f").unwrap();
        let _ = std::process::Command::new("/usr/bin/chflags").arg("hidden").arg(&flagged).status();

        for show in [true, false] {
            same(&slow(&base, show), &fast(&base, show));
        }
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn matches_on_a_real_system_folder() {
        for dir in ["/Applications", "/usr/bin", "/System/Library"] {
            let p = Path::new(dir);
            if p.is_dir() {
                same(&slow(p, true), &fast(p, true));
            }
        }
    }

    #[test]
    fn unreadable_or_missing_paths_defer_to_the_ordinary_listing() {
        assert!(list_dir(Path::new("/definitely/not/here"), true).is_none());
        let base = scratch("bulk-file");
        fs::write(base.join("f"), "x").unwrap();
        assert!(list_dir(&base.join("f"), true).is_none(), "a file is not a directory");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    #[ignore = "benchmark: cargo test --release bench -- --ignored --nocapture"]
    fn bench_large_directory() {
        let base = scratch("bulk-bench");
        for i in 0..100_000 {
            fs::write(base.join(format!("file-{i:06}.txt")), "x").unwrap();
        }
        for i in 0..2_000 {
            fs::create_dir(base.join(format!("dir-{i:05}"))).unwrap();
        }
        for round in 1..=3 {
            let t = Instant::now();
            let a = slow(&base, true).len();
            let slow_ms = t.elapsed().as_secs_f64() * 1000.0;
            let t = Instant::now();
            let b = fast(&base, true).len();
            let fast_ms = t.elapsed().as_secs_f64() * 1000.0;
            println!("round {round}: {a} entries  per-entry {slow_ms:.0} ms  bulk {fast_ms:.0} ms  ({:.1}x)", slow_ms / fast_ms);
            assert_eq!(a, b);
        }
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    #[ignore = "benchmark: full list_dir pipeline"]
    fn bench_full_pipeline() {
        let base = scratch("bulk-full");
        for i in 0..100_000 {
            fs::write(base.join(format!("File-{:06}.txt", (i * 7919) % 100_000)), "x").unwrap();
        }
        for i in 0..2_000 {
            fs::create_dir(base.join(format!("dir-{i:05}"))).unwrap();
        }
        for round in 1..=3 {
            let t = Instant::now();
            let mut old = slow(&base, true);
            old.sort_by(|a, b| {
                b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });
            let old_ms = t.elapsed().as_secs_f64() * 1000.0;
            let t = Instant::now();
            let new = crate::fsops::list_dir_sync(base.to_str().unwrap(), true).unwrap();
            let new_ms = t.elapsed().as_secs_f64() * 1000.0;
            println!("round {round}: {} entries  before {old_ms:.0} ms  after {new_ms:.0} ms  ({:.1}x)", old.len(), old_ms / new_ms);
            assert_eq!(old.len(), new.len());
            assert!(old.iter().zip(&new).all(|(a, b)| a.path == b.path), "same order");
        }
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    #[ignore = "benchmark: cost of serializing a big listing for the interface"]
    fn bench_serialization_cost() {
        let base = scratch("bulk-json");
        for i in 0..100_000 {
            fs::write(base.join(format!("File-{i:06}.txt")), "x").unwrap();
        }
        let entries = crate::fsops::list_dir_sync(base.to_str().unwrap(), true).unwrap();
        let t = Instant::now();
        let all = serde_json::to_string(&entries).unwrap();
        let all_ms = t.elapsed().as_secs_f64() * 1000.0;
        let t = Instant::now();
        let first = serde_json::to_string(&entries[..400]).unwrap();
        let first_ms = t.elapsed().as_secs_f64() * 1000.0;
        println!(
            "all {} entries: {:.1} MB, {all_ms:.0} ms to serialize | first 400: {:.0} KB, {first_ms:.1} ms",
            entries.len(),
            all.len() as f64 / 1e6,
            first.len() as f64 / 1e3
        );
        fs::remove_dir_all(&base).unwrap();
    }
}
