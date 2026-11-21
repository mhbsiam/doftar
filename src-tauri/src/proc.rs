//! Subprocesses that must not hang. Desktop tools (gio, umount, xdg-*) are trusted to
//! exit, but a wedged mount or a missing session bus would park a job thread or the UI
//! forever, so the callers here run under a kill timeout.

use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// Runs `cmd` capturing its output, killing it after `limit`. A kill shows up as a
/// non-zero status, so the usual success checks see the failure. Spawn errors still
/// return Err, so a missing binary keeps reporting itself.
pub(crate) fn run(cmd: &mut Command, limit: Duration) -> std::io::Result<Output> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let start = Instant::now();
    // Drain the pipes on threads while polling: a chatty child must not fill a pipe
    // buffer and deadlock against our wait.
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out_t = std::thread::spawn(move || {
        let mut s = stdout;
        let mut v = Vec::new();
        let _ = s.read_to_end(&mut v);
        v
    });
    let err_t = std::thread::spawn(move || {
        let mut s = stderr;
        let mut v = Vec::new();
        let _ = s.read_to_end(&mut v);
        v
    });
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Output {
                status,
                stdout: out_t.join().unwrap_or_default(),
                stderr: err_t.join().unwrap_or_default(),
            });
        }
        if start.elapsed() >= limit {
            let _ = child.kill();
            let status = child.wait()?;
            return Ok(Output {
                status,
                stdout: out_t.join().unwrap_or_default(),
                stderr: err_t.join().unwrap_or_default(),
            });
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
