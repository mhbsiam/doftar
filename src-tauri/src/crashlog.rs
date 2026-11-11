//! A local record of panics and interface errors. Nothing here sends it anywhere. It leaves the Mac only if the user copies it.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::panic;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Past this the log moves to `crash.log.1`, replacing the last one, so disk use stays bounded.
const MAX_LOG_BYTES: u64 = 1024 * 1024;
/// Pages are not trusted to send a sane length.
const MAX_UI_ERROR_BYTES: usize = 16 * 1024;
/// By entry, not by line: a backtrace alone can run past any line count and push out its own message.
const DIAGNOSTIC_ENTRIES: usize = 3;
const CRASH_REPORTS_SHOWN: usize = 5;
const ENTRY_MARK: &str = "=== ";

fn log_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("Library/Logs/Doftar/crash.log"))
}

/// Call early in `main`. Panics before this print to stderr only.
pub fn install() {
    if let Some(path) = log_path() {
        install_at(path);
    }
}

fn install_at(path: PathBuf) {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("unnamed");
        let backtrace = std::backtrace::Backtrace::force_capture();
        let _ = append(&path, &entry(&format!("panic on thread {name}"), &format!("{info}\n{backtrace}")));
        previous(info);
    }));
}

fn entry(kind: &str, body: &str) -> String {
    format!("{ENTRY_MARK}{} {kind}, Doftar {}\n{body}\n\n", now(), env!("CARGO_PKG_VERSION"))
}

fn now() -> String {
    let secs = unsafe { libc::time(std::ptr::null_mut()) };
    let mut t: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&secs, &mut t) }.is_null() {
        return secs.to_string();
    }
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        t.tm_year + 1900,
        t.tm_mon + 1,
        t.tm_mday,
        t.tm_hour,
        t.tm_min,
        t.tm_sec
    )
}

/// Runs inside the panic hook, so it must not panic.
fn append(path: &Path, text: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    if fs::metadata(path).is_ok_and(|m| m.len() >= MAX_LOG_BYTES) {
        // Another thread may have just moved it. The entry still gets written.
        let _ = fs::rename(path, path.with_extension("log.1"));
    }
    let mut file = OpenOptions::new().create(true).append(true).mode(0o600).open(path)?;
    file.write_all(text.as_bytes())
}

fn truncated(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Records an error the interface caught. Failing to write it is not worth a second error.
#[tauri::command]
pub async fn log_ui_error(kind: String, message: String) {
    let Some(path) = log_path() else { return };
    let _ = crate::jobs::blocking(move || {
        let kind = truncated(&kind, 64);
        append(&path, &entry(&format!("interface {kind}"), truncated(&message, MAX_UI_ERROR_BYTES)))
    })
    .await;
}

fn recent_entries(log: &str) -> &str {
    let start = log.rmatch_indices(ENTRY_MARK).nth(DIAGNOSTIC_ENTRIES - 1).map_or(0, |(i, _)| i);
    &log[start..]
}

fn macos_version() -> String {
    Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map_or_else(|| "unknown".to_string(), |out| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Reports macOS itself wrote for crashes a panic hook cannot see, such as a segfault in native code.
fn crash_reports(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("Doftar") && (n.ends_with(".ips") || n.ends_with(".crash")))
                .collect()
        })
        .unwrap_or_default();
    // The names carry the date, so the newest sort last.
    names.sort_unstable();
    names.reverse();
    names.truncate(CRASH_REPORTS_SHOWN);
    names
}

fn report(macos: &str, reports: &[String], log: &str, home: Option<&str>) -> String {
    let reports = if reports.is_empty() { "none".to_string() } else { reports.join(", ") };
    let recent = recent_entries(log).trim();
    let recent = if recent.is_empty() { "No errors recorded." } else { recent };
    let text = format!(
        "Doftar {}\nmacOS {macos} ({})\nmacOS crash reports: {reports}\n\nRecent errors:\n{recent}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::ARCH,
    );
    // Hides the account name, which paths in the log would otherwise show to whoever gets this.
    match home {
        Some(home) if !home.is_empty() => text.replace(home, "~"),
        _ => text,
    }
}

