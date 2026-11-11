use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub path: String,
    pub is_default: bool,
}

fn app_name(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(target_os = "macos")]
fn apps_for(path: &str) -> Vec<AppInfo> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let ws = NSWorkspace::sharedWorkspace();
    let default = ws
        .URLForApplicationToOpenURL(&url)
        .and_then(|u| u.path())
        .map(|p| p.to_string());
    let mut apps: Vec<AppInfo> = Vec::new();
    for u in ws.URLsForApplicationsToOpenURL(&url).iter() {
        let Some(p) = u.path().map(|p| p.to_string()) else {
            continue;
        };
        if apps.iter().any(|a| a.path == p) {
            continue;
        }
        apps.push(AppInfo {
            name: app_name(&p),
            is_default: default.as_deref() == Some(p.as_str()),
            path: p,
        });
    }
    if let Some(d) = &default {
        if !apps.iter().any(|a| &a.path == d) {
            apps.push(AppInfo {
                name: app_name(d),
                path: d.clone(),
                is_default: true,
            });
        }
    }
    sort_apps(&mut apps);
    apps
}

#[cfg(not(target_os = "macos"))]
fn apps_for(_path: &str) -> Vec<AppInfo> {
    Vec::new()
}

fn sort_apps(apps: &mut [AppInfo]) {
    apps.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

pub fn default_app(path: &str) -> Option<String> {
    apps_for(path).into_iter().find(|a| a.is_default).map(|a| a.path)
}

#[tauri::command]
pub async fn open_with_apps(path: String) -> Result<Vec<AppInfo>, String> {
    crate::jobs::blocking(move || apps_for(&path)).await
}

/// Error for a run request without confirmation. The UI asks the user, then retries with `allow_run`.
pub const NEEDS_RUN_CONFIRMATION: &str = "needs-run-confirmation";

pub fn is_app_bundle(app: &str) -> bool {
    let p = Path::new(app);
    p.is_absolute()
        && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("app"))
        && p.join("Contents").join("Info.plist").is_file()
}

/// True for an app that runs its input: a terminal or a code launcher.
fn is_runner(app: &str) -> bool {
    LAUNCHERS.contains(&app_name(app).as_str()) || installed_terminals().iter().any(|t| t.path == app)
}

/// Return `NEEDS_RUN_CONFIRMATION` for a terminal or launcher unless `allow_run` is set.
/// The check is here, so a request that skips the UI prompt gets the same answer.
#[tauri::command(async)]
pub fn open_with(window: tauri::Window, paths: Vec<String>, app: String, allow_run: Option<bool>) -> Result<(), String> {
    let allow_run = allow_run.filter(|_| may_confirm(window.label()));
    if !is_app_bundle(&app) {
        return Err(format!("\"{}\" isn't an application", app_name(&app)));
    }
    if paths.is_empty() || paths.iter().any(|p| !Path::new(p).is_absolute()) {
        return Err("nothing to open".to_string());
    }
    if !allow_run.unwrap_or(false) && is_runner(&app) {
        return Err(NEEDS_RUN_CONFIRMATION.to_string());
    }
    let status = Command::new("/usr/bin/open")
        .arg("-a")
        .arg(&app)
        .arg("--")
        .args(&paths)
        .status()
        .map_err(|e| format!("failed to launch {}: {e}", app_name(&app)))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{} couldn't open the selection", app_name(&app)))
    }
}

/// Open through Launch Services, where Gatekeeper checks quarantined files.
/// Return `NEEDS_RUN_CONFIRMATION` if the file runs (`runs_when_opened`) and `allow_run` is not set.
#[tauri::command(async)]
pub fn open_path(window: tauri::Window, path: String, allow_run: Option<bool>) -> Result<(), String> {
    open_default(path, allow_run.filter(|_| may_confirm(window.label())))
}

