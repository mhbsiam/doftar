//! The file copy itself, and the checks a move makes before deleting the original.

use super::*;

pub(super) fn copy_item(from: &Path, to: &Path, job: &Job) -> std::io::Result<()> {
    download_cloud_files(from, job)?;
    copy_downloaded(from, to, job)
}

#[cfg(target_os = "macos")]
fn copy_downloaded(from: &Path, to: &Path, job: &Job) -> std::io::Result<()> {
    macos_copy::copy(from, to, job, true)?;
    // A copy on one volume is a clone of the same blocks. Reading both sides would prove nothing.
    if job.verifies() && !on_same_volume(from, to.parent().unwrap_or(to)) {
        verify_tree(from, to, job)?;
    }
    Ok(())
}

/// Downloads the online-only cloud files under `p`. copyfile does not make the drive download them.
/// Walks every tree: iCloud Desktop & Documents files are online-only outside the cloud folders.
#[cfg(target_os = "macos")]
fn download_cloud_files(p: &Path, job: &Job) -> std::io::Result<()> {
    job.wait_while_paused();
    if job.cancelled() {
        return Err(std::io::ErrorKind::Interrupted.into());
    }
    let meta = fs::symlink_metadata(p)?;
    if meta.is_dir() {
        for item in fs::read_dir(p)? {
            download_cloud_files(&item?.path(), job)?;
        }
    } else if crate::thumbs::is_dataless(&meta) {
        job.set_current(&format!("Downloading {}", label(p)));
        // shortcut: the read blocks until the whole file arrives, so Cancel waits for it; File Provider APIs could interrupt it.
        crate::downloads::download(p)
            .map_err(|e| std::io::Error::other(format!("\"{}\": {e}", label(p))))?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn download_cloud_files(_p: &Path, _job: &Job) -> std::io::Result<()> {
    Ok(())
}

fn digest(p: &Path, job: &Job) -> std::io::Result<Option<[u8; 32]>> {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    let whole = crate::props::read_chunks(p, job.cancel_flag(), |b| h.update(b)).map_err(std::io::Error::other)?;
    Ok(whole.then(|| h.finalize().into()))
}

/// Reads every file of both trees and compares their SHA-256. The caller removes a copy that fails.
pub(super) fn verify_tree(from: &Path, to: &Path, job: &Job) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.is_dir() {
        for item in fs::read_dir(from)? {
            let item = item?;
            verify_tree(&item.path(), &to.join(item.file_name()), job)?;
        }
    } else if meta.is_file() {
        job.set_current(&format!("Verifying {}", label(from)));
        match (digest(from, job)?, digest(to, job)?) {
            (Some(a), Some(b)) if a == b => {}
            (Some(_), Some(_)) => {
                return Err(std::io::Error::other(format!(
                    "the copy of \"{}\" didn't match the original, so the original was kept",
                    label(from)
                )))
            }
            _ => return Err(std::io::ErrorKind::Interrupted.into()),
        }
    }
    Ok(())
}

/// Counts items under `p`, including `p`, and the bytes in its files. Does not follow links.
/// Skips `._` files, which copying to FAT, exFAT or SMB adds,
/// and `.DS_Store`, which Finder rewrites at any time.
pub(super) fn tree_stats(p: &Path) -> std::io::Result<(u64, u64)> {
    let m = fs::symlink_metadata(p)?;
    let mut stats = (1, if m.is_file() { m.len() } else { 0 });
    if m.is_dir() {
        for item in fs::read_dir(p)? {
            let item = item?;
            if item.file_name().as_bytes().starts_with(b"._") || item.file_name() == ".DS_Store" {
                continue;
            }
            let (n, bytes) = tree_stats(&item.path())?;
            stats.0 += n;
            stats.1 += bytes;
        }
    }
    Ok(stats)
}

/// Lists each item under `p`, including `p`, with its path and, for a non-folder, its `jobs::revision`.
/// Does not follow links. Any add, remove, replace or write in the tree changes the result.
/// Skips `.DS_Store`, which Finder rewrites at any time.
pub(super) fn tree_revision(p: &Path) -> std::io::Result<Vec<(PathBuf, String)>> {
    fn walk(p: &Path, out: &mut Vec<(PathBuf, String)>) -> std::io::Result<()> {
        let m = fs::symlink_metadata(p)?;
        if m.is_dir() {
            out.push((p.to_path_buf(), jobs::file_id(p).unwrap_or_default()));
            for item in fs::read_dir(p)? {
                let item = item?;
                if item.file_name() != ".DS_Store" {
                    walk(&item.path(), out)?;
                }
            }
        } else {
            out.push((p.to_path_buf(), jobs::revision(&m)));
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(p, &mut out)?;
    out.sort();
    Ok(out)
}

/// Copies for a move. Checks that the copy has every item and byte, and that the original did not change.
/// Returns the `tree_revision` of the original, to check again before deleting it.
pub(super) fn copy_verified(from: &Path, to: &Path, job: &Job) -> std::io::Result<Vec<(PathBuf, String)>> {
    // Download first: a download could change the revision and fail the move.
    download_cloud_files(from, job)?;
    let before = tree_revision(from)?;
    copy_downloaded(from, to, job)?;
    if tree_revision(from)? != before {
        return Err(std::io::Error::other(
            "the original changed while it was being copied, so it was kept",
        ));
    }
    if tree_stats(from)? != tree_stats(to)? {
        return Err(std::io::Error::other(
            "the copy didn't match the original, so the original was kept",
        ));
    }
    Ok(before)
}

#[cfg(target_os = "macos")]
pub(super) mod macos_copy {
    use crate::jobs::Job;
    use std::ffi::{CStr, CString, OsStr};
    use std::fs;
    use std::os::raw::{c_char, c_int, c_void};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    const COPYFILE_ACL: u32 = 1 << 0;
    const COPYFILE_STAT: u32 = 1 << 1;
    const COPYFILE_XATTR: u32 = 1 << 2;
    const COPYFILE_DATA: u32 = 1 << 3;
    const COPYFILE_ALL: u32 = COPYFILE_ACL | COPYFILE_STAT | COPYFILE_XATTR | COPYFILE_DATA;
    const COPYFILE_RECURSIVE: u32 = 1 << 15;
    const COPYFILE_EXCL: u32 = 1 << 17;
    const COPYFILE_NOFOLLOW_SRC: u32 = 1 << 18;
    const COPYFILE_CLONE: u32 = 1 << 24;

    const STATE_STATUS_CB: u32 = 6;
    const STATE_STATUS_CTX: u32 = 7;
    const STATE_COPIED: u32 = 8;

    const RECURSE_FILE: c_int = 1;
    const COPY_DATA: c_int = 4;
    const STAGE_START: c_int = 1;
    const STAGE_FINISH: c_int = 2;
    const STAGE_ERR: c_int = 3;
    const STAGE_PROGRESS: c_int = 4;
    const CONTINUE: c_int = 0;
    const QUIT: c_int = 2;

    extern "C" {
        fn copyfile(from: *const c_char, to: *const c_char, state: *mut c_void, flags: u32)
            -> c_int;
        fn copyfile_state_alloc() -> *mut c_void;
        fn copyfile_state_free(state: *mut c_void) -> c_int;
        fn copyfile_state_set(state: *mut c_void, flag: u32, src: *const c_void) -> c_int;
        fn copyfile_state_get(state: *mut c_void, flag: u32, dst: *mut c_void) -> c_int;
    }

    struct Ctx<'a> {
        job: &'a Job,
        last: u64,
        added: u64,
    }

    impl Ctx<'_> {
        /// Reports the bytes of a `len`-byte file not yet reported.
        /// A clone copies no data, so it reports no progress.
        fn finish(&mut self, len: u64) {
            let rest = len.saturating_sub(self.last);
            self.job.add_bytes(rest);
            self.added += rest;
            self.last = len;
        }
    }

    extern "C" fn on_status(
        what: c_int,
        stage: c_int,
        state: *mut c_void,
        src: *const c_char,
        _dst: *const c_char,
        ctx: *mut c_void,
    ) -> c_int {
        let c = unsafe { &mut *(ctx as *mut Ctx) };
        c.job.wait_while_paused();
        if c.job.cancelled() || stage == STAGE_ERR {
            return QUIT;
        }
        match (what, stage) {
            (RECURSE_FILE, STAGE_START) if !src.is_null() => {
                c.last = 0;
                let path = unsafe { CStr::from_ptr(src) }.to_string_lossy();
                if let Some(name) = path.rsplit('/').next() {
                    c.job.set_current(name);
                }
            }
            (COPY_DATA, STAGE_PROGRESS) => {
                let mut copied: i64 = 0;
                unsafe {
                    copyfile_state_get(state, STATE_COPIED, &mut copied as *mut i64 as *mut c_void)
                };
                let copied = copied.max(0) as u64;
                if copied > c.last {
                    c.job.add_bytes(copied - c.last);
                    c.added += copied - c.last;
                }
                c.last = copied;
            }
            (RECURSE_FILE, STAGE_FINISH) if !src.is_null() => {
                let path = crate::paths::real(OsStr::from_bytes(unsafe { CStr::from_ptr(src) }.to_bytes()));
                if let Some(m) = fs::symlink_metadata(path).ok().filter(|m| m.is_file()) {
                    c.finish(m.len());
                }
            }
            _ => {}
        }
        CONTINUE
    }

    pub fn copy(from: &Path, to: &Path, job: &Job, clone: bool) -> std::io::Result<()> {
        let src = CString::new(from.as_os_str().as_bytes())?;
        let dst = CString::new(to.as_os_str().as_bytes())?;
        let mut ctx = Ctx { job, last: 0, added: 0 };
        // NOFOLLOW_SRC copies a top-level symlink as the link, as the recursive copy does inside a folder.
        // Without it a dangling link fails and a link to a folder becomes a copy of the folder.
        let flags = COPYFILE_ALL
            | COPYFILE_RECURSIVE
            | COPYFILE_NOFOLLOW_SRC
            | if clone {
                COPYFILE_CLONE
            } else {
                COPYFILE_EXCL | COPYFILE_NOFOLLOW_SRC
            };
        unsafe {
            let state = copyfile_state_alloc();
            if state.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            copyfile_state_set(state, STATE_STATUS_CB, on_status as *const () as *const c_void);
            copyfile_state_set(
                state,
                STATE_STATUS_CTX,
                &mut ctx as *mut Ctx as *const c_void,
            );
            let rc = copyfile(src.as_ptr(), dst.as_ptr(), state, flags);
            let err = std::io::Error::last_os_error();
            copyfile_state_free(state);
            if rc == 0 {
                // A lone file may be copied with no per-file callbacks.
                if let Some(m) = fs::symlink_metadata(from).ok().filter(|m| m.is_file()) {
                    if ctx.added < m.len() {
                        ctx.last = ctx.added;
                        ctx.finish(m.len());
                    }
                }
                Ok(())
            } else if job.cancelled() {
                Err(std::io::ErrorKind::Interrupted.into())
            } else {
                Err(err)
            }
        }
    }
}

/// Keeps the source's atime and mtime on the copy, links included.
#[cfg(not(target_os = "macos"))]
pub(crate) fn keep_times(from: &Path, to: &Path) {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = fs::symlink_metadata(from) else { return };
    let times = [
        libc::timespec { tv_sec: meta.atime(), tv_nsec: meta.atime_nsec() },
        libc::timespec { tv_sec: meta.mtime(), tv_nsec: meta.mtime_nsec() },
    ];
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(to.as_os_str().as_bytes()) else { return };
    unsafe { libc::utimensat(libc::AT_FDCWD, c.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
}

/// Copies `user.*` and other writable xattrs, links included. Best effort:
/// filesystems without xattrs and attributes the user may not set are skipped.
#[cfg(not(target_os = "macos"))]
pub(crate) fn keep_xattrs(from: &Path, to: &Path) {
    use std::os::unix::ffi::OsStrExt;
    let (Ok(src), Ok(dst)) = (
        std::ffi::CString::new(from.as_os_str().as_bytes()),
        std::ffi::CString::new(to.as_os_str().as_bytes()),
    ) else {
        return;
    };
    unsafe {
        let n = libc::llistxattr(src.as_ptr(), std::ptr::null_mut(), 0);
        if n <= 0 {
            return;
        }
        let mut list = vec![0u8; n as usize];
        let n = libc::llistxattr(src.as_ptr(), list.as_mut_ptr() as *mut _, list.len());
        if n <= 0 {
            return;
        }
        for name in list[..n as usize].split(|&b| b == 0).filter(|s| !s.is_empty()) {
            let Ok(name_c) = std::ffi::CString::new(name) else { continue };
            let v = libc::lgetxattr(src.as_ptr(), name_c.as_ptr(), std::ptr::null_mut(), 0);
            if v < 0 {
                continue;
            }
            let mut val = vec![0u8; v as usize];
            let v = libc::lgetxattr(src.as_ptr(), name_c.as_ptr(), val.as_mut_ptr() as *mut _, val.len());
            if v >= 0 {
                libc::lsetxattr(dst.as_ptr(), name_c.as_ptr(), val.as_ptr() as *const _, v as usize, 0);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn copy_downloaded(from: &Path, to: &Path, job: &Job) -> std::io::Result<()> {
    use std::io::{Read, Write};

    if job.cancelled() {
        return Err(std::io::ErrorKind::Interrupted.into());
    }
    if exists(to) {
        return Err(std::io::ErrorKind::AlreadyExists.into());
    }
    let meta = fs::symlink_metadata(from)?;
    if meta.is_dir() {
        fs::create_dir(to)?;
        for item in fs::read_dir(from)? {
            let item = item?;
            copy_downloaded(&item.path(), &to.join(item.file_name()), job)?;
        }
        fs::set_permissions(to, meta.permissions())?;
    } else if meta.file_type().is_symlink() {
        std::os::unix::fs::symlink(fs::read_link(from)?, to)?;
    } else if !meta.is_file() {
        // A FIFO blocks forever on open, a socket fails late, and a device file reads
        // endlessly. copyfile refused them too, so a clear error beats hanging the job
        // where Cancel could not reach it.
        return Err(std::io::Error::other(format!(
            "\"{}\": special files can't be copied",
            label(from)
        )));
    } else {
        let mut src = fs::File::open(from)?;
        let mut dst = fs::OpenOptions::new().write(true).create_new(true).open(to)?;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            job.wait_while_paused();
            if job.cancelled() {
                return Err(std::io::ErrorKind::Interrupted.into());
            }
            let n = src.read(&mut buf)?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n])?;
            job.add_bytes(n as u64);
        }
        fs::set_permissions(to, meta.permissions())?;
    }
    keep_times(from, to);
    keep_xattrs(from, to);
    // A copy on one volume is a clone of the same blocks. Reading both sides would prove nothing.
    if job.verifies() && !on_same_volume(from, to.parent().unwrap_or(to)) {
        verify_tree(from, to, job)?;
    }
    Ok(())
}

