use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardFiles {
    pub paths: Vec<String>,
    pub change_count: i64,
}

#[cfg(target_os = "macos")]
mod mac {
    use super::PasteboardFiles;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypeString, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};

    pub fn change_count() -> i64 {
        NSPasteboard::generalPasteboard().changeCount() as i64
    }

    pub fn write(paths: &[String]) -> i64 {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        let urls: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = paths
            .iter()
            .map(|p| ProtocolObject::from_retained(NSURL::fileURLWithPath(&NSString::from_str(p))))
            .collect();
        pb.writeObjects(&NSArray::from_retained_slice(&urls));
        pb.changeCount() as i64
    }

    pub fn write_text(text: &str) -> bool {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        pb.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString })
    }

    pub fn paths(pb: &NSPasteboard) -> Vec<String> {
        let mut paths = Vec::new();
        if let Some(items) = pb.pasteboardItems() {
            for item in items.iter() {
                let Some(text) = item.stringForType(unsafe { NSPasteboardTypeFileURL }) else {
                    continue;
                };
                let Some(url) = NSURL::URLWithString(&text) else {
                    continue;
                };
                let url = url.filePathURL().unwrap_or(url);
                if let Some(path) = url.path() {
                    paths.push(path.to_string());
                }
            }
        }
        paths
    }

    pub fn read() -> PasteboardFiles {
        let pb = NSPasteboard::generalPasteboard();
        PasteboardFiles {
            paths: paths(&pb),
            change_count: pb.changeCount() as i64,
        }
    }

    pub fn clear() {
        NSPasteboard::generalPasteboard().clearContents();
    }

    /// The image or text on the pasteboard, when it holds no files.
    pub fn data() -> Option<super::Pasted> {
        use objc2_app_kit::{NSPasteboardTypePNG, NSPasteboardTypeTIFF};
        let pb = NSPasteboard::generalPasteboard();
        // Refuse before copying it out. `save_pasted` checks again and words the error.
        let fits = |d: &objc2_foundation::NSData| d.length() <= super::PASTE_LIMIT;
        if let Some(d) = pb.dataForType(unsafe { NSPasteboardTypePNG }).filter(|d| fits(d)) {
            return Some(super::Pasted { bytes: d.to_vec(), base: "Pasted Image", ext: ".png" });
        }
        // shortcut: an image offered only as TIFF is saved as TIFF. Convert with ImageIO if people ask for PNG.
        if let Some(d) = pb.dataForType(unsafe { NSPasteboardTypeTIFF }).filter(|d| fits(d)) {
            return Some(super::Pasted { bytes: d.to_vec(), base: "Pasted Image", ext: ".tiff" });
        }
        let text = pb.stringForType(unsafe { NSPasteboardTypeString })?.to_string();
        (!text.is_empty()).then(|| super::Pasted { bytes: text.into_bytes(), base: "Pasted Text", ext: ".txt" })
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    use super::PasteboardFiles;
    pub fn change_count() -> i64 {
        0
    }
    pub fn write(_: &[String]) -> i64 {
        0
    }
    pub fn write_text(_: &str) -> bool {
        false
    }
    pub fn read() -> PasteboardFiles {
        PasteboardFiles {
            paths: Vec::new(),
            change_count: 0,
        }
    }
    pub fn clear() {}
    pub fn data() -> Option<super::Pasted> {
        None
    }
}

/// The files on a pasteboard other than the clipboard, such as the one a service is handed.
#[cfg(target_os = "macos")]
pub use mac::paths as pasteboard_paths;

pub fn write_text(text: &str) -> bool {
    mac::write_text(text)
}

#[tauri::command]
pub fn clipboard_write_files(paths: Vec<String>) -> i64 {
    mac::write(&paths)
}

#[tauri::command]
pub fn clipboard_read_files() -> PasteboardFiles {
    mac::read()
}