fn open_default(path: String, allow_run: Option<bool>) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_absolute() || !p.exists() {
        return Err(format!("\"{}\" isn't there", crate::fsops::label(p)));
    }
    if !allow_run.unwrap_or(false) && runs_when_opened(&path) {
        return Err(NEEDS_RUN_CONFIRMATION.to_string());
    }
    let status = Command::new("/usr/bin/open")
        .arg("--")
        .arg(&path)
        .status()
        .map_err(|e| format!("failed to open: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("\"{}\" couldn't be opened", crate::fsops::label(p)))
    }
}

/// Viewer windows never ask the user. Ignore `allow_run` from them.
fn may_confirm(window: &str) -> bool {
    window == "main" || window.starts_with("tab-")
}

/// Kinds that install or run when opened, whatever app is bound to them.
const RUNS_BY_KIND: [&str; 11] = [
    "pkg", "mpkg", "prefpane", "saver", "workflow", "action", "shortcut", "mobileconfig",
    "terminal", "command", "tool",
];

/// Kinds a document link never opens, in addition to `RUNS_BY_KIND`. Keep in sync with `NEVER_OPEN` in Reader.tsx.
const NEVER_FROM_LINK: [&str; 4] = ["app", "fileloc", "webloc", "inetloc"];

/// Like `open_path`, but refuse anything that can start a program.
/// A symlink is judged and opened by its target. The reader window may call only this.
#[tauri::command(async)]
pub fn open_link_target(path: String) -> Result<(), String> {
    let label = crate::fsops::label(Path::new(&path));
    let real = std::fs::canonicalize(&path).map_err(|_| format!("\"{label}\" isn't there"))?;
    if launches_from_link(&real) {
        return Err(format!("Doftar doesn't run programs from a document: \"{label}\""));
    }
    open_default(real.to_string_lossy().into_owned(), Some(false))
}

fn launches_from_link(p: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(p) else {
        return true;
    };
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    meta.file_type().is_symlink()
        || NEVER_FROM_LINK.contains(&ext.as_str())
        || RUNS_BY_KIND.contains(&ext.as_str())
        || (meta.is_dir() && crate::fsops::is_package_dir(p, &ext))
        || crate::alias::is_alias_file(p)
        || p.to_str().is_none_or(runs_when_opened)
}

/// Apps that run their input. Terminals are in `TERMINALS`.
const LAUNCHERS: [&str; 2] = ["Python Launcher", "Jar Launcher"];

/// True if the default app runs `path`. A file with no default app runs if it is executable.
fn runs_when_opened(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if RUNS_BY_KIND.contains(&ext.as_str()) {
        return true;
    }
    match default_app(path) {
        Some(app) => is_runner(&app),
        None => is_executable_file(path),
    }
}

/// `open` runs a regular file that has an execute bit.
fn is_executable_file(path: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

pub fn check_terminal(app: &str) -> Result<(), String> {
    if TERMINALS.iter().any(|(_, name)| *name == app) || is_app_bundle(app) {
        Ok(())
    } else {
        Err(format!("\"{}\" isn't an application", app_name(app)))
    }
}

/// Opens Finder with `paths` selected.
#[tauri::command]
pub fn reveal_in_finder(paths: Vec<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::{NSArray, NSString, NSURL};
        let urls: Vec<_> = paths
            .iter()
            .map(|p| NSURL::fileURLWithPath(&NSString::from_str(p)))
            .collect();
        NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&NSArray::from_retained_slice(&urls));
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = paths;
        Err("Finder is only on macOS".into())
    }
}

#[tauri::command]
pub async fn runs_as_program(path: String) -> Result<bool, String> {
    crate::jobs::blocking(move || runs_when_opened(&path)).await
}

/// (bundle id, menu name). See fsops::open_terminal.
const TERMINALS: [(&str, &str); 6] = [
    ("com.apple.Terminal", "Terminal"),
    ("com.googlecode.iterm2", "iTerm2"),
    ("dev.warp.Warp-Stable", "Warp"),
    ("com.mitchellh.ghostty", "Ghostty"),
    ("com.github.wez.wezterm", "WezTerm"),
    ("be.zenjoy.zentty", "Zentty"),
];

