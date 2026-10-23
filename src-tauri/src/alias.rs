//! Finder aliases: recognising them and following them (and, for tests,
//! making them).

use serde::Serialize;
use std::path::Path;

use crate::fsops::label;
#[cfg(test)]
use crate::fsops::path_str;
#[cfg(test)]
use crate::jobs::{OpResult, Step};

/// The Finder flag that marks a file as an alias (`kIsAlias`).
const IS_ALIAS: u16 = 0x8000;

/// True when 32 bytes of Finder info mark the file as an alias.
pub fn finder_info_is_alias(info: &[u8; 32]) -> bool {
    u16::from_be_bytes([info[8], info[9]]) & IS_ALIAS != 0
}

/// True for a Finder alias file. Reads the Finder info attribute, so callers
/// on a hot path should only ask about regular files.
#[cfg(target_os = "macos")]
pub fn is_alias_file(p: &Path) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = CString::new(p.as_os_str().as_bytes()) else { return false };
    let mut info = [0u8; 32];
    // SAFETY: valid C string, buffer of the size given.
    let n = unsafe {
        libc::getxattr(
            c.as_ptr(),
            c"com.apple.FinderInfo".as_ptr(),
            info.as_mut_ptr() as *mut libc::c_void,
            info.len(),
            0,
            libc::XATTR_NOFOLLOW,
        )
    };
    n == 32 && finder_info_is_alias(&info)
}

#[cfg(not(target_os = "macos"))]
pub fn is_alias_file(_p: &Path) -> bool {
    false
}

/// "Report alias", then "Report alias 2", ... next to the original, as Finder names them.
#[cfg(test)]
fn alias_path(original: &Path) -> Option<std::path::PathBuf> {
    let dir = original.parent()?;
    let name = label(original);
    let first = dir.join(format!("{name} alias"));
    if !first.exists() && std::fs::symlink_metadata(&first).is_err() {
        return Some(first);
    }
    (2..).map(|n| dir.join(format!("{name} alias {n}"))).find(|p| std::fs::symlink_metadata(p).is_err())
}

#[cfg(all(test, target_os = "macos"))]
fn make_one(original: &Path) -> Result<String, String> {
    use objc2_foundation::{NSString, NSURLBookmarkCreationOptions, NSURL};

    let url = NSURL::fileURLWithPath(&NSString::from_str(&path_str(original)));
    let data = url
        .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
            NSURLBookmarkCreationOptions::SuitableForBookmarkFile,
            None,
            None,
        )
        .map_err(|e| e.localizedDescription().to_string())?;
    let dest = alias_path(original).ok_or("no folder to put the alias in")?;
    let dest_url = NSURL::fileURLWithPath(&NSString::from_str(&path_str(&dest)));
    NSURL::writeBookmarkData_toURL_options_error(&data, &dest_url, 0)
        .map_err(|e| e.localizedDescription().to_string())?;
    Ok(path_str(&dest))
}

#[cfg(all(test, not(target_os = "macos")))]
fn make_one(_original: &Path) -> Result<String, String> {
    Err("aliases need macOS".into())
}

/// Makes a Finder alias of each path next to it; the inverse trashes them.
/// Tests use it to get real alias files.
#[cfg(test)]
pub fn make_aliases(paths: Vec<String>) -> OpResult {
    let mut res = OpResult::default();
    for p in &paths {
        let original = Path::new(p);
        match make_one(original) {
            Ok(alias) => res.inverse.push(Step::trash(alias)),
            Err(e) => res.errors.push(format!("\"{}\": {e}", label(original))),
        }
    }
    res
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasTarget {
    pub path: String,
    /// A folder to browse; packages such as apps count as files.
    pub is_dir: bool,
}

/// What an alias points to, finding the original if it has moved.
#[tauri::command(async)]
pub fn resolve_alias(path: String) -> Result<AliasTarget, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSString, NSURLBookmarkResolutionOptions, NSURL};
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path));
        let target = NSURL::URLByResolvingAliasFileAtURL_options_error(
            &url,
            NSURLBookmarkResolutionOptions::WithoutUI,
        )
        .map_err(|_| format!("The original of \"{}\" can't be found", label(Path::new(&path))))?;
        let p = target.path().map(|s| s.to_string()).ok_or("the alias has no target")?;
        let target = Path::new(&p);
        let ext = target
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let is_dir = target.is_dir() && !crate::fsops::is_package_dir(target, &ext);
        Ok(AliasTarget { path: p, is_dir })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(format!("can't resolve {path}"))
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn makes_resolvable_finder_aliases() {
        let base = std::env::temp_dir().join(format!("wf-alias-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("Folder")).unwrap();
        fs::write(base.join("note.txt"), "hi").unwrap();

        let res = make_aliases(vec![
            path_str(&base.join("note.txt")),
            path_str(&base.join("Folder")),
            path_str(&base.join("note.txt")),
        ]);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        let made: Vec<String> = res
            .inverse
            .iter()
            .map(|s| match s {
                Step::Trash { path, .. } => path.clone(),
                other => panic!("unexpected step {other:?}"),
            })
            .collect();
        assert_eq!(
            made,
            [
                path_str(&base.join("note.txt alias")),
                path_str(&base.join("Folder alias")),
                path_str(&base.join("note.txt alias 2")),
            ]
        );
        for p in &made {
            assert!(is_alias_file(Path::new(p)), "{p} should be flagged as an alias");
        }
        assert!(!is_alias_file(&base.join("note.txt")));

        let folder = resolve_alias(made[1].clone()).unwrap();
        assert!(folder.is_dir);
        assert_eq!(
            fs::canonicalize(&folder.path).unwrap(),
            fs::canonicalize(base.join("Folder")).unwrap()
        );
        let file = resolve_alias(made[0].clone()).unwrap();
        assert!(!file.is_dir);
        fs::remove_dir_all(&base).unwrap();
    }
}