#[tauri::command]
pub fn clipboard_change_count() -> i64 {
    mac::change_count()
}

#[tauri::command]
pub fn clipboard_clear() {
    mac::clear()
}

pub struct Pasted {
    bytes: Vec<u8>,
    base: &'static str,
    ext: &'static str,
}

/// More than this is not a clipboard paste. It would also sit in memory twice.
const PASTE_LIMIT: usize = 200 << 20;

/// Writes `what` to a new file in `dest`. Never replaces a file. Returns the step that undoes it.
fn save_pasted(dest: &std::path::Path, what: &Pasted, stamp: &str) -> Result<crate::jobs::Step, String> {
    use std::io::Write;
    if what.bytes.len() > PASTE_LIMIT {
        return Err("The clipboard holds more than 200 MB. Save it from the app it came from.".to_string());
    }
    // The stamp comes from the interface. Keep it a plain part of a name.
    let stamp: String = stamp.chars().filter(|c| c.is_ascii_alphanumeric() || " .-".contains(*c)).take(40).collect();
    let base = format!("{} {}", what.base, stamp.trim());
    let full = dest.join(crate::fsops::unique_name(dest, base.trim(), what.ext));
    crate::guard::check(&full)?;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&full).map_err(|e| e.to_string())?;
    f.write_all(&what.bytes).map_err(|e| e.to_string())?;
    Ok(crate::jobs::Step::trash(crate::fsops::path_str(&full)))
}

/// Saves the image or text on the clipboard as a file in `dest`. `None` when it holds neither.
#[tauri::command]
pub async fn clipboard_paste_data(dest: String, stamp: String) -> Result<Option<crate::jobs::Step>, String> {
    // AppKit reads the pasteboard on any thread.
    crate::jobs::blocking(move || match mac::data() {
        Some(what) => save_pasted(std::path::Path::new(&dest), &what, &stamp).map(Some),
        None => Ok(None),
    })
    .await?
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn pasted_data_gets_a_new_name_and_never_replaces_a_file() {
        let dir = std::env::temp_dir().join(format!("wf-paste-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let what = Pasted { bytes: b"hello".to_vec(), base: "Pasted Text", ext: ".txt" };
        let a = save_pasted(&dir, &what, "2026-11-09 at 14.03/../x").unwrap();
        let b = save_pasted(&dir, &what, "2026-11-09 at 14.03/../x").unwrap();
        let (crate::jobs::Step::Trash { path: a, .. }, crate::jobs::Step::Trash { path: b, .. }) = (a, b) else {
            panic!("a paste is undone by trashing the file");
        };
        assert_ne!(a, b);
        for p in [&a, &b] {
            assert_eq!(std::path::Path::new(p).parent().unwrap(), dir, "the stamp must not leave the folder");
            assert_eq!(std::fs::read_to_string(p).unwrap(), "hello");
        }
        assert!(a.ends_with("Pasted Text 2026-11-09 at 14.03..x.txt"), "{a}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[ignore]
    fn pasteboard_round_trips_file_urls() {
        let dir = std::env::temp_dir().join(format!("wf-pb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a b.txt");
        let b = dir.join("é.txt");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        let paths = vec![
            a.canonicalize().unwrap().to_string_lossy().to_string(),
            b.canonicalize().unwrap().to_string_lossy().to_string(),
        ];
        let count = clipboard_write_files(paths.clone());
        let read = clipboard_read_files();
        use std::os::unix::fs::MetadataExt;
        assert_eq!(read.paths.len(), paths.len());
        for (got, want) in read.paths.iter().zip(&paths) {
            assert_eq!(
                std::fs::metadata(got).unwrap().ino(),
                std::fs::metadata(want).unwrap().ino()
            );
        }
        assert_eq!(read.change_count, count);
        clipboard_clear();
        assert!(clipboard_read_files().paths.is_empty());
        assert!(clipboard_change_count() > count);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
