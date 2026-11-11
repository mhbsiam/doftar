//! Uninstall apps: find the files an app leaves in `~/Library`, and remove root-owned bundles with user permission.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Leftover {
    pub path: String,
    pub bytes: u64,
}

fn bundle_names(app: &Path) -> (Option<String>, Option<String>) {
    let info = plist::Value::from_file(app.join("Contents").join("Info.plist")).ok();
    let dict = info.as_ref().and_then(|v| v.as_dictionary());
    let get = |key: &str| {
        dict.and_then(|d| d.get(key))
            .and_then(|v| v.as_string())
            .filter(|s| !s.is_empty() && !s.contains('/'))
            .map(str::to_string)
    };
    let id = get("CFBundleIdentifier").filter(|s| is_bundle_id(s));
    let name = get("CFBundleName").or_else(|| {
        app.file_stem().map(|s| s.to_string_lossy().into_owned())
    });
    (id, name)
}

/// True if `s` is a bundle identifier: two or more dot-separated labels of letters, digits, `-` and `_`.
/// Anything else, such as "..", could name a whole Library folder when joined.
fn is_bundle_id(s: &str) -> bool {
    let labels: Vec<&str> = s.split('.').collect();
    s.len() <= 255
        && labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty() && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}

/// True if joining `name` onto a folder stays inside that folder.
fn is_single_name(name: &str) -> bool {
    use std::path::Component;
    let mut c = Path::new(name).components();
    !name.contains('/') && matches!((c.next(), c.next()), (Some(Component::Normal(_)), None))
}

/// Match only the bundle identifier, not the display name. Another product can share a display name.
fn candidate_paths(home: &Path, id: Option<&str>) -> Vec<PathBuf> {
    let lib = home.join("Library");
    let Some(id) = id.filter(|id| is_bundle_id(id)) else { return Vec::new() };
    [
        ("Application Support", id.to_string()),
        ("Caches", id.to_string()),
        ("Preferences", format!("{id}.plist")),
        ("Containers", id.to_string()),
        ("Saved Application State", format!("{id}.savedState")),
        ("HTTPStorages", id.to_string()),
        ("HTTPStorages", format!("{id}.binarycookies")),
        ("WebKit", id.to_string()),
        ("Cookies", format!("{id}.binarycookies")),
        ("LaunchAgents", format!("{id}.plist")),
        ("Logs", id.to_string()),
    ]
    .into_iter()
    .filter(|(_, name)| is_single_name(name))
    .map(|(dir, name)| lib.join(dir).join(name))
    .collect()
}

fn tree_bytes(p: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(p) else { return 0 };
    if !meta.is_dir() {
        return meta.len();
    }
    fs::read_dir(p)
        .map(|rd| rd.flatten().map(|e| tree_bytes(&e.path())).sum())
        .unwrap_or(0)
}

fn find_leftovers(home: &Path, app: &Path) -> Vec<Leftover> {
    let (id, _) = bundle_names(app);
    let mut seen = std::collections::HashSet::new();
    let mut found: Vec<PathBuf> = candidate_paths(home, id.as_deref())
        .into_iter()
        .filter(|p| fs::symlink_metadata(p).is_ok() && seen.insert(p.clone()))
        .collect();
    // Group containers are named "<team>.<identifier>". Match by suffix.
    if let Some(id) = id.as_deref() {
        if let Ok(rd) = fs::read_dir(home.join("Library").join("Group Containers")) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if n == id || n.ends_with(&format!(".{id}")) {
                    found.push(e.path());
                }
            }
        }
    }
    found
        .into_iter()
        .map(|p| Leftover { bytes: tree_bytes(&p), path: p.to_string_lossy().into_owned() })
        .collect()
}

#[tauri::command(async)]
pub fn app_leftovers(path: String) -> Vec<Leftover> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    let app = Path::new(&path);
    if app.extension().is_none_or(|e| !e.eq_ignore_ascii_case("app")) {
        return Vec::new();
    }
    find_leftovers(&home, app)
}

