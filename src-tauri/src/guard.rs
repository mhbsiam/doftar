//! Locations Doftar never moves, renames, trashes or deletes: the disk root, system folders, volume roots, the Trash and the home folders.
//! The UI never offers these operations. This is the last defense if a bug or a hijacked webview sends the request.

use std::fs;
use std::path::{Component, Path, PathBuf};

#[cfg(target_os = "macos")]
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

#[cfg(not(target_os = "macos"))]
const PROTECTED: &[&str] = &[
    "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/lost+found",
    "/media", "/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/snap", "/srv",
    "/sys", "/tmp", "/usr", "/var", "/var/tmp",
];

/// Everything inside these is part of macOS.
#[cfg(target_os = "macos")]
const PROTECTED_TREES: &[&str] = &["/System", "/bin", "/dev", "/sbin", "/usr"];

/// Everything inside these belongs to the system, not to a user.
#[cfg(not(target_os = "macos"))]
const PROTECTED_TREES: &[&str] = &[
    "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root", "/sbin",
    "/snap", "/sys", "/usr", "/var",
];

/// Except these. They belong to the user, for example Homebrew.
#[cfg(target_os = "macos")]
const OPEN_TREES: &[&str] = &["/usr/local"];

/// Except these. /usr/local is user-installed software; /var/tmp holds user files.
#[cfg(not(target_os = "macos"))]
const OPEN_TREES: &[&str] = &["/usr/local", "/var/tmp"];

#[cfg(target_os = "macos")]
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

#[cfg(not(target_os = "macos"))]
const HOME_FOLDERS: &[&str] = &[
    ".config", ".local", ".ssh", ".gnupg", "Desktop", "Documents", "Downloads",
    "Music", "Pictures", "Public", "Templates", "Videos", "snap",
];

/// Inside home, whole trees that hold credentials or the desktop environment.
#[cfg(not(target_os = "macos"))]
const HOME_TREES: &[&str] = &[".ssh", ".gnupg"];

/// Resolve the parent symlinks and `..`. Keep the last component: removing a symlink named "Documents" removes the link.
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

/// APFS is case-insensitive by default. Refuse "/users" like "/Users".
#[cfg(target_os = "macos")]
fn key(p: &Path) -> String {
    p.to_string_lossy().to_lowercase()
}

/// Linux paths are case-sensitive.
#[cfg(not(target_os = "macos"))]
fn key(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn under(p: &str, tree: &str) -> bool {
    p == tree || p.starts_with(&format!("{tree}/"))
}

/// A mounted volume root. Ejecting is a separate, safe operation.
#[cfg(target_os = "macos")]
fn is_volume_root(real: &Path) -> bool {
    real.parent().map(key).as_deref() == Some("/volumes")
}

/// Volume roots sit under /mnt, /media/<user>, /run/media/<user> or /media itself.
#[cfg(not(target_os = "macos"))]
fn is_volume_root(real: &Path) -> bool {
    let Some(parent) = real.parent() else {
        return false;
    };
    let pk = key(parent);
    if pk == "/mnt" || pk == "/media" {
        return true;
    }
    parent
        .parent()
        .map(|gp| {
            let gk = key(gp);
            gk == "/media" || gk == "/run/media"
        })
        .unwrap_or(false)
}

fn protected_in(real: &Path, home: Option<&Path>) -> bool {
    let k = key(real);
    #[cfg(target_os = "macos")]
    let protected_list = PROTECTED.iter().any(|p| key(&(crate::paths::real(p))) == k);
    #[cfg(not(target_os = "macos"))]
    let protected_list = PROTECTED.iter().any(|p| *p == k);
    if protected_list {
        return true;
    }
    if PROTECTED_TREES.iter().any(|t| under(&k, &t.to_lowercase()))
        && !OPEN_TREES.iter().any(|t| under(&k, &t.to_lowercase()))
    {
        return true;
    }
    if is_volume_root(real) {
        return true;
    }
    if let Some(home) = home {
        let home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
        if key(&home) == k || HOME_FOLDERS.iter().any(|f| key(&home.join(f)) == k) {
            return true;
        }
        #[cfg(not(target_os = "macos"))]
        if let Ok(rel) = real.strip_prefix(&home) {
            let rk = key(rel);
            if HOME_TREES.iter().any(|t| under(&rk, t)) {
                return true;
            }
        }
    }
    false
}

/// Refuse a change to a protected location or a path that is not absolute to a named item.
pub fn check(path: &Path) -> Result<(), String> {
    let real = resolve(path).ok_or_else(|| "invalid path".to_string())?;
    if protected_in(&real, dirs::home_dir().as_deref()) {
        let by = if cfg!(target_os = "macos") { "macOS" } else { "the system" };
        return Err(format!("it's required by {by} and can't be changed"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(p: &str, home: &str) -> bool {
        resolve(&(crate::paths::real(p))).is_none_or(|r| protected_in(&r, Some(&(crate::paths::real(home)))))
    }

    #[cfg(target_os = "macos")]
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

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn refuses_system_and_home_locations() {
        let home = "/home/nobody-doftar-test";
        for p in [
            "/",
            "/etc",
            "/etc/passwd",
            "/boot/vmlinuz",
            "/usr/bin/true",
            "/var/log/syslog",
            "/proc/cpuinfo",
            "/sys/kernel",
            "/dev/sda",
            "/bin/sh",
            "/lib/x86_64-linux-gnu/libc.so.6",
            "/root",
            "/root/anything",
            "/snap/core",
            "/mnt/usb",
            "/media/user/External",
            "/run/media/user/External",
            home,
            "/home/nobody-doftar-test/Documents",
            "/home/nobody-doftar-test/.config",
            "/home/nobody-doftar-test/.ssh",
            "/home/nobody-doftar-test/.ssh/id_ed25519",
            "relative/path",
            "/home/..",
        ] {
            assert!(refused(p, home), "{p} should be protected");
        }
    }

    #[cfg(target_os = "macos")]
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

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn allows_ordinary_items() {
        let home = "/home/nobody-doftar-test";
        for p in [
            "/usr/local/bin/tool",
            "/opt/vendor/app",
            "/mnt/usb/photo.jpg",
            "/media/user/External/photo.jpg",
            "/run/media/user/External/photo.jpg",
            "/var/tmp/scratch",
            "/tmp/scratch",
            "/home/nobody-doftar-test/Documents/report.pdf",
            "/home/nobody-doftar-test/.config/app/settings.conf",
            "/home/nobody-doftar-test/.local/share/Trash/files/old.txt",
            "/home/nobody-doftar-test/Projects",
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
        // The link itself may go. Check what it points into.
        assert!(check(&link).is_ok());
        #[cfg(target_os = "macos")]
        {
            assert!(check(&link.join("System")).is_err());
            assert!(check(&link.join("Applications")).is_err());
        }
        #[cfg(not(target_os = "macos"))]
        {
            assert!(check(&link.join("etc")).is_err());
            assert!(check(&link.join("usr")).is_err());
        }
        fs::remove_dir_all(&base).unwrap();
    }
}
