//! Finder tags. An item's tags live in the `_kMDItemUserTags` extended
//! attribute, a binary plist of "Name\n<colour>" strings, oldest first.
//! Finder also mirrors the newest colour into the label bits of the item's
//! Finder info; a folder listing gets those for free, so they decide which
//! items are worth the (slow, ~20µs) attribute read.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub name: String,
    /// Finder's label colour: 0 none, 1 gray, 2 green, 3 purple, 4 blue,
    /// 5 yellow, 6 red, 7 orange.
    pub color: u8,
}

/// Finder's names for the label colours, by number.
const LABEL_NAMES: [&str; 8] = ["", "Gray", "Green", "Purple", "Blue", "Yellow", "Red", "Orange"];

/// The label colour (0 for none) in an item's 32-byte Finder info.
pub fn label_of(finder: &[u8]) -> u8 {
    finder.get(9).map_or(0, |b| (b >> 1) & 7)
}

pub fn parse(bytes: &[u8]) -> Vec<Tag> {
    let Ok(plist::Value::Array(items)) = plist::Value::from_reader(std::io::Cursor::new(bytes))
    else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|v| v.as_string())
        .map(|s| {
            let (name, color) = s.split_once('\n').unwrap_or((s, "0"));
            Tag {
                name: name.to_string(),
                color: color.trim().parse::<u8>().unwrap_or(0).min(7),
            }
        })
        .filter(|t| !t.name.is_empty())
        .collect()
}

fn encode(tags: &[Tag]) -> Vec<u8> {
    let items = tags
        .iter()
        .map(|t| plist::Value::String(format!("{}\n{}", t.name, t.color)))
        .collect();
    let mut out = Vec::new();
    // Writing a plist into memory can't fail.
    let _ = plist::Value::Array(items).to_writer_binary(&mut out);
    out
}

/// The tags Finder shows for an item whose Finder info carries `label`:
/// an item with no label is taken to have none, so most of a listing skips
/// the attribute read. A label with no tags attribute (set by an old tool)
/// reads as that colour's tag, as Finder shows it.
pub fn read_labelled(path: &Path, label: u8) -> Vec<Tag> {
    if label == 0 {
        return Vec::new();
    }
    let tags = read(path);
    if !tags.is_empty() {
        return tags;
    }
    vec![Tag { name: LABEL_NAMES[label as usize].to_string(), color: label }]
}

#[cfg(target_os = "macos")]
mod sys {
    use std::ffi::{CStr, CString};
    use std::io;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    pub const TAGS: &CStr = c"com.apple.metadata:_kMDItemUserTags";
    pub const FINDER_INFO: &CStr = c"com.apple.FinderInfo";

    pub fn c_path(path: &Path) -> io::Result<CString> {
        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
    }

    /// The attribute's value; `Ok(None)` when the item doesn't have it.
    pub fn get(p: &CStr, name: &CStr) -> io::Result<Option<Vec<u8>>> {
        let mut buf = vec![0u8; 4096];
        for _ in 0..3 {
            // SAFETY: valid C strings and a buffer of the length given.
            let n = unsafe {
                libc::getxattr(
                    p.as_ptr(),
                    name.as_ptr(),
                    buf.as_mut_ptr().cast(),
                    buf.len(),
                    0,
                    libc::XATTR_NOFOLLOW,
                )
            };
            if n >= 0 {
                buf.truncate(n as usize);
                return Ok(Some(buf));
            }
            let err = io::Error::last_os_error();
            match err.raw_os_error() {
                Some(libc::ENOATTR) => return Ok(None),
                Some(libc::ERANGE) => {
                    // SAFETY: a null buffer asks for the value's size.
                    let need = unsafe {
                        libc::getxattr(
                            p.as_ptr(),
                            name.as_ptr(),
                            std::ptr::null_mut(),
                            0,
                            0,
                            libc::XATTR_NOFOLLOW,
                        )
                    };
                    if need < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    buf.resize(need as usize, 0);
                }
                _ => return Err(err),
            }
        }
        Err(io::Error::from(io::ErrorKind::Other))
    }

