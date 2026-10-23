//! The `com.apple.quarantine` mark Gatekeeper looks for, and the download
//! origin browsers record next to it. Doftar keeps the mark on anything it
//! unpacks from a marked archive, so an app or script inside a downloaded zip
//! still gets checked the first time it runs, as it would after Finder.

use std::ffi::CString;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

const QUARANTINE: &str = "com.apple.quarantine";
const WHERE_FROMS: &str = "com.apple.metadata:kMDItemWhereFroms";

fn cstr(path: &Path) -> Option<CString> {
    CString::new(path.as_os_str().as_bytes()).ok()
}

/// The raw value of extended attribute `name` on `path` itself (a symlink is
/// not followed), or `None` when it has none.
pub fn read_xattr(path: &Path, name: &str) -> Option<Vec<u8>> {
    let p = cstr(path)?;
    let n = CString::new(name).ok()?;
    let len = unsafe {
        libc::getxattr(p.as_ptr(), n.as_ptr(), std::ptr::null_mut(), 0, 0, libc::XATTR_NOFOLLOW)
    };
    if len < 0 {
        return None;
    }
    let mut buf = vec![0u8; len as usize];
    let got = unsafe {
        libc::getxattr(
            p.as_ptr(),
            n.as_ptr(),
            buf.as_mut_ptr() as *mut libc::c_void,
            buf.len(),
            0,
            libc::XATTR_NOFOLLOW,
        )
    };
    if got < 0 {
        return None;
    }
    buf.truncate(got as usize);
    Some(buf)
}

fn write_xattr(path: &Path, name: &str, value: &[u8]) -> bool {
    let (Some(p), Ok(n)) = (cstr(path), CString::new(name)) else {
        return false;
    };
    let rc = unsafe {
        libc::setxattr(
            p.as_ptr(),
            n.as_ptr(),
            value.as_ptr() as *const libc::c_void,
            value.len(),
            0,
            libc::XATTR_NOFOLLOW,
        )
    };
    rc == 0
}

/// The quarantine mark on `path`, if it carries one.
pub fn read(path: &Path) -> Option<Vec<u8>> {
    read_xattr(path, QUARANTINE)
}

/// Whether `path` is still quarantined (downloaded and not yet cleared).
pub fn is_quarantined(path: &Path) -> bool {
    read(path).is_some()
}

/// Puts `mark` on `path` and, for a folder, on everything inside it. Symlinks
/// get the mark themselves and are not followed. Returns how many items it
/// could not mark.
pub fn apply_tree(path: &Path, mark: &[u8]) -> usize {
    let mut failed = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(p) = stack.pop() {
        if !write_xattr(&p, QUARANTINE, mark) {
            failed += 1;
        }
        let Ok(meta) = fs::symlink_metadata(&p) else { continue };
        if meta.is_dir() {
            if let Ok(rd) = fs::read_dir(&p) {
                stack.extend(rd.flatten().map(|e| e.path()));
            }
        }
    }
    failed
}

/// Where a download came from, as recorded by the browser: usually the file's
/// URL followed by the page it was on. Empty when there is no record.
pub fn where_froms(path: &Path) -> Vec<String> {
    let Some(raw) = read_xattr(path, WHERE_FROMS) else {
        return Vec::new();
    };
    plist::from_bytes::<plist::Value>(&raw)
        .ok()
        .and_then(|v| v.into_array())
        .map(|items| {
            items
                .into_iter()
                .filter_map(|v| v.into_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_a_whole_tree_without_following_links() {
        let base = std::env::temp_dir().join(format!("wf-quar-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("out/inner")).unwrap();
        fs::write(base.join("out/a.txt"), "a").unwrap();
        fs::write(base.join("out/inner/b.txt"), "b").unwrap();
        fs::write(base.join("outside.txt"), "o").unwrap();
        std::os::unix::fs::symlink(base.join("outside.txt"), base.join("out/link")).unwrap();

        let mark = b"0083;00000000;Doftar;";
        assert_eq!(apply_tree(&base.join("out"), mark), 0);
        for p in ["out", "out/a.txt", "out/inner", "out/inner/b.txt", "out/link"] {
            assert_eq!(read(&base.join(p)).as_deref(), Some(&mark[..]), "{p}");
        }
        assert!(!is_quarantined(&base.join("outside.txt")));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn reads_where_froms_plist() {
        let base = std::env::temp_dir().join(format!("wf-wf-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let f = base.join("dl.bin");
        fs::write(&f, "x").unwrap();
        let mut buf = Vec::new();
        plist::to_writer_binary(
            &mut buf,
            &plist::Value::Array(vec![
                plist::Value::String("https://example.com/file.zip".into()),
                plist::Value::String("https://example.com/".into()),
            ]),
        )
        .unwrap();
        assert!(write_xattr(&f, WHERE_FROMS, &buf));
        assert_eq!(
            where_froms(&f),
            vec!["https://example.com/file.zip".to_string(), "https://example.com/".to_string()]
        );
        assert!(where_froms(&base).is_empty());
        fs::remove_dir_all(&base).unwrap();
    }
}