/// Help → Copy Diagnostic Info. Rust writes the pasteboard because WebKit refuses a page's copy without a click in that page, and a crashed page can't copy at all.
/// On the main thread, like the other pasteboard commands. The log is small and on this Mac.
#[tauri::command]
pub fn copy_diagnostics() -> Result<(), String> {
    let home = dirs::home_dir();
    let log = log_path().and_then(|p| fs::read(p).ok()).unwrap_or_default();
    let reports = home
        .as_ref()
        .map(|h| crash_reports(&h.join("Library/Logs/DiagnosticReports")))
        .unwrap_or_default();
    let text = report(
        &macos_version(),
        &reports,
        &String::from_utf8_lossy(&log),
        home.as_ref().and_then(|h| h.to_str()),
    );
    if crate::clipboard::write_text(&text) {
        Ok(())
    } else {
        Err("Couldn't copy diagnostic info".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("doftar-crashlog-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_panic_is_written_with_its_message_and_place() {
        let dir = scratch("panic");
        let path = dir.join("logs/crash.log");
        install_at(path.clone());
        let caught = std::thread::Builder::new()
            .name("doomed".to_string())
            .spawn(|| panic!("the disk fell off"))
            .unwrap()
            .join();
        drop(panic::take_hook());
        assert!(caught.is_err());
        // Other tests may panic on purpose while the hook is in, so look for this one, not for the only one.
        let log = fs::read_to_string(&path).unwrap();
        assert!(log.contains("panic on thread doomed"), "{log}");
        assert!(log.contains("the disk fell off"), "{log}");
        assert!(log.contains("crashlog.rs"), "{log}");
        assert!(log.starts_with(ENTRY_MARK), "{log}");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_full_log_rolls_over_and_keeps_one_old_copy() {
        let dir = scratch("roll");
        let path = dir.join("crash.log");
        fs::write(&path, vec![b'x'; MAX_LOG_BYTES as usize]).unwrap();
        append(&path, "new").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(fs::metadata(dir.join("crash.log.1")).unwrap().len(), MAX_LOG_BYTES);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_report_shows_the_last_entries_whole() {
        let log: String = (1..=5).map(|n| entry(&format!("panic {n}"), "line one\nline two")).collect();
        let shown = recent_entries(&log);
        assert!(!shown.contains("panic 2,"));
        for kept in ["panic 3,", "panic 4,", "panic 5,"] {
            assert!(shown.contains(kept), "{shown}");
        }
        assert!(shown.starts_with(ENTRY_MARK));
        assert_eq!(recent_entries("no marks yet"), "no marks yet");
    }

    #[test]
    fn a_report_hides_the_home_folder_and_says_when_it_is_empty() {
        let log = entry("panic", "panicked at /Users/someone/project/a.rs:1:1");
        let text = report("26.1", &["Doftar-1.ips".to_string()], &log, Some("/Users/someone"));
        assert!(!text.contains("/Users/someone"), "{text}");
        assert!(text.contains("~/project/a.rs"), "{text}");
        assert!(text.contains("macOS 26.1"), "{text}");
        assert!(text.contains("Doftar-1.ips"), "{text}");
        let empty = report("26.1", &[], "", None);
        assert!(empty.contains("No errors recorded."), "{empty}");
        assert!(empty.contains("crash reports: none"), "{empty}");
    }

    #[test]
    fn only_doftars_own_crash_reports_are_named_newest_first() {
        let dir = scratch("reports");
        for name in [
            "Doftar-2026-01-01-000000.ips",
            "Doftar-2026-03-01-000000.ips",
            "Doftar-2026-02-01-000000.crash",
            "Finder-2026-04-01-000000.ips",
            "Doftar-notes.txt",
        ] {
            fs::write(dir.join(name), "").unwrap();
        }
        assert_eq!(
            crash_reports(&dir),
            ["Doftar-2026-03-01-000000.ips", "Doftar-2026-02-01-000000.crash", "Doftar-2026-01-01-000000.ips"]
        );
        assert!(crash_reports(&dir.join("missing")).is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Ignored because it overwrites the real clipboard.
    #[test]
    #[ignore]
    fn diagnostics_reach_the_pasteboard_as_text() {
        copy_diagnostics().unwrap();
        let pasted = Command::new("/usr/bin/pbpaste").output().unwrap();
        let text = String::from_utf8_lossy(&pasted.stdout);
        assert!(text.starts_with("Doftar "), "{text}");
        assert!(text.contains("Recent errors:"), "{text}");
    }

    #[test]
    fn long_text_is_cut_on_a_character_boundary() {
        assert_eq!(truncated("héllo", 2), "h");
        assert_eq!(truncated("héllo", 3), "hé");
        assert_eq!(truncated("short", 99), "short");
    }
}