    pub fn set(p: &CStr, name: &CStr, value: &[u8]) -> io::Result<()> {
        // SAFETY: valid C strings and a value of the length given.
        let rc = unsafe {
            libc::setxattr(
                p.as_ptr(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
                libc::XATTR_NOFOLLOW,
            )
        };
        if rc == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
    }

    pub fn remove(p: &CStr, name: &CStr) -> io::Result<()> {
        // SAFETY: valid C strings.
        let rc = unsafe { libc::removexattr(p.as_ptr(), name.as_ptr(), libc::XATTR_NOFOLLOW) };
        if rc == 0 {
            return Ok(());
        }
        let err = io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::ENOATTR) { Ok(()) } else { Err(err) }
    }
}

/// Every tag on the item, read from its attribute.
#[cfg(target_os = "macos")]
pub fn read(path: &Path) -> Vec<Tag> {
    let Ok(p) = sys::c_path(path) else { return Vec::new() };
    match sys::get(&p, sys::TAGS) {
        Ok(Some(bytes)) => parse(&bytes),
        _ => Vec::new(),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn read(_path: &Path) -> Vec<Tag> {
    Vec::new()
}

/// Replaces the item's tags, and points its Finder label at the newest
/// coloured one, as Finder does (otherwise Finder keeps showing a removed
/// colour from the label).
#[cfg(target_os = "macos")]
fn write(path: &Path, tags: &[Tag]) -> std::io::Result<()> {
    let p = sys::c_path(path)?;
    if tags.is_empty() {
        sys::remove(&p, sys::TAGS)?;
    } else {
        sys::set(&p, sys::TAGS, &encode(tags))?;
    }
    let label = tags.iter().rev().find(|t| t.color > 0).map_or(0, |t| t.color);
    let mut info = match sys::get(&p, sys::FINDER_INFO) {
        Ok(Some(v)) if v.len() == 32 => v,
        _ => vec![0u8; 32],
    };
    let next = (info[9] & !0x0E) | (label << 1);
    if next != info[9] {
        info[9] = next;
        // The label is a courtesy for older tools; the tags are what count.
        let _ = if info.iter().all(|&b| b == 0) {
            sys::remove(&p, sys::FINDER_INFO)
        } else {
            sys::set(&p, sys::FINDER_INFO, &info)
        };
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn write(_path: &Path, _tags: &[Tag]) -> std::io::Result<()> {
    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
}

fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// `tags` with `add` appended (unless already there) and `remove` dropped;
/// Finder treats tag names without regard to case. An item has at most one
/// colour: a coloured tag replaces any other coloured one, while tags
/// without a colour stay.
fn edited(mut tags: Vec<Tag>, add: Option<&Tag>, remove: Option<&str>) -> Vec<Tag> {
    if let Some(name) = remove {
        tags.retain(|t| !same_name(&t.name, name));
    }
    if let Some(tag) = add {
        if tag.color > 0 {
            tags.retain(|t| t.color == 0 || same_name(&t.name, &tag.name));
        }
        if !tags.iter().any(|t| same_name(&t.name, &tag.name)) {
            tags.push(tag.clone());
        }
    }
    tags
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagEdit {
    /// Each item's tags after the edit, by path.
    pub tags: HashMap<String, Vec<Tag>>,
    pub errors: Vec<String>,
}

/// Adds a tag to, or removes one from, each item.
#[tauri::command]
pub async fn edit_tags(
    paths: Vec<String>,
    add: Option<Tag>,
    remove: Option<String>,
) -> Result<TagEdit, String> {
    crate::jobs::blocking(move || {
        let mut out = TagEdit { tags: HashMap::new(), errors: Vec::new() };
        for path in paths {
            let p = Path::new(&path);
            let before = read(p);
            let after = edited(before.clone(), add.as_ref(), remove.as_deref());
            if after != before {
                if let Err(e) = write(p, &after) {
                    out.errors.push(format!("\"{}\": {e}", crate::fsops::label(p)));
                    out.tags.insert(path, before);
                    continue;
                }
            }
            remember(&path, &after);
            out.tags.insert(path, after);
        }
        out
    })
    .await
}

/// Tags read by `scan_tags`, with the change time they were read at: an
/// attribute write bumps the change time, so an unchanged one means the
/// tags are too and the slow read can be skipped.
fn cache() -> &'static Mutex<HashMap<String, ((i64, i64), Vec<Tag>)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, ((i64, i64), Vec<Tag>)>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

const CACHE_MAX: usize = 200_000;

fn ctime_of(path: &Path) -> Option<(i64, i64)> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(path).ok()?;
    Some((m.ctime(), m.ctime_nsec()))
}

fn remember(path: &str, tags: &[Tag]) {
    let Some(ctime) = ctime_of(Path::new(path)) else { return };
    let mut c = cache().lock().unwrap();
    if c.len() >= CACHE_MAX {
        c.clear();
    }
    c.insert(path.to_string(), (ctime, tags.to_vec()));
}

/// Every item's full set of tags, by path, for the items that have any.
/// A listing only reads tags for items with a Finder label; this catches
/// tags without a colour, which leave no label.
#[tauri::command]
pub async fn scan_tags(paths: Vec<String>) -> Result<HashMap<String, Vec<Tag>>, String> {
    crate::jobs::blocking(move || {
        let mut found = HashMap::new();
        for path in paths {
            let Some(ctime) = ctime_of(Path::new(&path)) else { continue };
            let hit = cache()
                .lock()
                .unwrap()
                .get(&path)
                .filter(|(t, _)| *t == ctime)
                .map(|(_, tags)| tags.clone());
            let tags = match hit {
                Some(tags) => tags,
                None => {
                    let tags = read(Path::new(&path));
                    let mut c = cache().lock().unwrap();
                    if c.len() >= CACHE_MAX {
                        c.clear();
                    }
                    c.insert(path.clone(), (ctime, tags.clone()));
                    tags
                }
            };
            if !tags.is_empty() {
                found.insert(path, tags);
            }
        }
        found
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(name: &str, color: u8) -> Tag {
        Tag { name: name.into(), color }
    }

    #[test]
    fn parses_finder_tags() {
        let value = plist::Value::Array(vec![
            plist::Value::String("Red\n6".into()),
            plist::Value::String("Work".into()),
        ]);
        let mut bytes = Vec::new();
        plist::to_writer_binary(&mut bytes, &value).unwrap();
        assert_eq!(
            parse(&bytes),
            vec![
                Tag { name: "Red".into(), color: 6 },
                Tag { name: "Work".into(), color: 0 },
            ]
        );
        assert!(parse(b"junk").is_empty());
    }

    #[test]
    fn encode_round_trips() {
        let tags = vec![tag("Red", 6), tag("Work", 0)];
        assert_eq!(parse(&encode(&tags)), tags);
    }

    #[test]
    fn label_comes_from_finder_flags() {
        let mut info = [0u8; 32];
        info[9] = 0x04; // green, as Finder writes it
        assert_eq!(label_of(&info), 2);
        info[9] = 0x0C | 0x01;
        assert_eq!(label_of(&info), 6);
    }

    #[test]
    fn edits_ignore_case_and_keep_order() {
        let tags = vec![tag("Red", 6), tag("Work", 0)];
        assert_eq!(edited(tags.clone(), Some(&tag("work", 0)), None), tags);
        assert_eq!(
            edited(tags.clone(), Some(&tag("Home", 0)), None),
            vec![tag("Red", 6), tag("Work", 0), tag("Home", 0)]
        );
        assert_eq!(edited(tags, None, Some("RED")), vec![tag("Work", 0)]);
    }

    #[test]
    fn a_colour_replaces_the_previous_colour() {
        let tags = vec![tag("Red", 6), tag("Work", 0), tag("Taxes", 3)];
        assert_eq!(
            edited(tags.clone(), Some(&tag("Blue", 4)), None),
            vec![tag("Work", 0), tag("Blue", 4)]
        );
        assert_eq!(edited(tags.clone(), Some(&tag("red", 6)), None), vec![tag("Red", 6), tag("Work", 0)]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn write_sets_tags_and_label() {
        let dir = std::env::temp_dir().join(format!("wf-tags-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.txt");
        std::fs::write(&f, "x").unwrap();
        write(&f, &[tag("Red", 6), tag("Work", 0)]).unwrap();
        assert_eq!(read(&f), vec![tag("Red", 6), tag("Work", 0)]);
        let p = sys::c_path(&f).unwrap();
        let info = sys::get(&p, sys::FINDER_INFO).unwrap().unwrap();
        assert_eq!(label_of(&info), 6);
        write(&f, &[]).unwrap();
        assert!(read(&f).is_empty());
        assert!(sys::get(&p, sys::FINDER_INFO).unwrap().is_none(), "an all-zero Finder info is dropped");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