/// The admin deletion removes only an app bundle in an Applications folder.
fn is_installed_app(path: &Path, home: Option<&Path>) -> bool {
    use std::path::Component;
    if !path.is_absolute() || path.components().any(|c| c == Component::ParentDir) {
        return false;
    }
    if path.extension().is_none_or(|e| !e.eq_ignore_ascii_case("app")) {
        return false;
    }
    let in_system = path.starts_with("/Applications") && path != Path::new("/Applications");
    let in_user = home.is_some_and(|h| {
        let d = h.join("Applications");
        path.starts_with(&d) && path != d
    });
    in_system || in_user
}

/// Root `rm -rf` of `paths`. Each path is checked again as root.
/// A folder swapped for a symlink during the password prompt must not redirect the deletion.
fn admin_shell(paths: &[String]) -> String {
    use crate::launcher::shell_quote;
    let steps: Vec<String> = paths
        .iter()
        .map(|p| {
            let q = shell_quote(p);
            format!(
                "{{ [ \"$(/bin/realpath -- {q})\" = {q} ] || {{ echo {q} changed, so it was not removed >&2; exit 1; }}; }} && /bin/rm -rf -- {q}"
            )
        })
        .collect();
    steps.join(" && ")
}

fn admin_script(paths: &[String]) -> String {
    format!(
        "do shell script \"{}\" with administrator privileges",
        crate::launcher::applescript_quote(&admin_shell(paths))
    )
}

