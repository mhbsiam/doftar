//! Opening a terminal and running a command in it.

use super::*;

#[tauri::command(async)]
pub fn open_terminal(path: String, app: Option<String>) -> Result<(), String> {
    let p = crate::paths::real(&path);
    let dir = if p.is_dir() {
        p.to_path_buf()
    } else {
        p.parent()
            .map(|x| x.to_path_buf())
            .unwrap_or_else(|| p.to_path_buf())
    };
    let app = app.unwrap_or_else(|| "Terminal".to_string());
    #[cfg(not(target_os = "macos"))]
    return linux::open_terminal(&dir, &app);
    #[cfg(target_os = "macos")]
    crate::openwith::check_terminal(&app)?;
    let name = crate::paths::real(&app)
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
    let dir_path = crate::paths::real(&dir);
    if !dir_path.is_absolute() || !dir_path.is_dir() {
        return Err(format!("\"{}\" isn't a folder", label(&(dir_path))));
    }
    let command = command.trim();
    if command.is_empty() {
        return Err("nothing to run".into());
    }
    let app = app.unwrap_or_else(|| "Terminal".to_string());
    #[cfg(not(target_os = "macos"))]
    {
        return match linux::run(&(dir_path), &command, &app) {
            Ok(()) => Ok(RunOutcome { ran: true, reason: None }),
            Err(reason) => linux::open_terminal(&(dir_path), &app)
                .map(|()| RunOutcome { ran: false, reason: Some(reason) }),
        };
    }
    #[cfg(target_os = "macos")]
    crate::openwith::check_terminal(&app)?;
    let name = crate::paths::real(&app)
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


#[cfg(not(target_os = "macos"))]
mod linux {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// How a terminal opens a folder and runs a command. `dir_args` open a working directory;
    /// `run` builds the full argv for a command line.
    struct Term {
        bin: String,
        kind: &'static str,
    }

    /// A terminal kind from a .desktop id or binary name.
    fn kind_of(id: &str) -> &'static str {
        let k = id.to_ascii_lowercase();
        if k.contains("gnome.terminal") || k == "gnome-terminal" {
            "gnome"
        } else if k.contains("console") || k == "kgx" {
            "console"
        } else if k.contains("konsole") {
            "konsole"
        } else if k.contains("xfce4") {
            "xfce"
        } else if k.contains("alacritty") {
            "alacritty"
        } else if k.contains("kitty") {
            "kitty"
        } else if k.contains("ghostty") {
            "ghostty"
        } else if k.contains("wezterm") {
            "wezterm"
        } else if k.contains("tilix") {
            "tilix"
        } else if k.contains("mate-terminal") {
            "mate"
        } else {
            "xterm"
        }
    }

    /// First word of a desktop file's `Exec=`: the binary. An `env` prefix is skipped.
    fn exec_bin(desktop: &str) -> Option<String> {
        let line = crate::openwith::linux::exec_line(desktop)?;
        let mut words = line.split_whitespace();
        let mut w = words.next()?;
        if w == "env" {
            for t in words.by_ref() {
                if !t.contains('=') {
                    w = t;
                    break;
                }
            }
            if w == "env" {
                return None;
            }
        }
        Some(w.trim_matches('"').to_string())
    }

    /// Resolve the `app` argument to a terminal. `app` is a .desktop path, an id, a display
    /// name from `TERMINALS`, or empty for the system default (`x-terminal-emulator`).
    fn resolve(app: &str) -> Result<Term, String> {
        if app.ends_with(".desktop") {
            if let Some(bin) = exec_bin(app) {
                let id = crate::paths::real(app).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                return Ok(Term { bin, kind: kind_of(&id) });
            }
        }
        for (id, name) in crate::openwith::TERMINALS {
            if app == name || app == id {
                let bin = crate::openwith::linux::desktop_path(id)
                    .and_then(|p| exec_bin(&p))
                    .unwrap_or_else(|| id.to_string());
                return Ok(Term { bin, kind: kind_of(id) });
            }
        }
        // A bare name or an unknown desktop file: trust it as a binary.
        if crate::paths::real(app).is_absolute() && crate::paths::real(app).exists() || !app.contains('/') && which(app).is_some() {
            let stem = crate::paths::real(app).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| app.to_string());
            return Ok(Term { bin: app.to_string(), kind: kind_of(&stem) });
        }
        Ok(Term { bin: "x-terminal-emulator".into(), kind: "xterm" })
    }

    fn which(bin: &str) -> Option<PathBuf> {
        std::env::split_paths(&std::env::var_os("PATH")?)
            .map(|d| d.join(bin))
            .find(|p| p.is_file())
    }

    /// Single-quotes raw bytes for the shell, so a name that is not UTF-8 survives too.
    fn shell_quote(s: &std::ffi::OsStr) -> std::ffi::OsString {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};
        let mut out = vec![b'\''];
        for &b in s.as_bytes() {
            if b == b'\'' {
                out.extend_from_slice(b"'\\''");
            } else {
                out.push(b);
            }
        }
        out.push(b'\'');
        std::ffi::OsString::from_vec(out)
    }

    /// argv that opens a window in `dir`.
    fn open_argv(t: &Term, dir: &std::ffi::OsStr) -> (String, Vec<std::ffi::OsString>) {
        // The directory rides on args as raw bytes: a name that is not UTF-8 still opens.
        let wd = |prefix: &str| {
            let mut a = std::ffi::OsString::from(prefix);
            a.push(dir);
            a
        };
        let args = match t.kind {
            "gnome" | "console" | "xfce" | "mate" | "tilix" | "ghostty" => vec![wd("--working-directory=")],
            "konsole" => vec!["--workdir".into(), dir.to_owned()],
            "alacritty" => vec!["--working-directory".into(), dir.to_owned()],
            "kitty" => vec!["--directory".into(), dir.to_owned()],
            "wezterm" => vec!["start".into(), "--cwd".into(), dir.to_owned()],
            _ => Vec::new(), // xterm-style: the process cwd is the shell's cwd
        };
        (t.bin.clone(), args)
    }

    /// argv that runs `line` in `dir`, keeping the shell open afterwards.
    fn run_argv(t: &Term, dir: &std::ffi::OsStr, line: &std::ffi::OsStr) -> (String, Vec<std::ffi::OsString>) {
        let wd = |prefix: &str| {
            let mut a = std::ffi::OsString::from(prefix);
            a.push(dir);
            a
        };
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/bash".into());
        let mut keep = line.to_owned();
        keep.push(format!("; exec {shell} -il"));
        let args = match t.kind {
            "gnome" | "console" => vec![wd("--working-directory="), "--".into(), "bash".into(), "-c".into(), keep],
            "konsole" => vec!["--workdir".into(), dir.to_owned(), "-e".into(), "bash".into(), "-c".into(), keep],
            "xfce" | "mate" => vec![wd("--working-directory="), "-x".into(), "bash".into(), "-c".into(), keep],
            "alacritty" => vec!["--working-directory".into(), dir.to_owned(), "-e".into(), "bash".into(), "-c".into(), keep],
            "kitty" => vec!["--directory".into(), dir.to_owned(), "bash".into(), "-c".into(), keep],
            "ghostty" => vec![wd("--working-directory="), "-e".into(), "bash".into(), "-c".into(), keep],
            "wezterm" => vec!["start".into(), "--cwd".into(), dir.to_owned(), "--".into(), "bash".into(), "-c".into(), keep],
            "tilix" => {
                let mut c = std::ffi::OsString::from("bash -c ");
                c.push(shell_quote(&keep));
                vec![wd("--working-directory="), "-e".into(), c]
            }
            _ => vec!["-e".into(), "bash".into(), "-c".into(), keep], // xterm-style
        };
        (t.bin.clone(), args)
    }

    /// A terminal window left running after Doftar exits. The child is reaped on a
    /// throwaway thread: dropping it would leave one zombie per terminal until Doftar quits.
    fn spawn_detached(bin: &str, args: &[std::ffi::OsString], dir: &Path) -> Result<(), String> {
        let mut child = Command::new(bin)
            .args(args)
            .current_dir(dir)
            .stdin(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("couldn't start {bin}: {e}"))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }

    pub fn open_terminal(dir: &Path, app: &str) -> Result<(), String> {
        crate::openwith::check_terminal(app)?;
        let t = resolve(app)?;
        let (bin, args) = open_argv(&t, dir.as_os_str());
        spawn_detached(&bin, &args, dir)
    }

    pub fn run(dir: &Path, command: &str, app: &str) -> Result<(), String> {
        crate::openwith::check_terminal(app)?;
        let t = resolve(app)?;
        let mut line = std::ffi::OsString::from("cd ");
        line.push(shell_quote(dir.as_os_str()));
        line.push(" && ");
        line.push(command);
        let (bin, args) = run_argv(&t, dir.as_os_str(), &line);
        spawn_detached(&bin, &args, dir)
    }
}
