//! Opening a terminal and running a command in it.

use super::*;

#[tauri::command(async)]
pub fn open_terminal(path: String, app: Option<String>) -> Result<(), String> {
    let p = Path::new(&path);
    let dir = if p.is_dir() {
        p.to_path_buf()
    } else {
        p.parent()
            .map(|x| x.to_path_buf())
            .unwrap_or_else(|| p.to_path_buf())
    };
    // `app` is a bundle path. Without it, use Terminal.
    // Accept only a known terminal name or a real bundle.
    let app = app.unwrap_or_else(|| "Terminal".to_string());
    crate::openwith::check_terminal(&app)?;
    let name = Path::new(&app)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| app.clone());
    if name.eq_ignore_ascii_case("wezterm") {
        // WezTerm needs the folder on its command line.
        // Only the launcher can send it, from outside the sandbox.
        return crate::launcher::run(&format!(
            "exec /usr/bin/open -na {} --args start --cwd {}",
            shell_quote(&app),
            shell_quote(&dir.to_string_lossy())
        ));
    }
    let status = std::process::Command::new("/usr/bin/open")
        .args(["-a", &app, "--"])
        .arg(&dir)
        .status()
        .map_err(|e| format!("failed to launch {name}: {e}"))?;
    if !status.success() {
        return Err(format!("{name} couldn't open \"{}\"", label(&dir)));
    }
    Ok(())
}

/// `ran` is true when the terminal took the command.
/// Otherwise the terminal only opened in the folder, and `reason` says why.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunOutcome {
    pub ran: bool,
    pub reason: Option<String>,
}

/// Runs `command` in a new window of the terminal `app`, in the folder `dir`.
/// Terminal uses a `.command` file, iTerm2 AppleScript, Warp a launch configuration,
/// Ghostty and WezTerm their command lines. The shell stays open.
/// Zentty and other apps only open in the folder. The result says so.
///
/// All but Warp use the launcher applet (launcher.rs). From the sandbox,
/// LaunchServices drops the arguments. A child terminal inherits the sandbox,
/// and a shell cannot live in it.
#[tauri::command(async)]
pub fn run_in_terminal(dir: String, command: String, app: Option<String>) -> Result<RunOutcome, String> {
    let dir_path = Path::new(&dir);
    if !dir_path.is_absolute() || !dir_path.is_dir() {
        return Err(format!("\"{}\" isn't a folder", label(dir_path)));
    }
    let command = command.trim();
    if command.is_empty() {
        return Err("nothing to run".into());
    }
    let app = app.unwrap_or_else(|| "Terminal".to_string());
    crate::openwith::check_terminal(&app)?;
    let name = Path::new(&app)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| app.clone());
    let line = format!("cd {} && {command}", shell_quote(&dir));
    let keep_open = format!("{line}; exec /bin/zsh -il");
    let kind = name.to_ascii_lowercase();
    let attempt: Result<(), String> = match kind.as_str() {
        "terminal" => command_file(&line).and_then(|file| {
            crate::launcher::run(&format!(
                "exec /usr/bin/open -a {} {}",
                shell_quote(&app),
                shell_quote(&file.to_string_lossy())
            ))
        }),
        "iterm2" | "iterm" => {
            let script = format!(
                "tell application \"{name}\"\nactivate\nset w to (create window with default profile)\ntell current session of w to write text \"{}\"\nend tell",
                applescript_quote(&line)
            );
            crate::launcher::run(&format!("exec /usr/bin/osascript -e {}", shell_quote(&script)))
        }
        k if k.starts_with("warp") => warp_launch(&dir, command, &app),
        // An option before -e is ignored. The shell does the cd.
        "ghostty" => crate::launcher::run(&format!(
            "exec /usr/bin/open -na {} --args -e /bin/zsh -lc {}",
            shell_quote(&app),
            shell_quote(&keep_open)
        )),
        "wezterm" => crate::launcher::run(&format!(
            "exec /usr/bin/open -na {} --args start --cwd {} -- /bin/zsh -lc {}",
            shell_quote(&app),
            shell_quote(&dir),
            shell_quote(&keep_open)
        )),
        _ => Err(format!("{name} can't be handed a command")),
    };
    match attempt {
        Ok(()) => Ok(RunOutcome { ran: true, reason: None }),
        Err(reason) => {
            open_terminal(dir, Some(app))?;
            Ok(RunOutcome { ran: false, reason: Some(reason) })
        }
    }
}

/// Makes a script for Terminal to open. It runs `line`, then leaves an interactive shell.
/// It deletes itself on start.
pub(super) fn command_file(line: &str) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let root = crate::thumbs::cache_root().ok_or("no cache folder")?.join("run");
    fs::create_dir_all(&root).map_err(strerr)?;
    crate::cache::make_private(&root);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file = root.join(format!("run-{stamp}.command"));
    fs::write(&file, format!("#!/bin/zsh -il\nrm -f -- \"$0\"\n{line}\nexec /bin/zsh -il\n")).map_err(strerr)?;
    fs::set_permissions(&file, fs::Permissions::from_mode(0o700)).map_err(strerr)?;
    Ok(file)
}

pub(super) fn warp_launch(dir: &str, command: &str, app: &str) -> Result<(), String> {
    let folder = dirs::home_dir()
        .ok_or("no home folder")?
        .join(".warp/launch_configurations");
    std::fs::create_dir_all(&folder).map_err(strerr)?;
    let yaml = format!(
        "---\nname: doftar-run\nwindows:\n  - tabs:\n      - title: {}\n        layout:\n          cwd: {}\n          commands:\n            - exec: {}\n",
        yaml_str(command),
        yaml_str(dir),
        yaml_str(command)
    );
    std::fs::write(folder.join("doftar-run.yaml"), yaml).map_err(strerr)?;
    let status = std::process::Command::new("/usr/bin/open")
        .arg("-a")
        .arg(app)
        .arg("warp://launch/doftar-run")
        .status()
        .map_err(strerr)?;
    if status.success() {
        Ok(())
    } else {
        Err("Warp didn't open the launch configuration".into())
    }
}

/// JSON escapes, newlines included, are valid YAML escapes.
pub(super) fn yaml_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