/// Editors named from their bundle, so a rebrand shows the name in Finder.
const EDITORS: [&str; 10] = [
    "com.microsoft.VSCode",
    "com.microsoft.VSCodeInsiders",
    "com.todesktop.230313mzl4w4u92", // Cursor
    "dev.zed.Zed",
    "dev.zed.Zed-Preview",
    "com.exafunction.windsurf", // Windsurf
    "com.google.antigravity",
    "com.sublimetext.4",
    "com.panic.Nova",
    "com.barebones.bbedit",
];

#[cfg(target_os = "macos")]
fn bundle_path(id: &str) -> Option<String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::NSString;

    let url = NSWorkspace::sharedWorkspace()
        .URLForApplicationWithBundleIdentifier(&NSString::from_str(id))?;
    Some(url.path()?.to_string())
}

#[cfg(not(target_os = "macos"))]
fn bundle_path(_id: &str) -> Option<String> {
    None
}

fn installed_terminals() -> Vec<AppInfo> {
    TERMINALS
        .iter()
        .filter_map(|(id, name)| {
            Some(AppInfo {
                name: name.to_string(),
                path: bundle_path(id)?,
                is_default: false,
            })
        })
        .collect()
}

fn installed_editors() -> Vec<AppInfo> {
    EDITORS
        .iter()
        .filter_map(|id| {
            let path = bundle_path(id)?;
            Some(AppInfo {
                name: app_name(&path),
                path,
                is_default: false,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn terminal_apps() -> Result<Vec<AppInfo>, String> {
    crate::jobs::blocking(installed_terminals).await
}

#[tauri::command]
pub async fn editor_apps() -> Result<Vec<AppInfo>, String> {
    crate::jobs::blocking(installed_editors).await
}

#[tauri::command]
pub async fn pick_application() -> Result<Option<String>, String> {
    crate::jobs::blocking(pick_application_sync).await?
}

fn pick_application_sync() -> Result<Option<String>, String> {
    let script = r#"POSIX path of (choose file of type {"com.apple.application-bundle"} with prompt "Choose an application" default location (path to applications folder))"#;
    let out = Command::new("/usr/bin/osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(None);
    }
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((!p.is_empty()).then(|| p.trim_end_matches('/').to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_sorts_first_then_by_name() {
        let app = |n: &str, d: bool| AppInfo {
            name: n.into(),
            path: format!("/Applications/{n}.app"),
            is_default: d,
        };
        let mut v = vec![app("zed", false), app("Preview", true), app("atom", false)];
        v.reverse();
        sort_apps(&mut v);
        let names: Vec<_> = v.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["Preview", "atom", "zed"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn scripts_run_and_documents_do_not() {
        let base = std::env::temp_dir().join(format!("wf-runs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let script = base.join("hello.command");
        let note = base.join("note.txt");
        std::fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
        std::fs::write(&note, "hi").unwrap();
        let program = base.join("tool");
        std::fs::write(&program, "#!/bin/sh\necho hi\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(runs_when_opened(&script.to_string_lossy()));
        assert!(runs_when_opened(&program.to_string_lossy()));
        for kind in ["pkg", "workflow", "mobileconfig"] {
            let f = base.join(format!("x.{kind}"));
            std::fs::write(&f, "").unwrap();
            assert!(runs_when_opened(&f.to_string_lossy()), "{kind}");
        }
        assert!(!runs_when_opened(&note.to_string_lossy()));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finds_the_built_in_terminal() {
        let found = installed_terminals();
        assert_eq!(found.first().map(|t| t.name.as_str()), Some("Terminal"));
        assert!(found.iter().all(|t| t.path.ends_with(".app")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn text_files_have_apps() {
        let apps = apps_for("/etc/hosts");
        assert!(!apps.is_empty());
        assert!(apps.iter().all(|a| a.path.ends_with(".app")));
    }
}