/// Refuses anything that is not an app in `Applications`.
#[tauri::command]
pub async fn delete_apps_with_admin(paths: Vec<String>) -> Result<(), String> {
    crate::jobs::blocking(move || {
        let home = dirs::home_dir();
        // Check the path as given and as it really is. A symlink, or a folder named like an app, must not reach `rm -rf`.
        // The real path reaches `rm -rf`, so the root shell can check it.
        let real = |p: &String| {
            let given = Path::new(p);
            let real = fs::canonicalize(given).ok()?;
            (is_installed_app(given, home.as_deref())
                && is_installed_app(&real, home.as_deref())
                && crate::openwith::is_app_bundle(&real.to_string_lossy()))
            .then(|| real.to_string_lossy().into_owned())
        };
        let Some(paths) = paths.iter().map(real).collect::<Option<Vec<_>>>().filter(|p| !p.is_empty()) else {
            return Err("Only apps in an Applications folder can be removed this way".to_string());
        };
        let out = Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(admin_script(&paths))
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(());
        }
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("-128") || err.to_lowercase().contains("cancel") {
            Err("cancelled".to_string())
        } else {
            Err(err.trim().to_string())
        }
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("wf-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn fake_app(dir: &Path, name: &str, id: &str) -> PathBuf {
        let app = dir.join(format!("{name}.app"));
        fs::create_dir_all(app.join("Contents")).unwrap();
        let mut d = plist::Dictionary::new();
        d.insert("CFBundleIdentifier".into(), plist::Value::String(id.into()));
        d.insert("CFBundleName".into(), plist::Value::String(name.into()));
        plist::Value::Dictionary(d)
            .to_file_xml(app.join("Contents").join("Info.plist"))
            .unwrap();
        app
    }

    #[test]
    fn finds_only_this_apps_leftovers() {
        let base = scratch("left");
        let home = base.join("home");
        let lib = home.join("Library");
        for d in [
            "Application Support/com.acme.Tool",
            "Application Support/Tool",
            "Application Support/com.acme.ToolKit",
            "Caches/com.acme.Tool",
            "Containers/com.acme.Tool/Data",
            "Group Containers/ABCDE12345.com.acme.Tool",
            "Group Containers/ABCDE12345.com.acme.Other",
        ] {
            fs::create_dir_all(lib.join(d)).unwrap();
        }
        fs::create_dir_all(lib.join("Preferences")).unwrap();
        fs::write(lib.join("Preferences/com.acme.Tool.plist"), vec![0u8; 40]).unwrap();
        fs::write(lib.join("Caches/com.acme.Tool/blob"), vec![0u8; 1000]).unwrap();
        let app = fake_app(&base, "Tool", "com.acme.Tool");

        let mut paths: Vec<String> = find_leftovers(&home, &app)
            .into_iter()
            .map(|l| l.path.strip_prefix(&format!("{}/Library/", home.display())).unwrap().to_string())
            .collect();
        paths.sort();
        assert_eq!(
            paths,
            [
                "Application Support/com.acme.Tool",
                "Caches/com.acme.Tool",
                "Containers/com.acme.Tool",
                "Group Containers/ABCDE12345.com.acme.Tool",
                "Preferences/com.acme.Tool.plist",
            ]
        );
        let cache = find_leftovers(&home, &app).into_iter().find(|l| l.path.ends_with("Caches/com.acme.Tool")).unwrap();
        assert_eq!(cache.bytes, 1000);
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn odd_identifiers_never_name_a_library_folder() {
        for ok in ["com.acme.Tool", "org.foo-bar.App_2", "ab.c"] {
            assert!(is_bundle_id(ok), "{ok} should be accepted");
        }
        for bad in ["", ".", "..", "...", "com", ".com.acme", "com.acme.", "com..acme", "a/b.c", "com.acme.Tool ", "com.ac me"] {
            assert!(!is_bundle_id(bad), "{bad:?} must be refused");
            assert!(candidate_paths(Path::new("/Users/me"), Some(bad)).is_empty());
        }
        let lib = Path::new("/Users/me/Library");
        for p in candidate_paths(Path::new("/Users/me"), Some("com.acme.Tool")) {
            let parent = p.parent().unwrap();
            assert!(parent.starts_with(lib) && parent != lib, "{p:?}");
        }
        let base = scratch("dotid");
        let app = fake_app(&base, "Dot", ".");
        fs::create_dir_all(base.join("home/Library/Caches/x")).unwrap();
        assert!(find_leftovers(&base.join("home"), &app).is_empty());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn admin_deletion_only_accepts_installed_apps() {
        let home = Path::new("/Users/me");
        assert!(is_installed_app(Path::new("/Applications/Foo.app"), Some(home)));
        assert!(is_installed_app(Path::new("/Applications/Utilities/Bar.app"), Some(home)));
        assert!(is_installed_app(Path::new("/Users/me/Applications/Baz.app"), Some(home)));
        for bad in [
            "/Applications",
            "/Applications/Foo",
            "/Applications/../etc/Foo.app",
            "/System/Applications/Mail.app",
            "/Users/me/Documents/Foo.app",
            "Applications/Foo.app",
            "/",
        ] {
            assert!(!is_installed_app(Path::new(bad), Some(home)), "{bad} must be refused");
        }
    }

    #[test]
    fn admin_script_quotes_awkward_names() {
        let s = admin_script(&["/Applications/My \"App's\".app".into()]);
        assert_eq!(s.replace("\\\"", "").matches('"').count(), 2, "{s}");
        assert!(s.ends_with("\" with administrator privileges"));
    }

    #[test]
    fn admin_shell_removes_only_what_is_still_its_real_path() {
        let base = fs::canonicalize(scratch("admin-shell")).unwrap();
        let (app, dir) = (base.join("My \"App's\".app"), base.join("dir"));
        fs::create_dir_all(&app).unwrap();
        fs::create_dir_all(dir.join("X.app")).unwrap();
        std::os::unix::fs::symlink(&dir, base.join("link")).unwrap();
        let run = |p: &Path| {
            let line = admin_shell(&[p.to_string_lossy().into_owned()]);
            Command::new("/bin/sh").arg("-c").arg(line).output().unwrap().status.success()
        };
        assert!(!run(&base.join("link/X.app")));
        assert!(dir.join("X.app").exists());
        assert!(run(&app));
        assert!(!app.exists());
        fs::remove_dir_all(&base).unwrap();
    }
}
