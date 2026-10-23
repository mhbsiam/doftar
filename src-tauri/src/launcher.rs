//! A helper that starts terminals outside Doftar's sandbox.
//!
//! Doftar runs under a Seatbelt profile (netguard.rs) and everything it
//! spawns inherits it. LaunchServices starts apps unsandboxed, but for a
//! sandboxed caller it drops the arguments given with `open --args`, won't
//! hand Terminal a document to run, and launchd takes no jobs from one. It
//! does hand any other app a document. So a small applet, made here with the
//! system's `osacompile`, takes a script file Doftar wrote and runs it, which
//! puts the terminal and the shell inside it outside the sandbox, where a
//! shell belongs. The applet only runs scripts from Doftar's own private
//! folder, so no other sandboxed app can use it as a way out of its own.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const APP_NAME: &str = "Doftar Launcher.app";
const BUNDLE_ID: &str = "com.doftar.launcher";
/// Bump when the applet's script changes, so an older applet is remade.
const SCRIPT_VERSION: &str = "2";
/// Request scripts older than this were never picked up; they are swept.
const STALE: Duration = Duration::from_secs(60);

fn strerr<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// The private folder holding the applet and its request scripts.
fn dir() -> Result<PathBuf, String> {
    let d = crate::thumbs::cache_root()
        .ok_or("no cache folder")?
        .join("launcher");
    fs::create_dir_all(&d).map_err(strerr)?;
    crate::cache::make_private(&d);
    Ok(d)
}

/// `s` as one word for zsh or bash.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `s` inside an AppleScript string literal.
pub fn applescript_quote(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// The applet's source: run each file handed to it, if it lies in `dir`.
fn source(dir: &Path) -> String {
    let prefix = applescript_quote(&format!("{}/", dir.display()));
    format!(
        "-- Doftar Launcher v{SCRIPT_VERSION}: runs a script Doftar wrote, outside its sandbox.\n\
         on open theFiles\n\
         \trepeat with f in theFiles\n\
         \t\tset p to POSIX path of f\n\
         \t\tif p starts with \"{prefix}\" then\n\
         \t\t\tdo shell script \"/bin/sh \" & quoted form of p\n\
         \t\tend if\n\
         \tend repeat\n\
         end open\n\
         on run\n\
         end run\n"
    )
}

/// The applet, made or remade when missing or out of date.
fn applet(dir: &Path) -> Result<PathBuf, String> {
    let app = dir.join(APP_NAME);
    let src = dir.join("launcher.applescript");
    let wanted = source(dir);
    if app.join("Contents/Info.plist").exists()
        && fs::read_to_string(&src).map(|s| s == wanted).unwrap_or(false)
    {
        return Ok(app);
    }
    let _ = fs::remove_dir_all(&app);
    fs::write(&src, &wanted).map_err(strerr)?;
    let out = Command::new("/usr/bin/osacompile")
        .arg("-o")
        .arg(&app)
        .arg(&src)
        .output()
        .map_err(|e| format!("couldn't make the launcher: {e}"))?;
    if !out.status.success() {
        let _ = fs::remove_file(&src);
        return Err(format!(
            "couldn't make the launcher: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    // Stays out of the Dock and says why it may script a terminal.
    let info = app.join("Contents/Info.plist");
    let mut value = plist::Value::from_file(&info).map_err(strerr)?;
    if let Some(d) = value.as_dictionary_mut() {
        d.insert("LSUIElement".into(), plist::Value::Boolean(true));
        d.insert("CFBundleIdentifier".into(), plist::Value::String(BUNDLE_ID.into()));
        d.insert("CFBundleName".into(), plist::Value::String("Doftar Launcher".into()));
        d.insert(
            "NSAppleEventsUsageDescription".into(),
            plist::Value::String(
                "Doftar Launcher asks a terminal to run a command typed in Doftar's address bar."
                    .into(),
            ),
        );
    }
    plist::to_file_xml(&info, &value).map_err(strerr)?;
    // osacompile signed the applet before that edit, which broke its seal;
    // with a broken seal macOS refuses its Apple events without asking.
    let out = Command::new("/usr/bin/codesign")
        .args(["-s", "-", "-f", "--deep"])
        .arg(&app)
        .output()
        .map_err(|e| format!("couldn't sign the launcher: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "couldn't sign the launcher: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(app)
}

/// Runs `body` as a `/bin/sh` script outside the sandbox, through the
/// applet. Returns once the applet has been asked, not once the script ran.
pub fn run(body: &str) -> Result<(), String> {
    let dir = dir()?;
    let app = applet(&dir)?;
    sweep(&dir);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file = dir.join(format!("run-{stamp}.sh"));
    fs::write(&file, format!("#!/bin/sh\nrm -f -- \"$0\"\n{body}\n")).map_err(strerr)?;
    fs::set_permissions(&file, fs::Permissions::from_mode(0o700)).map_err(strerr)?;
    let status = Command::new("/usr/bin/open")
        .arg("-a")
        .arg(&app)
        .arg(&file)
        .status()
        .map_err(|e| format!("couldn't start the launcher: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        let _ = fs::remove_file(&file);
        Err("the launcher didn't start".into())
    }
}

/// Drops request scripts that were never run.
fn sweep(dir: &Path) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("run-") || !name.ends_with(".sh") {
            continue;
        }
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|age| age > STALE)
            .unwrap_or(true);
        if old {
            let _ = fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_words_keep_quotes() {
        assert_eq!(shell_quote("/Users/me/it's here"), "'/Users/me/it'\\''s here'");
    }

    #[test]
    fn applescript_strings_keep_quotes_and_backslashes() {
        assert_eq!(applescript_quote(r#"say "hi" \ bye"#), r#"say \"hi\" \\ bye"#);
    }

    #[test]
    fn applet_only_runs_scripts_from_its_folder() {
        let s = source(Path::new("/tmp/x"));
        assert!(s.contains("if p starts with \"/tmp/x/\" then"));
        assert!(s.contains("do shell script \"/bin/sh \" & quoted form of p"));
    }
}
