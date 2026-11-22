//! Filenames on Linux are bytes, but everything crossing the webview bridge is
//! a UTF-8 string. A name that is not UTF-8 would arrive as a lossy `�` and
//! every operation on it would fail with ENOENT. Each non-UTF-8 byte maps to a
//! private-use char (U+E000..U+E0FF) when a path goes out, and back to the same
//! byte when a path comes in. UTF-8 paths pass through unchanged.

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

const BASE: u32 = 0xE000;
const TOP: u32 = BASE + 256;

/// The path as a bridge string. Identity when it is already UTF-8.
pub fn encode(p: &Path) -> String {
    let b = p.as_os_str().as_bytes();
    if let Ok(s) = std::str::from_utf8(b) {
        return s.to_string();
    }
    let mut s = String::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match std::str::from_utf8(&b[i..]) {
            Ok(rest) => {
                s.push_str(rest);
                break;
            }
            Err(e) => {
                let v = e.valid_up_to();
                if v > 0 {
                    // SAFE: valid_up_to bytes are valid UTF-8.
                    s.push_str(unsafe { std::str::from_utf8_unchecked(&b[i..i + v]) });
                    i += v;
                }
                let l = e.error_len().unwrap_or(1).min(b.len() - i);
                for &x in &b[i..i + l] {
                    // U+E000 + u8 is always a valid char.
                    s.push(char::from_u32(BASE + x as u32).unwrap());
                }
                i += l;
            }
        }
    }
    s
}

fn decode(s: &str) -> PathBuf {
    // macOS file names are always UTF-8, so a private-use char there is a real one.
    if cfg!(target_os = "macos") || !s.chars().any(|c| (BASE..TOP).contains(&(c as u32))) {
        return PathBuf::from(s);
    }
    let mut b = Vec::with_capacity(s.len());
    let mut buf = [0u8; 4];
    for c in s.chars() {
        let u = c as u32;
        if (BASE..TOP).contains(&u) {
            b.push((u - BASE) as u8);
        } else {
            b.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
        }
    }
    PathBuf::from(OsStr::from_bytes(&b))
}

/// What `real` accepts: everything `Path::new` accepts, plus owned strings.
pub trait Real {
    fn into_path(self) -> PathBuf;
}
impl Real for &str {
    fn into_path(self) -> PathBuf {
        decode(self)
    }
}
impl Real for &&str {
    fn into_path(self) -> PathBuf {
        decode(self)
    }
}
impl Real for String {
    fn into_path(self) -> PathBuf {
        decode(&self)
    }
}
impl Real for &String {
    fn into_path(self) -> PathBuf {
        decode(self)
    }
}
impl Real for &Path {
    fn into_path(self) -> PathBuf {
        self.to_path_buf()
    }
}
impl Real for PathBuf {
    fn into_path(self) -> PathBuf {
        self
    }
}
impl Real for &PathBuf {
    fn into_path(self) -> PathBuf {
        self.clone()
    }
}
impl Real for &OsStr {
    fn into_path(self) -> PathBuf {
        PathBuf::from(self)
    }
}
impl Real for &OsString {
    fn into_path(self) -> PathBuf {
        PathBuf::from(self)
    }
}
impl Real for &&String {
    fn into_path(self) -> PathBuf {
        decode(self)
    }
}
impl Real for OsString {
    fn into_path(self) -> PathBuf {
        PathBuf::from(self)
    }
}

/// `Path::new` that undoes `encode` for paths arriving from the webview.
/// Harmless for any string without private-use chars.
pub fn real<T: Real>(arg: T) -> PathBuf {
    arg.into_path()
}
