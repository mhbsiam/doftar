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
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardWriting};
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

    pub fn read() -> PasteboardFiles {
        let pb = NSPasteboard::generalPasteboard();
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
        PasteboardFiles {
            paths,
            change_count: pb.changeCount() as i64,
        }
    }

    pub fn clear() {
        NSPasteboard::generalPasteboard().clearContents();
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
    pub fn read() -> PasteboardFiles {
        PasteboardFiles {
            paths: Vec::new(),
            change_count: 0,
        }
    }
    pub fn clear() {}
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

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
