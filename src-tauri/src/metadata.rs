//! Everything a file says about itself, for Properties: the ImageIO dictionaries of an image (EXIF, GPS, TIFF, IPTC, maker notes) and every Spotlight attribute.

use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetaGroup {
    pub title: String,
    pub rows: Vec<MetaRow>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetaRow {
    pub label: String,
    pub text: String,
    /// Set for a date, so the UI writes it in the user's date format.
    pub date_ms: Option<u64>,
}

#[tauri::command(async)]
pub fn item_metadata(path: String) -> Vec<MetaGroup> {
    let mut groups = Vec::new();
    #[cfg(target_os = "macos")]
    {
        // Reading the header of an iCloud or Box placeholder would download it.
        let local = std::fs::metadata(&path).is_ok_and(|m| m.is_file() && !crate::thumbs::is_dataless(&m));
        if let Some(plist::Value::Dictionary(d)) = local.then(|| mac::image_props(&path)).flatten() {
            groups.extend(image_groups(&d));
        }
        if let Some(plist::Value::Dictionary(d)) = mac::spotlight(&path) {
            let mut rows = Vec::new();
            flatten_dict("", &d, &mut rows);
            if !rows.is_empty() {
                groups.push(MetaGroup { title: "Spotlight".into(), rows });
            }
        }
    }
    groups
}

/// A field is absent if the file has none, or if Spotlight does not index the volume.
#[derive(Serialize, Debug, Default, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration_s: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f32>,
    pub codec: Option<String>,
    pub camera: Option<String>,
}

const VIDEO_EXTS: [&str; 10] = ["mov", "mp4", "m4v", "mkv", "avi", "webm", "mxf", "mts", "m2ts", "mpg"];

#[tauri::command(async)]
pub fn media_info(paths: Vec<String>) -> Vec<Option<MediaInfo>> {
    paths.iter().map(|p| media_info_of(p)).collect()
}

#[cfg(not(target_os = "macos"))]
fn media_info_of(_path: &str) -> Option<MediaInfo> {
    None
}

#[cfg(target_os = "macos")]
fn media_info_of(path: &str) -> Option<MediaInfo> {
    let mut info = mac::spotlight(path)
        .and_then(|v| match v {
            plist::Value::Dictionary(d) => Some(d),
            _ => None,
        })
        .map(|d| spotlight_media(&d))
        .unwrap_or_default();
    let ext = std::path::Path::new(path).extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
    if ext.is_some_and(|e| VIDEO_EXTS.contains(&e.as_str())) {
        // Spotlight never records the frame rate and knows nothing on an unindexed card or RAID. The video track fills the gaps.
        if let Some((secs, fps, w, h)) = mac::video_track(path) {
            info.fps = Some(fps);
            info.width.get_or_insert(w);
            info.height.get_or_insert(h);
            if let Some(secs) = secs {
                info.duration_s.get_or_insert(secs);
            }
        }
    }
    (info != MediaInfo::default()).then_some(info)
}

fn spotlight_media(d: &plist::Dictionary) -> MediaInfo {
    let num = |k: &str| d.get(k).and_then(|v| v.as_real().or_else(|| v.as_signed_integer().map(|i| i as f64)));
    let text = |k: &str| d.get(k).and_then(|v| v.as_string()).filter(|s| !s.trim().is_empty()).map(str::to_owned);
    let codecs = d.get("kMDItemCodecs").and_then(|v| v.as_array()).map(|items| {
        items.iter().filter_map(|i| i.as_string()).collect::<Vec<_>>().join(", ")
    });
    let camera = match (text("kMDItemAcquisitionMake"), text("kMDItemAcquisitionModel")) {
        (Some(make), Some(model)) if model.starts_with(&make) => Some(model),
        (Some(make), Some(model)) => Some(format!("{make} {model}")),
        (make, model) => model.or(make),
    };
    MediaInfo {
        duration_s: num("kMDItemDurationSeconds"),
        width: num("kMDItemPixelWidth").map(|n| n as u32),
        height: num("kMDItemPixelHeight").map(|n| n as u32),
        fps: None,
        codec: codecs.filter(|c| !c.is_empty()),
        camera,
    }
}

