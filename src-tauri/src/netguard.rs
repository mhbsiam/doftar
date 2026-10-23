//! Keeps Doftar off the network at the kernel's level, not just by policy.
//!
//! Doftar has no networking code, and the webview's content security policy
//! stops the interface from reaching out. This closes the remaining gap: the
//! Rust process (and every tool it spawns, such as `sips`, `mdfind`, `ditto`
//! and `tar`) is placed in a Seatbelt sandbox that refuses every IP socket,
//! inbound or outbound. Mach and Unix-socket IPC stay open, so Spotlight,
//! Launch Services, Disk Arbitration and the authorization prompt keep
//! working, and apps launched through `open` start from launchd and are not
//! affected. WebKit's own helper processes are separate XPC services; the
//! content security policy covers those.
//!
//! `sandbox_init` has been marked deprecated since OS X 10.8 and still ships
//! and works through macOS 26; Chromium and others rely on it the same way.

#[cfg(target_os = "macos")]
const PROFILE: &str = r#"(version 1)
(allow default)
(deny network-outbound (remote ip "*:*"))
(deny network-inbound (local ip "*:*"))
(deny network-bind (local ip "*:*"))
"#;

#[cfg(target_os = "macos")]
extern "C" {
    fn sandbox_init(
        profile: *const std::ffi::c_char,
        flags: u64,
        errorbuf: *mut *mut std::ffi::c_char,
    ) -> std::ffi::c_int;
    fn sandbox_free_error(errorbuf: *mut std::ffi::c_char);
}

/// Applies the no-network profile to this process. Call it first thing in
/// `main`, before any thread or window exists. Returns what went wrong when
/// the kernel refused the profile; the app then still runs, without the
/// guarantee, and says so on stderr.
#[cfg(target_os = "macos")]
pub fn install() -> Result<(), String> {
    use std::ffi::{CStr, CString};
    let profile = CString::new(PROFILE).map_err(|e| e.to_string())?;
    let mut err: *mut std::ffi::c_char = std::ptr::null_mut();
    let rc = unsafe { sandbox_init(profile.as_ptr(), 0, &mut err) };
    if rc == 0 {
        return Ok(());
    }
    let msg = if err.is_null() {
        format!("sandbox_init returned {rc}")
    } else {
        let m = unsafe { CStr::from_ptr(err) }.to_string_lossy().into_owned();
        unsafe { sandbox_free_error(err) };
        m
    };
    Err(msg)
}

#[cfg(not(target_os = "macos"))]
pub fn install() -> Result<(), String> {
    Err("no network guard on this platform".into())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};
    use std::process::Command;

    /// Runs the profile in a child process (the sandbox is per process and
    /// can't be removed again), then checks sockets are refused and the
    /// tools Doftar relies on still run.
    #[test]
    fn profile_blocks_ip_sockets_and_keeps_tools_working() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let script = format!(
            r#"
            /usr/bin/python3 -c "import socket;socket.create_connection(('127.0.0.1',{port}),timeout=2)" 2>/dev/null && echo CONNECTED
            /usr/bin/python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0))" 2>/dev/null && echo BOUND
            /usr/bin/mdutil -s / >/dev/null && echo MDUTIL
            /usr/bin/sips --version >/dev/null 2>&1 && echo SIPS
            /usr/bin/osascript -e 'POSIX path of (path to applications folder)' >/dev/null && echo OSASCRIPT
            /usr/sbin/diskutil list >/dev/null && echo DISKUTIL
            "#
        );
        let out = Command::new("/usr/bin/sandbox-exec")
            .args(["-p", PROFILE, "/bin/sh", "-c", &script])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(!text.contains("CONNECTED"), "outbound socket got through: {text}");
        assert!(!text.contains("BOUND"), "bind got through: {text}");
        for tool in ["MDUTIL", "SIPS", "OSASCRIPT", "DISKUTIL"] {
            assert!(text.contains(tool), "{tool} stopped working under the profile: {text}");
        }
        // Outside the sandbox the same port is reachable, so the test is real.
        assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
    }
}
