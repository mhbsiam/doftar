//! Uninstalling apps: finding what an app leaves in `~/Library`, and removing
//! root-owned bundles with the user's permission.

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

/// The bundle identifier and display name an app declares.
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

/// Whether `s` looks like a reverse-DNS bundle identifier ("com.acme.Tool"):
/// dot-separated labels, at least two, none empty, of letters, digits, `-`
/// and `_`. Anything else (".", "..", "a..b") could name a whole Library
/// folder once joined onto it.
fn is_bundle_id(s: &str) -> bool {
    let labels: Vec<&str> = s.split('.').collect();
    s.len() <= 255
        && labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty() && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}

/// Whether `name` is one plain path component, so joining it onto a folder
/// names something inside that folder.
fn is_single_name(name: &str) -> bool {
    use std::path::Component;
    let mut c = Path::new(name).components();
    !name.contains('/') && matches!((c.next(), c.next()), (Some(Component::Normal(_)), None))
}

/// Where apps keep per-user data, by the bundle identifier they use. Only the
/// identifier is matched (not the display name, which another product could
/// share), so one app's cleanup never reaches another's files.
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
    // Group containers are named "<team>.<identifier>", so match by suffix.
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

/// What `app` leaves behind in the user's Library, with sizes.
#[tauri::command(async)]
pub fn app_leftovers(path: String) -> Vec<Leftover> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    let app = Path::new(&path);
    if app.extension().is_none_or(|e| !e.eq_ignore_ascii_case("app")) {
        return Vec::new();
    }
    find_leftovers(&home, app)
}

/// Whether `path` is an app bundle in an Applications folder: the only thing
/// the admin deletion below is willing to remove.
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

/// AppleScript for `rm -rf` of `paths` with administrator privileges.
fn admin_script(paths: &[String]) -> String {
    let quoted: Vec<String> = paths
        .iter()
        .map(|p| format!("quoted form of \"{}\"", p.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect();
    format!(
        "do shell script \"/bin/rm -rf -- \" & {} with administrator privileges",
        quoted.join(" & \" \" & ")
    )
}

/// Deletes app bundles that need administrator rights, after macOS asks the
/// user to authenticate. Refuses anything that isn't an app in `Applications`.
#[tauri::command]
pub async fn delete_apps_with_admin(paths: Vec<String>) -> Result<(), String> {
    crate::jobs::blocking(move || {
        let home = dirs::home_dir();
        // The path is checked as given and as it really is: a symlink or a
        // folder merely named like an app must not reach `rm -rf`.
        let ok = |p: &String| {
            let given = Path::new(p);
            let real = fs::canonicalize(given).unwrap_or_else(|_| given.to_path_buf());
            is_installed_app(given, home.as_deref())
                && is_installed_app(&real, home.as_deref())
                && crate::openwith::is_app_bundle(&real.to_string_lossy())
        };
        if paths.is_empty() || !paths.iter().all(ok) {
            return Err("Only apps in an Applications folder can be removed this way".to_string());
        }
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
            "Application Support/Tool", // matches only by name: must not be offered
            "Application Support/com.acme.ToolKit", // another app's: must not match
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
        let s = admin_script(&["/Applications/My \"App\".app".into(), "/Applications/B.app".into()]);
        assert_eq!(
            s,
            "do shell script \"/bin/rm -rf -- \" & quoted form of \"/Applications/My \\\"App\\\".app\" & \" \" & quoted form of \"/Applications/B.app\" with administrator privileges"
        );
    }
}