fn image_groups(d: &plist::Dictionary) -> Vec<MetaGroup> {
    let mut top = Vec::new();
    let mut subs = Vec::new();
    for (k, v) in sorted(d) {
        match v {
            plist::Value::Dictionary(sub) => {
                let mut rows = Vec::new();
                flatten_dict("", sub, &mut rows);
                if !rows.is_empty() {
                    subs.push(MetaGroup { title: label_of(k), rows });
                }
            }
            _ => flatten(label_of(k), v, &mut top),
        }
    }
    let mut out = Vec::new();
    if !top.is_empty() {
        out.push(MetaGroup { title: "Image".into(), rows: top });
    }
    out.extend(subs);
    out
}

fn sorted(d: &plist::Dictionary) -> Vec<(&String, &plist::Value)> {
    let mut kv: Vec<_> = d.iter().collect();
    kv.sort_by_key(|(k, _)| label_of(k).to_lowercase());
    kv
}

fn flatten_dict(prefix: &str, d: &plist::Dictionary, rows: &mut Vec<MetaRow>) {
    for (k, v) in sorted(d) {
        let label = if prefix.is_empty() { label_of(k) } else { format!("{prefix} › {}", label_of(k)) };
        flatten(label, v, rows);
    }
}

fn flatten(label: String, v: &plist::Value, rows: &mut Vec<MetaRow>) {
    use plist::Value;
    match v {
        Value::Dictionary(d) => flatten_dict(&label, d, rows),
        Value::Array(items) if items.iter().any(|i| matches!(i, Value::Dictionary(_) | Value::Array(_))) => {
            for (n, item) in items.iter().enumerate() {
                flatten(format!("{label} {}", n + 1), item, rows);
            }
        }
        Value::Array(items) if items.is_empty() => {}
        Value::Array(items) => {
            let text = items.iter().map(scalar_text).collect::<Vec<_>>().join(", ");
            rows.push(MetaRow { label, text, date_ms: None });
        }
        Value::Date(d) => {
            let ms = std::time::SystemTime::from(*d)
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .ok();
            rows.push(MetaRow { label, text: d.to_xml_format(), date_ms: ms });
        }
        _ => rows.push(MetaRow { label, text: scalar_text(v), date_ms: None }),
    }
}

fn scalar_text(v: &plist::Value) -> String {
    use plist::Value;
    match v {
        Value::String(s) => s.clone(),
        Value::Boolean(b) => if *b { "Yes" } else { "No" }.into(),
        Value::Integer(i) => i.to_string(),
        Value::Real(r) if r.fract() == 0.0 && r.abs() < 1e15 => format!("{}", *r as i64),
        Value::Real(r) => format!("{}", (r * 1e6).round() / 1e6),
        Value::Date(d) => d.to_xml_format(),
        Value::Data(b) => format!("{} bytes", b.len()),
        Value::Uid(u) => u.get().to_string(),
        _ => String::new(),
    }
}

