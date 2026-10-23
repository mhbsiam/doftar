//! Locations Doftar never moves, renames, trashes or deletes, whatever the
//! window asks for: the disk root, system folders, volume roots, the Trash,
//! and the home folder with its standard folders. The UI never offers these
//! operations on them; this is the last line of defense if a bug or a
//! hijacked webview sends the request anyway.

use std::fs;
use std::path::{Component, Path, PathBuf};

const PROTECTED: &[&str] = &[
    "/",
    "/Applications",
    "/Library",
    "/Network",
    "/System",
    "/Users",
    "/Volumes",
    "/bin",
    "/cores",
    "/dev",
    "/etc",
    "/opt",
    "/private",
    "/private/etc",
    "/private/tmp",
    "/private/var",
    "/sbin",
    "/tmp",
    "/usr",
    "/var",
];

/// Everything inside these is part of macOS itself.
const PROTECTED_TREES: &[&str] = &["/System", "/bin", "/dev", "/sbin", "/usr"];

/// Except these, which belong to the user (Homebrew and friends).
const OPEN_TREES: &[&str] = &["/usr/local"];

const HOME_FOLDERS: &[&str] = &[
    ".Trash",
    "Applications",
    "Desktop",
    "Documents",
    "Downloads",
    "Library",
    "Movies",
    "Music",
    "Pictures",
    "Public",
];

/// `path` with its parent's symlinks and `..` resolved. The last component
/// stays as it is: removing a symlink named "Documents" removes the link.
fn resolve(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let name = match path.components().next_back()? {
        Component::Normal(n) => n,
        _ => return None,
    };
    let parent = path.parent()?;
    let parent = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    Some(parent.join(name))
}

/// APFS is case-insensitive by default, so "/users" must be refused like
/// "/Users".
fn key(p: &Path) -> String {
    p.to_string_lossy().to_lowercase()
}

fn under(p: &str, tree: &str) -> bool {
    p == tree || p.starts_with(&format!("{tree}/"))
}

fn protected_in(real: &Path, home: Option<&Path>) -> bool {
    let k = key(real);
    if PROTECTED.iter().any(|p| key(Path::new(p)) == k) {
        return true;
    }
    if PROTECTED_TREES.iter().any(|t| under(&k, &t.to_lowercase()))
        && !OPEN_TREES.iter().any(|t| under(&k, &t.to_lowercase()))
    {
        return true;
    }
    // A mounted volume's root (ejecting is a separate, safe operation).
    if real.parent().map(key).as_deref() == Some("/volumes") {
        return true;
    }
    if let Some(home) = home {
        let home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
        if key(&home) == k || HOME_FOLDERS.iter().any(|f| key(&home.join(f)) == k) {
            return true;
        }
    }
    false
}

/// Refuses to change `path` when it is a protected location (or not an
/// absolute path to a named item at all).
pub fn check(path: &Path) -> Result<(), String> {
    let real = resolve(path).ok_or_else(|| "invalid path".to_string())?;
    if protected_in(&real, dirs::home_dir().as_deref()) {
        return Err("it's required by macOS and can't be changed".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(p: &str, home: &str) -> bool {
        resolve(Path::new(p)).map_or(true, |r| protected_in(&r, Some(Path::new(home))))
    }

    #[test]
    fn refuses_system_and_home_locations() {
        let home = "/Users/nobody-doftar-test";
        for p in [
            "/",
            "/Applications",
            "/users",
            "/System/Library/CoreServices",
            "/usr/bin/true",
            "/Volumes/External",
            home,
            "/Users/nobody-doftar-test/Documents",
            "/Users/nobody-doftar-test/library",
            "/Users/nobody-doftar-test/.Trash",
            "relative/path",
            "/Users/..",
        ] {
            assert!(refused(p, home), "{p} should be protected");
        }
    }

    #[test]
    fn allows_ordinary_items() {
        let home = "/Users/nobody-doftar-test";
        for p in [
            "/Applications/Some.app",
            "/usr/local/bin/tool",
            "/Volumes/External/photo.jpg",
            "/Users/nobody-doftar-test/Documents/report.pdf",
            "/Users/nobody-doftar-test/Library/Caches/thing",
            "/Users/nobody-doftar-test/.Trash/old.txt",
            "/Users/nobody-doftar-test/Projects",
        ] {
            assert!(!refused(p, home), "{p} should be allowed");
        }
    }

    #[test]
    fn resolves_symlinked_parents() {
        let base = std::env::temp_dir().join(format!("wf-guard-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let link = base.join("root-link");
        std::os::unix::fs::symlink("/", &link).unwrap();
        // The link itself may go; what it points into is still checked.
        assert!(check(&link).is_ok());
        assert!(check(&link.join("System")).is_err());
        assert!(check(&link.join("Applications")).is_err());
        fs::remove_dir_all(&base).unwrap();
    }
}
