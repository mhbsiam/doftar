//! Start terminals outside the Doftar sandbox.
//!
//! Doftar runs under a Seatbelt profile (netguard.rs). Its child processes inherit it.
//! LaunchServices drops `open --args` arguments for a sandboxed caller, and gives Terminal no document to run.
//! A small applet made with `osacompile` runs a script file that Doftar wrote. The terminal and shell then run outside the sandbox.
//! The applet runs only scripts from the private Doftar folder. Other sandboxed apps cannot use it to escape.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const APP_NAME: &str = "Doftar Launcher.app";
const BUNDLE_ID: &str = "com.doftar.launcher";
/// Increase when the applet script changes. This remakes old applets.
const SCRIPT_VERSION: &str = "2";
const STALE: Duration = Duration::from_secs(60);

fn strerr<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn dir() -> Result<PathBuf, String> {
    private_dir(&crate::thumbs::cache_root().ok_or("no cache folder")?.join("launcher"))
}

/// Make `d` private. Refuse it if it or a parent folder is a symlink. Another process could then put scripts where the applet runs them.
fn private_dir(d: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(d).map_err(strerr)?;
    if fs::canonicalize(d).map_err(strerr)? != d {
        return Err("the launcher folder isn't where it should be".into());
    }
    crate::cache::make_private(d);
    Ok(d.to_path_buf())
}

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub fn applescript_quote(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

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
    // osacompile signed the applet before this edit and broke its seal. macOS refuses Apple events from an applet with a broken seal.
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

/// Returns when the applet is asked, not when the script ends.
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
    fn a_symlinked_launcher_folder_is_refused() {
        let base = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("doftar-launcher-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("elsewhere")).unwrap();
        assert!(private_dir(&base.join("real")).is_ok());
        std::os::unix::fs::symlink(base.join("elsewhere"), base.join("link")).unwrap();
        assert!(private_dir(&base.join("link")).is_err());
        assert!(private_dir(&base.join("link/inner")).is_err());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn applet_only_runs_scripts_from_its_folder() {
        let s = source(Path::new("/tmp/x"));
        assert!(s.contains("if p starts with \"/tmp/x/\" then"));
        assert!(s.contains("do shell script \"/bin/sh \" & quoted form of p"));
    }
}