/// `kMDItemAudioBitRate` becomes "Audio Bit Rate". `{Exif}` becomes "Exif".
fn label_of(key: &str) -> String {
    let k = key.trim_start_matches('_');
    let k = k.strip_prefix("kMDItem").unwrap_or(k);
    let k: Vec<char> = k.trim_matches(|c| c == '{' || c == '}').chars().collect();
    let mut out = String::new();
    for (i, &c) in k.iter().enumerate() {
        if c == '_' {
            out.push(' ');
            continue;
        }
        let prev = i.checked_sub(1).map(|j| k[j]);
        let next = k.get(i + 1).copied();
        let breaks = c.is_uppercase()
            && prev.is_some_and(|p| p.is_lowercase() || p.is_ascii_digit() || (p.is_uppercase() && next.is_some_and(char::is_lowercase)));
        if breaks && !out.ends_with(' ') {
            out.push(' ');
        }
        out.push(c);
    }
    out.trim().to_string()
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2_core_foundation::{
        CFArray, CFData, CFDictionary, CFPropertyListCreateData, CFPropertyListFormat, CFRetained,
        CFString, CFType, CFURLPathStyle, CFURL,
    };
    use objc2_image_io::CGImageSource;
    use std::ffi::c_void;
    use std::ptr::NonNull;

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn MDItemCreateWithURL(alloc: *const c_void, url: &CFURL) -> Option<NonNull<CFType>>;
        fn MDItemCopyAttributeNames(item: &CFType) -> Option<NonNull<CFArray>>;
        fn MDItemCopyAttributes(item: &CFType, names: &CFArray) -> Option<NonNull<CFDictionary>>;
    }

    fn url(path: &str) -> Option<CFRetained<CFURL>> {
        let s = CFString::from_str(path);
        CFURL::with_file_system_path(None, Some(&s), CFURLPathStyle::CFURLPOSIXPathStyle, false)
    }

    fn to_plist(v: &CFType) -> Option<plist::Value> {
        // SAFETY: CF accepts a null error pointer.
        let data: CFRetained<CFData> = unsafe {
            CFPropertyListCreateData(None, Some(v), CFPropertyListFormat::BinaryFormat_v1_0, 0, std::ptr::null_mut())
        }?;
        plist::Value::from_reader(std::io::Cursor::new(data.to_vec())).ok()
    }

    pub fn image_props(path: &str) -> Option<plist::Value> {
        // SAFETY: a valid URL. ImageIO reads only the header for properties.
        let src = unsafe { CGImageSource::with_url(&*url(path)?, None) }?;
        let props = unsafe { src.properties_at_index(0, None) }?;
        to_plist(&props)
    }

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CMTime {
        value: i64,
        timescale: i32,
        flags: u32,
        epoch: i64,
    }
    // SAFETY: matches the CMTime layout and its `{?=qiIq}` encoding.
    unsafe impl objc2::encode::Encode for CMTime {
        const ENCODING: objc2::encode::Encoding = objc2::encode::Encoding::Struct(
            "?",
            &[
                objc2::encode::Encoding::LongLong,
                objc2::encode::Encoding::Int,
                objc2::encode::Encoding::UInt,
                objc2::encode::Encoding::LongLong,
            ],
        );
    }

    /// AVFoundation reads these, so they work on volumes that Spotlight does not index.
    pub fn video_track(path: &str) -> Option<(Option<f64>, f32, u32, u32)> {
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use objc2_foundation::{NSArray, NSSize, NSString, NSURL};
        // SAFETY: AVURLAsset and AVAssetTrack messages with documented signatures. The asset loads its tracks synchronously on this thread.
        unsafe {
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            let asset: Option<Retained<AnyObject>> =
                msg_send![class!(AVURLAsset), URLAssetWithURL: &*url, options: std::ptr::null::<AnyObject>()];
            let asset = asset?;
            let tracks: Option<Retained<NSArray<AnyObject>>> =
                msg_send![&*asset, tracksWithMediaType: &*NSString::from_str("vide")];
            let track = tracks?.firstObject()?;
            let fps: f32 = msg_send![&*track, nominalFrameRate];
            let size: NSSize = msg_send![&*track, naturalSize];
            let t: CMTime = msg_send![&*asset, duration];
            // Flag 1 is kCMTimeFlags_Valid.
            let secs = (t.flags & 1 == 1 && t.timescale > 0).then(|| t.value as f64 / t.timescale as f64);
            (fps > 0.0).then(|| (secs, fps, size.width.abs().round() as u32, size.height.abs().round() as u32))
        }
    }

    pub fn spotlight(path: &str) -> Option<plist::Value> {
        // SAFETY: each Copy/Create result is owned (+1) and released by CFRetained.
        unsafe {
            let item = CFRetained::from_raw(MDItemCreateWithURL(std::ptr::null(), &*url(path)?)?);
            let names = CFRetained::from_raw(MDItemCopyAttributeNames(&item)?);
            let attrs = CFRetained::from_raw(MDItemCopyAttributes(&item, &names)?);
            to_plist(&attrs)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `DOFTAR_SAMPLE_VIDEO=/path/to/clip.mov cargo test -- --ignored reads_a_real_clip --nocapture`
    #[test]
    #[ignore]
    fn reads_a_real_clip() {
        let path = std::env::var("DOFTAR_SAMPLE_VIDEO").expect("DOFTAR_SAMPLE_VIDEO");
        let info = media_info_of(&path).expect("a clip says something about itself");
        println!("{info:?}");
        assert!(info.fps.is_some() && info.width.is_some() && info.duration_s.is_some(), "read even off Spotlight");
    }

    #[test]
    fn picks_the_media_summary_out_of_spotlight() {
        let mut d = plist::Dictionary::new();
        d.insert("kMDItemDurationSeconds".into(), 12.5.into());
        d.insert("kMDItemPixelWidth".into(), 3840.into());
        d.insert("kMDItemPixelHeight".into(), 2160.into());
        d.insert("kMDItemCodecs".into(), plist::Value::Array(vec!["H.264".into(), "AAC".into()]));
        d.insert("kMDItemAcquisitionMake".into(), "Sony".into());
        d.insert("kMDItemAcquisitionModel".into(), "ILCE-7M4".into());
        let m = spotlight_media(&d);
        assert_eq!((m.duration_s, m.width, m.height), (Some(12.5), Some(3840), Some(2160)));
        assert_eq!(m.codec.as_deref(), Some("H.264, AAC"));
        assert_eq!(m.camera.as_deref(), Some("Sony ILCE-7M4"));
        assert_eq!(spotlight_media(&plist::Dictionary::new()), MediaInfo::default());
    }

    #[test]
    fn labels_read_as_words() {
        assert_eq!(label_of("kMDItemAudioBitRate"), "Audio Bit Rate");
        assert_eq!(label_of("_kMDItemDisplayNameWithExtensions"), "Display Name With Extensions");
        assert_eq!(label_of("kMDItemFSSize"), "FS Size");
        assert_eq!(label_of("{Exif}"), "Exif");
        assert_eq!(label_of("ISOSpeedRatings"), "ISO Speed Ratings");
        assert_eq!(label_of("PixelWidth"), "Pixel Width");
        assert_eq!(label_of("Lens_Model"), "Lens Model");
    }

    #[test]
    fn image_dictionaries_become_groups() {
        let mut exif = plist::Dictionary::new();
        exif.insert("ExposureTime".into(), plist::Value::Real(1.0 / 120.0));
        exif.insert("ISOSpeedRatings".into(), plist::Value::Array(vec![100.into(), 200.into()]));
        exif.insert("Empty".into(), plist::Value::Array(vec![]));
        let mut d = plist::Dictionary::new();
        d.insert("PixelWidth".into(), 4032.into());
        d.insert("HasAlpha".into(), false.into());
        d.insert("{Exif}".into(), plist::Value::Dictionary(exif));
        let g = image_groups(&d);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].title, "Image");
        assert_eq!(g[0].rows[0], MetaRow { label: "Has Alpha".into(), text: "No".into(), date_ms: None });
        assert_eq!(g[1].title, "Exif");
        assert_eq!(g[1].rows[0].text, "0.008333");
        assert_eq!(g[1].rows[1].text, "100, 200");
        assert_eq!(g[1].rows.len(), 2, "an empty list is left out");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_an_images_properties() {
        // Any system image works. A PNG always reports its pixel size.
        let png = "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericDocumentIcon.icns";
        let groups = item_metadata(png.into());
        let image = groups.iter().find(|g| g.title == "Image").expect("an Image group");
        assert!(image.rows.iter().any(|r| r.label == "Pixel Width"));
    }
}
