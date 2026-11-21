use serde::Serialize;
use std::path::Path;
#[cfg(target_os = "macos")]
use std::process::Command;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub path: String,
    pub is_default: bool,
}

fn app_name(path: &str) -> String {
    crate::paths::real(path)
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
fn apps_for(path: &str) -> Vec<AppInfo> {
    linux::apps_for(path)
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

#[cfg(target_os = "macos")]
pub fn is_app_bundle(app: &str) -> bool {
    let p = crate::paths::real(app);
    p.is_absolute()
        && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("app"))
        && p.join("Contents").join("Info.plist").is_file()
}

/// True for an app that runs its input: a terminal or a code launcher.
#[cfg(target_os = "macos")]
fn is_runner(app: &str) -> bool {
    LAUNCHERS.contains(&app_name(app).as_str()) || installed_terminals().iter().any(|t| t.path == app)
}

/// True for an app that runs its input: a terminal or a code launcher.
#[cfg(not(target_os = "macos"))]
fn is_runner(app: &str) -> bool {
    let id = app_name(app);
    TERMINALS.iter().any(|(tid, _)| *tid == id)
}

/// Return `NEEDS_RUN_CONFIRMATION` for a terminal or launcher unless `allow_run` is set.
/// The check is here, so a request that skips the UI prompt gets the same answer.
#[tauri::command(async)]
pub fn open_with(window: tauri::Window, paths: Vec<String>, app: String, allow_run: Option<bool>) -> Result<(), String> {
    let allow_run = allow_run.filter(|_| may_confirm(window.label()));
    #[cfg(target_os = "macos")]
    let is_app = is_app_bundle(&app);
    #[cfg(not(target_os = "macos"))]
    let is_app = app.ends_with(".desktop") && crate::paths::real(&app).is_file();
    if !is_app {
        return Err(format!("\"{}\" isn't an application", app_name(&app)));
    }
    if paths.is_empty() || paths.iter().any(|p| !crate::paths::real(p).is_absolute()) {
        return Err("nothing to open".to_string());
    }
    if !allow_run.unwrap_or(false) && is_runner(&app) {
        return Err(NEEDS_RUN_CONFIRMATION.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    return linux::open_with(&app, &paths);
    #[cfg(target_os = "macos")]
    {
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
}

/// Open through Launch Services, where Gatekeeper checks quarantined files.
/// Return `NEEDS_RUN_CONFIRMATION` if the file runs (`runs_when_opened`) and `allow_run` is not set.
#[tauri::command(async)]
pub fn open_path(window: tauri::Window, path: String, allow_run: Option<bool>) -> Result<(), String> {
    open_default(&crate::paths::real(&path), allow_run.filter(|_| may_confirm(window.label())))
}

/// Open with the default app. `path` is real; callers decode once at entry.
fn open_default(path: &Path, allow_run: Option<bool>) -> Result<(), String> {
    if !path.is_absolute() || !path.exists() {
        return Err(format!("\"{}\" isn't there", crate::fsops::label(path)));
    }
    if !allow_run.unwrap_or(false) && runs_when_opened(path) {
        return Err(NEEDS_RUN_CONFIRMATION.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    return linux::open_default(path);
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("/usr/bin/open")
            .arg("--")
            .arg(path)
            .status()
            .map_err(|e| format!("failed to open: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("\"{}\" couldn't be opened", crate::fsops::label(path)))
        }
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
    // Decode once: canonicalize, the launch check and the open all need the real bytes.
    let src = crate::paths::real(&path);
    let label = crate::fsops::label(&src);
    let real = std::fs::canonicalize(&src).map_err(|_| format!("\"{label}\" isn't there"))?;
    if launches_from_link(&real) {
        return Err(format!("Doftar doesn't run programs from a document: \"{label}\""));
    }
    open_default(&real, Some(false))
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
        || runs_when_opened(p)
}

/// Apps that run their input. Terminals are in `TERMINALS`.
#[cfg(target_os = "macos")]
const LAUNCHERS: [&str; 2] = ["Python Launcher", "Jar Launcher"];

/// True if the default app runs `path`. A file with no default app runs if it is executable.
/// `path` is real.
fn runs_when_opened(path: &Path) -> bool {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if RUNS_BY_KIND.contains(&ext.as_str()) {
        return true;
    }
    // default_app still takes the bridge string the frontend holds.
    match default_app(&crate::paths::encode(path)) {
        Some(app) => is_runner(&app),
        None => is_executable_file(path),
    }
}

/// `open` runs a regular file that has an execute bit. `path` is real.
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(target_os = "macos")]
pub fn check_terminal(app: &str) -> Result<(), String> {
    if TERMINALS.iter().any(|(_, name)| *name == app) || is_app_bundle(app) {
        Ok(())
    } else {
        Err(format!("\"{}\" isn't an application", app_name(app)))
    }
}

#[cfg(not(target_os = "macos"))]
pub fn check_terminal(app: &str) -> Result<(), String> {
    let id = app_name(app);
    if TERMINALS.iter().any(|(_, name)| *name == app || id == app)
        || (app.ends_with(".desktop") && crate::paths::real(app).is_file())
    {
        Ok(())
    } else {
        Err(format!("\"{}\" isn't an application", id))
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
        linux::reveal(&paths)
    }
}

#[tauri::command]
pub async fn runs_as_program(path: String) -> Result<bool, String> {
    crate::jobs::blocking(move || runs_when_opened(&crate::paths::real(&path))).await
}

/// (bundle id, menu name). See fsops::open_terminal.
#[cfg(target_os = "macos")]
const TERMINALS: [(&str, &str); 6] = [
    ("com.apple.Terminal", "Terminal"),
    ("com.googlecode.iterm2", "iTerm2"),
    ("dev.warp.Warp-Stable", "Warp"),
    ("com.mitchellh.ghostty", "Ghostty"),
    ("com.github.wez.wezterm", "WezTerm"),
    ("be.zenjoy.zentty", "Zentty"),
];

/// (.desktop id, menu name). Ids as installed under XDG applications folders.
#[cfg(not(target_os = "macos"))]
pub(crate) const TERMINALS: [(&str, &str); 16] = [
    ("org.gnome.Terminal", "Terminal"),
    ("gnome-terminal", "Terminal"),
    ("org.gnome.Console", "Console"),
    ("kgx", "Console"),
    ("org.kde.konsole", "Konsole"),
    ("konsole", "Konsole"),
    ("xfce4-terminal", "Xfce Terminal"),
    ("xterm", "XTerm"),
    ("uxterm", "UXTerm"),
    ("Alacritty", "Alacritty"),
    ("alacritty", "Alacritty"),
    ("kitty", "Kitty"),
    ("com.mitchellh.ghostty", "Ghostty"),
    ("org.wezfurlong.wezterm", "WezTerm"),
    ("com.gexperts.Tilix", "Tilix"),
    ("mate-terminal", "MATE Terminal"),
];

/// Editors named from their bundle, so a rebrand shows the name in Finder.
#[cfg(target_os = "macos")]
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

/// .desktop ids of editors, in preference order.
#[cfg(not(target_os = "macos"))]
const EDITORS: [&str; 14] = [
    "code",
    "code-insiders",
    "io.codium.codium",
    "com.visualstudio.code.oss",
    "cursor",
    "com.exafunction.windsurf",
    "dev.zed.Zed",
    "sublime_text",
    "org.gnome.gedit",
    "org.kde.kate",
    "nvim",
    "vim",
    "emacs",
    "io.neovim.nvim",
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
fn bundle_path(id: &str) -> Option<String> {
    linux::desktop_path(id)
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
            #[cfg(not(target_os = "macos"))]
            let name = linux::desktop_name(&path).unwrap_or_else(|| app_name(&path));
            #[cfg(target_os = "macos")]
            let name = app_name(&path);
            Some(AppInfo {
                name,
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

#[cfg(not(target_os = "macos"))]
pub(crate) mod linux {
    use super::{app_name, sort_apps, AppInfo};
    #[cfg(test)]
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// XDG applications folders, most-specific first.
    fn applications_dirs() -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        let data_home = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".local/share")));
        if let Some(d) = data_home {
            dirs.push(d.join("applications"));
        }
        for d in std::env::var("XDG_DATA_DIRS")
            .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string())
            .split(':')
            .filter(|s| !s.is_empty())
        {
            dirs.push(crate::paths::real(d).join("applications"));
        }
        dirs
    }

    /// A desktop id can sit in a subfolder of an applications dir. The layout is shallow.
    fn find_nested(dir: &Path, name: &str) -> Option<PathBuf> {
        let rd = std::fs::read_dir(dir).ok()?;
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                let found = p.join(name);
                if found.is_file() {
                    return Some(found);
                }
            }
        }
        None
    }

    /// Full path of a .desktop id like `org.gnome.Nautilus`. Encoded for the bridge.
    pub fn desktop_path(id: &str) -> Option<String> {
        let name = format!("{id}.desktop");
        for dir in applications_dirs() {
            let direct = dir.join(&name);
            if direct.is_file() {
                return Some(crate::paths::encode(&direct));
            }
            if let Some(found) = find_nested(&dir, &name) {
                return Some(crate::paths::encode(&found));
            }
        }
        None
    }

    /// A key's first value in the [Desktop Entry] group of a .desktop file.
    pub fn entry_value(path: &str, key: &str) -> Option<String> {
        // Desktop paths arrive as bridge strings; the file lives at the real bytes.
        let text = std::fs::read_to_string(crate::paths::real(path)).ok()?;
        let mut in_entry = false;
        for line in text.lines() {
            let t = line.trim_end();
            if t.starts_with('[') {
                in_entry = t == "[Desktop Entry]";
                continue;
            }
            if in_entry {
                if let Some(v) = t.strip_prefix(key).and_then(|r| r.strip_prefix('=')) {
                    return Some(v.trim().to_string());
                }
            }
        }
        None
    }

    /// First `Name=` of a desktop file.
    pub fn desktop_name(path: &str) -> Option<String> {
        entry_value(path, "Name")
    }

    fn flag(path: &str, key: &str) -> bool {
        entry_value(path, key).is_some_and(|v| v == "true")
    }

    /// The `Exec=` line of a desktop file, field codes and all.
    pub fn exec_line(path: &str) -> Option<String> {
        entry_value(path, "Exec")
    }

    fn which(bin: &str) -> Option<PathBuf> {
        let p = crate::paths::real(bin);
        if p.is_absolute() {
            return p.exists().then(|| p.to_path_buf());
        }
        std::env::split_paths(&std::env::var_os("PATH")?)
            .map(|d| d.join(bin))
            .find(|p| p.is_file())
    }

    /// MIME type of `path`, e.g. "text/plain".
    fn mime_of(path: &str) -> Option<String> {
        // Decode once: xdg-mime needs the real bytes, not bridge strings.
        let mut cmd = Command::new("xdg-mime");
        cmd.args(["query", "filetype"]).arg(crate::paths::real(path));
        let out = crate::proc::run(&mut cmd, std::time::Duration::from_secs(5)).ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout)
            .split([';', '\n'])
            .next()
            .map(|s| s.trim().to_string())
            .filter(|s| s.contains('/'))
    }

    /// Default .desktop id for `mime`, without the extension.
    fn default_id(mime: &str) -> Option<String> {
        let mut cmd = Command::new("xdg-mime");
        cmd.args(["query", "default", mime]);
        let out = crate::proc::run(&mut cmd, std::time::Duration::from_secs(5)).ok()?;
        let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
        id.ends_with(".desktop")
            .then(|| id.trim_end_matches(".desktop").to_string())
    }

    /// mimeapps.list files, most specific first: the user's config, the system config, then
    /// each applications dir. A binding in an earlier file wins, per the mimeapps spec.
    fn mimeapps_lists() -> Vec<PathBuf> {
        let mut lists = Vec::new();
        let config_home = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".config")));
        if let Some(d) = config_home {
            lists.push(d.join("mimeapps.list"));
        }
        for d in std::env::var("XDG_CONFIG_DIRS")
            .unwrap_or_else(|_| "/etc/xdg".to_string())
            .split(':')
            .filter(|s| !s.is_empty())
        {
            lists.push(crate::paths::real(d).join("mimeapps.list"));
        }
        for dir in applications_dirs() {
            lists.push(dir.join("mimeapps.list"));
        }
        lists
    }

    /// The binding values for `mime` under `[Added Associations]`. Other groups stay out.
    fn added_values(text: &str, mime: &str) -> Vec<String> {
        let mut values = Vec::new();
        let mut added = false;
        for line in text.lines() {
            let t = line.trim();
            if t.starts_with('[') {
                added = t == "[Added Associations]";
                continue;
            }
            if let Some((k, v)) = t.split_once('=').filter(|_| added) {
                if k.trim() == mime {
                    values.push(v.trim().to_string());
                }
            }
        }
        values
    }

    /// The binding values for `mime` in a mimeinfo.cache.
    fn cached_values(text: &str, mime: &str) -> Vec<String> {
        text.lines()
            .filter_map(|line| line.split_once('='))
            .filter(|(k, _)| k.trim() == mime)
            .map(|(_, v)| v.trim().to_string())
            .collect()
    }

    /// The desktop ids in a binding value, appended without duplicates. First occurrence wins.
    fn push_new(ids: &mut Vec<String>, value: &str) {
        for id in value.split(';').map(str::trim).filter(|s| s.ends_with(".desktop")) {
            let id = id.trim_end_matches(".desktop").to_string();
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }

    /// Desktop ids bound to `mime` in mimeinfo.cache and mimeapps.list. Config bindings land
    /// before data-dir ones.
    fn associated_ids(mime: &str) -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        // mimeinfo.cache only lives next to the desktop files.
        for dir in applications_dirs() {
            if let Ok(text) = std::fs::read_to_string(dir.join("mimeinfo.cache")) {
                for v in cached_values(&text, mime) {
                    push_new(&mut ids, &v);
                }
            }
        }
        for list in mimeapps_lists() {
            if let Ok(text) = std::fs::read_to_string(&list) {
                for v in added_values(&text, mime) {
                    push_new(&mut ids, &v);
                }
            }
        }
        ids
    }

    /// The app `id` names, unless it is hidden or its `TryExec` tool is missing.
    fn visible_app(id: &str) -> Option<AppInfo> {
        visible_app_at(&desktop_path(id)?)
    }

    /// Same, for a launcher path that is already encoded for the bridge.
    fn visible_app_at(path: &str) -> Option<AppInfo> {
        if flag(path, "NoDisplay") || flag(path, "Hidden") {
            return None;
        }
        // A launcher with nothing to run would only produce an error.
        entry_value(path, "Exec")?;
        if let Some(t) = entry_value(path, "TryExec") {
            let bin = t.split_whitespace().next().unwrap_or(&t);
            which(bin)?;
        }
        Some(AppInfo {
            name: desktop_name(path).unwrap_or_else(|| app_name(path)),
            path: path.to_string(),
            is_default: false,
        })
    }

    /// Every visible application across the applications folders, alphabetically.
    /// The "open with another app" chooser lists these.
    pub fn all_apps() -> Vec<AppInfo> {
        all_apps_in(&applications_dirs())
    }

    /// Every visible application across `dirs`, alphabetically. A more specific
    /// folder's file wins, so the first copy of an id seen is the one kept.
    fn all_apps_in(dirs: &[PathBuf]) -> Vec<AppInfo> {
        let mut seen = std::collections::HashSet::new();
        let mut apps: Vec<AppInfo> = Vec::new();
        for dir in dirs {
            let Ok(rd) = std::fs::read_dir(dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if !p.is_file() || !p.extension().is_some_and(|x| x.eq_ignore_ascii_case("desktop")) {
                    continue;
                }
                if !seen.insert(e.file_name()) {
                    continue;
                }
                if let Some(a) = visible_app_at(&crate::paths::encode(&p)) {
                    apps.push(a);
                }
            }
        }
        sort_apps(&mut apps);
        apps
    }

    /// Apps that open `path`, the default first. Mirrors `apps_for` on macOS.
    pub fn apps_for(path: &str) -> Vec<AppInfo> {
        let Some(mime) = mime_of(path) else {
            return Vec::new();
        };
        let default = default_id(&mime);
        let mut apps: Vec<AppInfo> = Vec::new();
        if let Some(d) = &default {
            if let Some(mut a) = visible_app(d) {
                a.is_default = true;
                apps.push(a);
            }
        }
        for id in associated_ids(&mime) {
            if Some(&id) == default.as_ref() {
                continue;
            }
            if let Some(a) = visible_app(&id) {
                if !apps.iter().any(|x| x.path == a.path) {
                    apps.push(a);
                }
            }
        }
        sort_apps(&mut apps);
        apps
    }

    /// `gio launch` passes each argument as a file or URI to the app in the desktop file.
    pub fn open_with(app: &str, paths: &[String]) -> Result<(), String> {
        // Decode once: gio needs the real bytes, not bridge strings.
        let mut cmd = Command::new("gio");
        cmd.arg("launch")
            .arg(crate::paths::real(app))
            .args(paths.iter().map(|p| crate::paths::real(p.as_str())));
        let out = crate::proc::run(&mut cmd, std::time::Duration::from_secs(10))
            .map_err(|e| format!("failed to launch {}: {e}", app_name(app)))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("{} couldn't open the selection", app_name(app)))
        }
    }

    /// xdg-open hands the file to its default app. It exits once the app took it.
    /// `path` is real.
    pub fn open_default(path: &Path) -> Result<(), String> {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(path);
        let out = crate::proc::run(&mut cmd, std::time::Duration::from_secs(10))
            .map_err(|e| format!("failed to open: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("\"{}\" couldn't be opened", crate::fsops::label(path)))
        }
    }

    /// Enough of RFC 3986 for a local file URI. Raw bytes, so a name that is not
    /// UTF-8 still percent-encodes to the same file.
    fn file_uri(p: &Path) -> String {
        let mut out = String::from("file://");
        for b in p.as_os_str().as_bytes() {
            if b.is_ascii_alphanumeric() || b"/-._~".contains(b) {
                out.push(*b as char);
            } else {
                out.push_str(&format!("%{b:02X}"));
            }
        }
        out
    }

    /// Select items in the system file manager through the freedesktop FileManager1 interface.
    /// Falls back to opening the containing folder when no file manager answers.
    pub fn reveal(paths: &[String]) -> Result<(), String> {
        // Decode once: canonicalize, the URIs and the fallback folder need the real bytes.
        let real: Vec<PathBuf> = paths.iter().map(|p| crate::paths::real(p.as_str())).collect();
        let uris: Vec<String> = real
            .iter()
            .filter_map(|p| std::fs::canonicalize(p).ok())
            .map(|p| file_uri(&p))
            .collect();
        if uris.is_empty() {
            return Err("nothing to show".into());
        }
        let mut cmd = Command::new("dbus-send");
        cmd.args([
            "--session",
            "--print-reply",
            "--dest=org.freedesktop.FileManager1",
            "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1.ShowItems",
            &format!("array:string:{}", uris.join(",")),
            "string:",
        ]);
        let ok = crate::proc::run(&mut cmd, std::time::Duration::from_secs(5))
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            return Ok(());
        }
        let parent = real
            .first()
            .and_then(|p| p.parent().map(|q| q.to_path_buf()))
            .ok_or("no file manager answered".to_string())?;
        open_default(&parent)
    }

    /// A file dialog rooted at the applications folders. `None` when it is cancelled or missing.
    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn reads_only_the_added_associations() {
            let text = "[Default Applications]\ntext/plain=hidden.desktop\n\
                        [Added Associations]\ntext/plain=code.desktop;nvim.desktop;\n\
                        other/mime=nothing.desktop\n";
            assert_eq!(added_values(text, "text/plain"), ["code.desktop;nvim.desktop;"]);
            assert_eq!(added_values(text, "other/mime"), ["nothing.desktop"]);
            assert_eq!(added_values(text, "text/html"), Vec::<String>::new());
        }

        #[test]
        fn config_bindings_come_before_the_data_dirs() {
            let mut ids = Vec::new();
            for table in [
                // The config file first, then the data dir's, as mimeapps_lists() orders them.
                "[Added Associations]\ntext/plain=code.desktop\n",
                "[Added Associations]\ntext/plain=gedit.desktop;code.desktop\n",
            ] {
                for v in added_values(table, "text/plain") {
                    push_new(&mut ids, &v);
                }
            }
            assert_eq!(ids, ["code", "gedit"], "the config's code wins over the data dir's");
        }

        #[test]
        fn reads_the_mime_cache() {
            let text = "text/plain=gedit.desktop;code.desktop\nother/x=nothing.desktop\n";
            assert_eq!(cached_values(text, "text/plain"), ["gedit.desktop;code.desktop"]);
        }

        /// The bridge strings of two twin files get the same answer: xdg-mime sees the
        /// real bytes of the non-UTF-8 name, not the private-use chars.
        #[test]
        fn mime_of_answers_the_same_for_a_non_utf8_name() {
            let dir = std::env::temp_dir().join(format!("wf-openwith-mime-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let odd = dir.join(OsStr::from_bytes(b"note_\xFF.txt"));
            let twin = dir.join("note.txt");
            std::fs::write(&odd, b"x").unwrap();
            std::fs::write(&twin, b"x").unwrap();
            // xdg-mime may be missing in a bare environment; either way the encoded
            // name must not fare worse than the twin's.
            assert_eq!(mime_of(&crate::paths::encode(&odd)), mime_of(&crate::paths::encode(&twin)));
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// `reveal` shapes its URIs from the raw bytes, not a lossy rendering.
        #[test]
        fn file_uri_percent_encodes_bytes_that_are_not_utf8() {
            let p = Path::new(OsStr::from_bytes(b"/tmp/a\xFF b~.txt"));
            assert_eq!(file_uri(p), "file:///tmp/a%FF%20b~.txt");
        }

        #[test]
        fn all_apps_lists_visible_launchers_only() {
            let dir = std::env::temp_dir().join(format!("wf-openwith-apps-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("good.desktop"),
                "[Desktop Entry]\nType=Application\nName=Good Tool\nExec=good %f\n",
            )
            .unwrap();
            std::fs::write(
                dir.join("plumbing.desktop"),
                "[Desktop Entry]\nType=Application\nName=Plumbing\nExec=x\nNoDisplay=true\n",
            )
            .unwrap();
            std::fs::write(
                dir.join("nolaunch.desktop"),
                "[Desktop Entry]\nType=Application\nName=No Launch\n",
            )
            .unwrap();

            let apps = all_apps_in(std::slice::from_ref(&dir));
            assert_eq!(apps.len(), 1, "{apps:?}");
            assert_eq!(apps[0].name, "Good Tool");
            assert!(apps[0].path.ends_with("good.desktop"));
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

/// Every installed application, for the "open with another app" chooser. Linux only:
/// the chooser is the port's stand-in for the macOS LaunchServices picker.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn all_apps() -> Result<Vec<AppInfo>, String> {
    crate::jobs::blocking(linux::all_apps).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

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
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(runs_when_opened(&script));
        assert!(runs_when_opened(&program));
        for kind in ["pkg", "workflow", "mobileconfig"] {
            let f = base.join(format!("x.{kind}"));
            std::fs::write(&f, "").unwrap();
            assert!(runs_when_opened(&f), "{kind}");
        }
        assert!(!runs_when_opened(&note));
        std::fs::remove_dir_all(&base).unwrap();
    }

    fn scratch(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("wf-openwith-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    /// A name holding a byte that is not UTF-8 still stats through `is_executable_file`,
    /// and its bridge string decodes back to the same file.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn executable_bit_survives_a_non_utf8_name() {
        let dir = scratch("exec");
        let p = dir.join(OsStr::from_bytes(b"tool_\xFF.sh"));
        std::fs::write(&p, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(crate::paths::real(crate::paths::encode(&p).as_str()), p);
        assert!(is_executable_file(&p));
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!is_executable_file(&p));
        let _ = std::fs::remove_dir_all(&dir);
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
