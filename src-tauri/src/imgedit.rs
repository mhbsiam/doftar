//! Turning, flipping and cropping images from the viewer. ImageIO does the
//! work, so a file keeps its format, colour profile and metadata, and an edit
//! applies to the image as it is shown (after its EXIF orientation), not to
//! its pixels as they happen to be stored.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// What can be saved back; keep in step with `EDITABLE_EXTS` in src/util/kinds.ts.
const EXTS: &[&str] = &["jpg", "jpeg", "png", "tif", "tiff", "heic", "heif", "bmp", "gif"];

static NEXT_TMP: AtomicU64 = AtomicU64::new(1);

#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(serde::Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    /// Quarter turns clockwise.
    pub turns: u8,
    /// Mirrored left to right after turning.
    pub mirror: bool,
    /// The part to keep, in pixels of the turned and mirrored image.
    pub crop: Option<Rect>,
}

/// A turn and/or flip as a matrix taking stored (x, y) to shown (x, y),
/// with y pointing down.
type Lin = [[i32; 2]; 2];

/// How the stored pixels are shown for each EXIF orientation, 1 to 8.
const ORIENTATIONS: [Lin; 8] = [
    [[1, 0], [0, 1]],
    [[-1, 0], [0, 1]],
    [[-1, 0], [0, -1]],
    [[1, 0], [0, -1]],
    [[0, 1], [1, 0]],
    [[0, -1], [1, 0]],
    [[0, -1], [-1, 0]],
    [[0, 1], [-1, 0]],
];
const TURN: Lin = [[0, -1], [1, 0]];
const MIRROR: Lin = [[-1, 0], [0, 1]];

fn mul(a: Lin, b: Lin) -> Lin {
    let mut m = [[0; 2]; 2];
    for (i, row) in m.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = a[i][0] * b[0][j] + a[i][1] * b[1][j];
        }
    }
    m
}

fn orientation_matrix(orientation: u32) -> Lin {
    ORIENTATIONS[orientation.clamp(1, 8) as usize - 1]
}

/// The stored image's orientation with `edit` applied after it.
fn edited(orientation: u32, edit: &Edit) -> Lin {
    let mut m = orientation_matrix(orientation);
    for _ in 0..edit.turns % 4 {
        m = mul(TURN, m);
    }
    if edit.mirror {
        m = mul(MIRROR, m);
    }
    m
}

fn orientation_of(m: Lin) -> u32 {
    ORIENTATIONS.iter().position(|o| *o == m).map_or(1, |i| i as u32 + 1)
}

/// The size a `w` × `h` image is shown at under `m`.
fn shown_size(m: Lin, w: u32, h: u32) -> (u32, u32) {
    if m[0][0] == 0 {
        (h, w)
    } else {
        (w, h)
    }
}

fn ext_of(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

/// Saves `edit` of the image at `path`, over it or (`as_copy`) beside it;
/// returns the path written.
#[tauri::command]
pub async fn save_image_edit(path: String, edit: Edit, as_copy: bool) -> Result<String, String> {
    if crate::watcher::is_ejecting(&path) {
        return Err("volume is being ejected".to_string());
    }
    crate::jobs::blocking(move || save(Path::new(&path), &edit, as_copy)).await?
}

fn save(path: &Path, edit: &Edit, as_copy: bool) -> Result<String, String> {
    if !path.is_absolute() || !EXTS.contains(&ext_of(path).as_str()) {
        return Err("Doftar can't edit this kind of image".into());
    }
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if crate::thumbs::is_dataless(&meta) {
        return Err("the file is not downloaded".into());
    }
    if !as_copy {
        crate::guard::check(path)?;
    }
    let dir = path.parent().ok_or("invalid path")?;
    let name = path.file_name().ok_or("invalid path")?.to_string_lossy();
    let ext = format!(".{}", path.extension().unwrap_or_default().to_string_lossy());

    if as_copy {
        let stem = path.file_stem().unwrap_or_default().to_string_lossy();
        let out = reserve(dir, &format!("{stem} (edited)"), &ext)?;
        return match imageio::write(path, &out, edit) {
            Ok(()) => Ok(out.to_string_lossy().into_owned()),
            Err(e) => {
                let _ = fs::remove_file(&out);
                Err(e)
            }
        };
    }
    let tmp = dir.join(format!(
        ".{name}.doftar-edit-{}-{}{ext}",
        std::process::id(),
        NEXT_TMP.fetch_add(1, Ordering::Relaxed)
    ));
    let res = imageio::write(path, &tmp, edit).and_then(|()| imageio::replace(path, &tmp));
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res.map(|()| path.to_string_lossy().into_owned())
}

/// Claims a free "<base>.ext" (or "<base> (2).ext"…) in `dir`.
fn reserve(dir: &Path, base: &str, ext: &str) -> Result<PathBuf, String> {
    loop {
        let out = dir.join(crate::fsops::unique_name(dir, base, ext));
        match fs::OpenOptions::new().write(true).create_new(true).open(&out) {
            Ok(_) => return Ok(out),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
}

#[cfg(target_os = "macos")]
mod imageio {
    use std::path::Path;
    use std::ptr;

    use objc2_core_foundation::{
        CFArray, CFDictionary, CFMutableDictionary, CFNumber, CFRetained, CFString, CFType,
        CFURLPathStyle, CGAffineTransform, CGPoint, CGRect, CGSize, CFURL,
    };
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGColorSpaceModel,
        CGContext, CGImage, CGImageAlphaInfo, CGInterpolationQuality,
    };
    use objc2_foundation::{NSFileManager, NSFileManagerItemReplacementOptions, NSString, NSURL};
    use objc2_image_io::{
        kCGImageDestinationLossyCompressionQuality, kCGImageDestinationOrientation,
        kCGImagePropertyOrientation, kCGImagePropertyTIFFDictionary,
        kCGImagePropertyTIFFOrientation, CGImageDestination, CGImageSource,
    };

    use super::{edited, orientation_of, shown_size, Edit, Lin, Rect};

    /// Formats whose orientation tag is honoured widely enough that a turn or
    /// flip alone only rewrites the tag, keeping the pixels untouched.
    const TAGGED: &[&str] = &["public.jpeg", "public.heic", "public.tiff"];
    const QUALITY: f64 = 0.92;

    type Props = CFMutableDictionary<CFString, CFType>;

    fn url(path: &Path) -> Result<CFRetained<CFURL>, String> {
        let s = CFString::from_str(&path.to_string_lossy());
        CFURL::with_file_system_path(None, Some(&s), CFURLPathStyle::CFURLPOSIXPathStyle, false)
            .ok_or_else(|| "invalid path".to_string())
    }

    fn mutable(dict: Option<&CFDictionary>) -> CFRetained<Props> {
        match dict.and_then(|d| unsafe { CFMutableDictionary::new_copy(None, 0, Some(d)) }) {
            // SAFETY: ImageIO property dictionaries have CFString keys.
            Some(d) => unsafe { CFRetained::cast_unchecked(d) },
            None => Props::empty(),
        }
    }

    pub(super) fn open(path: &Path) -> Result<(CFRetained<CGImageSource>, u32), String> {
        let src = unsafe { CGImageSource::with_url(&*url(path)?, None) }
            .ok_or("Doftar can't read this image")?;
        match unsafe { src.count() } {
            0 => return Err("Doftar can't read this image".into()),
            1 => {}
            _ => return Err("Doftar can't edit animated or multi-page images".into()),
        }
        let props = mutable(unsafe { src.properties_at_index(0, None) }.as_deref());
        let orientation = props
            .get(unsafe { kCGImagePropertyOrientation })
            .and_then(|v| v.downcast::<CFNumber>().ok())
            .and_then(|n| n.as_i32())
            .map_or(1, |o| o.clamp(1, 8) as u32);
        Ok((src, orientation))
    }

    /// Writes `edit` of `path` to `out`, in the same format.
    pub(super) fn write(path: &Path, out: &Path, edit: &Edit) -> Result<(), String> {
        let (src, orientation) = open(path)?;
        let ty = unsafe { src.r#type() }.ok_or("Doftar can't read this image")?;
        let writable = unsafe { CGImageDestination::type_identifiers() };
        // SAFETY: the array holds type identifiers, which are strings.
        let writable = unsafe { CFRetained::cast_unchecked::<CFArray<CFString>>(writable) };
        if !writable.iter().any(|t| *t == *ty) {
            return Err("Doftar can't save this kind of image".into());
        }
        let m = edited(orientation, edit);
        let dest_url = url(out)?;

        if edit.crop.is_none() && TAGGED.contains(&ty.to_string().as_str()) {
            let dest = unsafe { CGImageDestination::with_url(&dest_url, &ty, 1, None) }
                .ok_or("Doftar can't write this image")?;
            let options = Props::empty();
            options.set(
                unsafe { kCGImageDestinationOrientation },
                &CFNumber::new_i32(orientation_of(m) as i32),
            );
            let options: &CFDictionary = options.as_opaque();
            if unsafe { dest.copy_image_source(&src, Some(options), ptr::null_mut()) } {
                return Ok(());
            }
        }

        let image = unsafe { src.image_at_index(0, None) }.ok_or("Doftar can't read this image")?;
        let rendered = render(&image, m, edit.crop)?;
        let props = mutable(unsafe { src.properties_at_index(0, None) }.as_deref());
        let upright = CFNumber::new_i32(1);
        props.set(unsafe { kCGImagePropertyOrientation }, &upright);
        let tiff_key = unsafe { kCGImagePropertyTIFFDictionary };
        if let Some(tiff) = props.get(tiff_key).and_then(|v| v.downcast::<CFDictionary>().ok()) {
            let tiff = mutable(Some(&tiff));
            tiff.set(unsafe { kCGImagePropertyTIFFOrientation }, &upright);
            props.set(tiff_key, &tiff);
        }
        props.set(
            unsafe { kCGImageDestinationLossyCompressionQuality },
            &CFNumber::new_f64(QUALITY),
        );
        let dest = unsafe { CGImageDestination::with_url(&dest_url, &ty, 1, None) }
            .ok_or("Doftar can't write this image")?;
        let props: &CFDictionary = props.as_opaque();
        unsafe { dest.add_image(&rendered, Some(props)) };
        if !unsafe { dest.finalize() } {
            return Err("Doftar couldn't save the image".into());
        }
        Ok(())
    }

    /// Draws `image` shown under `m`, cut down to `crop`.
    pub(super) fn render(
        image: &CGImage,
        m: Lin,
        crop: Option<Rect>,
    ) -> Result<CFRetained<CGImage>, String> {
        let (w, h) = (CGImage::width(Some(image)) as u32, CGImage::height(Some(image)) as u32);
        let (sw, sh) = shown_size(m, w, h);
        let crop = crop.unwrap_or(Rect { x: 0, y: 0, w: sw, h: sh });
        if crop.w == 0
            || crop.h == 0
            || u64::from(crop.x) + u64::from(crop.w) > u64::from(sw)
            || u64::from(crop.y) + u64::from(crop.h) > u64::from(sh)
        {
            return Err("the crop is outside the image".into());
        }

        let own = CGImage::color_space(Some(image))
            .filter(|cs| {
                CGColorSpace::model(Some(cs)) == CGColorSpaceModel::RGB && cs.supports_output()
            });
        let space = match own {
            Some(cs) => cs,
            None => CGColorSpace::with_name(Some(unsafe { objc2_core_graphics::kCGColorSpaceSRGB }))
                .ok_or("no colour space")?,
        };
        let opaque = matches!(
            CGImage::alpha_info(Some(image)),
            CGImageAlphaInfo::None
                | CGImageAlphaInfo::NoneSkipLast
                | CGImageAlphaInfo::NoneSkipFirst
        );
        let alpha = if opaque {
            CGImageAlphaInfo::NoneSkipLast
        } else {
            CGImageAlphaInfo::PremultipliedLast
        };
        let bits = if CGImage::bits_per_component(Some(image)) > 8 { 16 } else { 8 };
        let ctx = unsafe {
            CGBitmapContextCreate(
                ptr::null_mut(),
                crop.w as usize,
                crop.h as usize,
                bits,
                0,
                Some(&space),
                alpha.0,
            )
        }
        .ok_or("the image is too large to edit")?;

        // `m` and the crop work top-down; Core Graphics works bottom-up.
        let f = |v: i32| f64::from(v);
        let (w, h) = (f64::from(w), f64::from(h));
        // Shifts the turned image back to start at the origin.
        let tx = if m[0][0] < 0 { w } else { 0.0 } + if m[0][1] < 0 { h } else { 0.0 };
        let ty = if m[1][0] < 0 { w } else { 0.0 } + if m[1][1] < 0 { h } else { 0.0 };
        let t = CGAffineTransform {
            a: f(m[0][0]),
            b: -f(m[1][0]),
            c: -f(m[0][1]),
            d: f(m[1][1]),
            tx: f(m[0][1]) * h + tx - f64::from(crop.x),
            ty: f64::from(crop.h) - f(m[1][1]) * h - ty + f64::from(crop.y),
        };
        CGContext::set_interpolation_quality(Some(&ctx), CGInterpolationQuality::None);
        CGContext::concat_ctm(Some(&ctx), t);
        let rect = CGRect::new(CGPoint::ZERO, CGSize::new(w, h));
        CGContext::draw_image(Some(&ctx), rect, Some(image));
        CGBitmapContextCreateImage(Some(&ctx))
            .ok_or_else(|| "Doftar couldn't edit the image".into())
    }

    /// Puts `new` in place of `original`, keeping the original's creation
    /// date, permissions, tags and other extended attributes.
    pub(super) fn replace(original: &Path, new: &Path) -> Result<(), String> {
        let a = NSURL::fileURLWithPath(&NSString::from_str(&original.to_string_lossy()));
        let b = NSURL::fileURLWithPath(&NSString::from_str(&new.to_string_lossy()));
        NSFileManager::defaultManager()
            .replaceItemAtURL_withItemAtURL_backupItemName_options_resultingItemURL_error(
                &a,
                &b,
                None,
                NSFileManagerItemReplacementOptions::empty(),
                None,
            )
            .map_err(|e| e.localizedDescription().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
mod imageio {
    use super::Edit;
    use std::path::Path;

    pub(super) fn write(_: &Path, _: &Path, _: &Edit) -> Result<(), String> {
        Err("image editing needs macOS".into())
    }
    pub(super) fn replace(_: &Path, _: &Path) -> Result<(), String> {
        Err("image editing needs macOS".into())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use objc2_core_foundation::{
        CFMutableDictionary, CFNumber, CFRetained, CFString, CFType, CFURLPathStyle, CGPoint,
        CGRect, CGSize, CFURL,
    };
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGContext, CGImage,
        CGImageAlphaInfo,
    };
    use objc2_image_io::{kCGImagePropertyOrientation, CGImageDestination};

    #[derive(Debug, PartialEq, Clone, Copy)]
    enum C {
        Red,
        Green,
        Blue,
        White,
    }
    const COLORS: [(C, [u8; 3]); 4] = [
        (C::Red, [255, 0, 0]),
        (C::Green, [0, 255, 0]),
        (C::Blue, [0, 0, 255]),
        (C::White, [255, 255, 255]),
    ];

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("doftar-imgedit-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn cfurl(p: &Path) -> CFRetained<CFURL> {
        let s = CFString::from_str(&p.to_string_lossy());
        CFURL::with_file_system_path(None, Some(&s), CFURLPathStyle::CFURLPOSIXPathStyle, false)
            .unwrap()
    }

    /// Stores a 40 × 20 image, red / green over blue / white, tagged `orientation`.
    fn make(path: &Path, ty: &str, orientation: i32) {
        let (w, h) = (40usize, 20usize);
        let mut px = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let c = COLORS[(y >= h / 2) as usize * 2 + (x >= w / 2) as usize].1;
                px[(y * w + x) * 4..][..4].copy_from_slice(&[c[0], c[1], c[2], 255]);
            }
        }
        let space = CGColorSpace::new_device_rgb().unwrap();
        let ctx = unsafe {
            CGBitmapContextCreate(
                px.as_mut_ptr().cast(),
                w,
                h,
                8,
                w * 4,
                Some(&space),
                CGImageAlphaInfo::NoneSkipLast.0,
            )
        }
        .unwrap();
        let image = CGBitmapContextCreateImage(Some(&ctx)).unwrap();
        let dest =
            unsafe { CGImageDestination::with_url(&cfurl(path), &CFString::from_str(ty), 1, None) }
                .unwrap();
        let props = CFMutableDictionary::<CFString, CFType>::empty();
        props.set(unsafe { kCGImagePropertyOrientation }, &CFNumber::new_i32(orientation));
        unsafe { dest.add_image(&image, Some(props.as_opaque())) };
        assert!(unsafe { dest.finalize() });
    }

    /// The image at `path` as shown: its stored size, orientation, and the
    /// colours of its shown corners (top left, top right, bottom left, bottom right).
    fn look(path: &Path) -> ((u32, u32), u32, (u32, u32), [C; 4]) {
        let (src, orientation) = imageio::open(path).unwrap();
        let image = unsafe { src.image_at_index(0, None) }.unwrap();
        let stored = (
            CGImage::width(Some(&image)) as u32,
            CGImage::height(Some(&image)) as u32,
        );
        let shown = imageio::render(&image, orientation_matrix(orientation), None).unwrap();
        let (w, h) = (CGImage::width(Some(&shown)), CGImage::height(Some(&shown)));
        let mut px = vec![0u8; w * h * 4];
        let space = CGColorSpace::new_device_rgb().unwrap();
        let ctx = unsafe {
            CGBitmapContextCreate(
                px.as_mut_ptr().cast(),
                w,
                h,
                8,
                w * 4,
                Some(&space),
                CGImageAlphaInfo::NoneSkipLast.0,
            )
        }
        .unwrap();
        let rect = CGRect::new(CGPoint::ZERO, CGSize::new(w as f64, h as f64));
        CGContext::draw_image(Some(&ctx), rect, Some(&shown));
        let at = |x: usize, y: usize| {
            let p = &px[(y * w + x) * 4..][..3];
            COLORS
                .iter()
                .min_by_key(|(_, c)| {
                    (0..3).map(|i| (i32::from(p[i]) - i32::from(c[i])).abs()).sum::<i32>()
                })
                .unwrap()
                .0
        };
        let corners = [at(1, 1), at(w - 2, 1), at(1, h - 2), at(w - 2, h - 2)];
        (stored, orientation, (w as u32, h as u32), corners)
    }

    use C::*;

    fn edit(turns: u8, mirror: bool, crop: Option<Rect>) -> Edit {
        Edit { turns, mirror, crop }
    }

    #[test]
    fn orientations_compose() {
        for o in 1..=8 {
            assert_eq!(orientation_of(edited(o, &edit(0, false, None))), o);
            assert_eq!(orientation_of(edited(o, &edit(4, false, None))), o);
        }
        assert_eq!(orientation_of(edited(1, &edit(1, false, None))), 6);
        assert_eq!(orientation_of(edited(6, &edit(3, false, None))), 1);
        assert_eq!(orientation_of(edited(1, &edit(0, true, None))), 2);
        assert_eq!(orientation_of(edited(1, &edit(2, true, None))), 4);
        assert_eq!(orientation_of(edited(1, &edit(3, true, None))), 7);
        assert_eq!(orientation_of(edited(1, &edit(1, true, None))), 5);
    }

    #[test]
    fn turns_flips_and_crops_a_png() {
        let dir = scratch("png");
        let p = dir.join("a.png");
        make(&p, "public.png", 1);
        assert_eq!(look(&p).3, [Red, Green, Blue, White]);

        save(&p, &edit(1, false, None), false).unwrap();
        let (stored, o, shown, corners) = look(&p);
        assert_eq!((stored, o, shown), ((20, 40), 1, (20, 40)));
        assert_eq!(corners, [Blue, Red, White, Green]);

        save(&p, &edit(0, true, Some(Rect { x: 0, y: 0, w: 10, h: 40 })), false).unwrap();
        let (stored, _, _, corners) = look(&p);
        assert_eq!(stored, (10, 40));
        assert_eq!(corners, [Red, Red, Green, Green]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn crops_what_is_shown_not_what_is_stored() {
        let dir = scratch("exif");
        let p = dir.join("photo.jpg");
        // Stored on its side; shown 20 × 40 with blue at the top left.
        make(&p, "public.jpeg", 6);
        assert_eq!(look(&p).2, (20, 40));
        assert_eq!(look(&p).3, [Blue, Red, White, Green]);

        save(&p, &edit(0, false, Some(Rect { x: 0, y: 20, w: 10, h: 20 })), false).unwrap();
        let (stored, o, shown, corners) = look(&p);
        assert_eq!((stored, o, shown), ((10, 20), 1, (10, 20)));
        assert_eq!(corners, [White; 4]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn turning_a_jpeg_only_rewrites_its_orientation() {
        let dir = scratch("lossless");
        let p = dir.join("photo.jpg");
        make(&p, "public.jpeg", 1);
        save(&p, &edit(1, false, None), false).unwrap();
        let (stored, o, shown, corners) = look(&p);
        assert_eq!((stored, o, shown), ((40, 20), 6, (20, 40)));
        assert_eq!(corners, [Blue, Red, White, Green]);
        save(&p, &edit(3, false, None), false).unwrap();
        assert_eq!(look(&p).1, 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn crops_after_turning() {
        let dir = scratch("turncrop");
        let p = dir.join("a.png");
        make(&p, "public.png", 1);
        // Turned left it shows 20 × 40, green / white over red / blue.
        save(&p, &edit(3, false, Some(Rect { x: 0, y: 30, w: 20, h: 10 })), false).unwrap();
        let (stored, _, _, corners) = look(&p);
        assert_eq!(stored, (20, 10));
        assert_eq!(corners, [Red, Blue, Red, Blue]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn saves_a_copy_beside_the_original() {
        let dir = scratch("copy");
        let p = dir.join("a.png");
        make(&p, "public.png", 1);
        let before = fs::read(&p).unwrap();
        let first = save(&p, &edit(2, false, None), true).unwrap();
        let second = save(&p, &edit(2, false, None), true).unwrap();
        assert_eq!(Path::new(&first).file_name().unwrap(), "a (edited).png");
        assert_eq!(Path::new(&second).file_name().unwrap(), "a (edited) (2).png");
        assert_eq!(fs::read(&p).unwrap(), before);
        assert_eq!(look(Path::new(&first)).3, [White, Blue, Green, Red]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keeps_extended_attributes_and_leaves_no_temp_files() {
        use std::ffi::CString;
        let dir = scratch("xattr");
        let p = dir.join("a.png");
        make(&p, "public.png", 1);
        let cp = CString::new(p.to_string_lossy().as_bytes()).unwrap();
        let name = CString::new("com.doftar.test").unwrap();
        let set =
            unsafe { libc::setxattr(cp.as_ptr(), name.as_ptr(), b"kept".as_ptr().cast(), 4, 0, 0) };
        assert_eq!(set, 0);
        save(&p, &edit(1, false, None), false).unwrap();
        let mut buf = [0u8; 8];
        let n = unsafe {
            libc::getxattr(cp.as_ptr(), name.as_ptr(), buf.as_mut_ptr().cast(), buf.len(), 0, 0)
        };
        assert_eq!(&buf[..n.max(0) as usize], b"kept");
        let names: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, ["a.png"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_bad_crops_and_formats() {
        let dir = scratch("bad");
        let p = dir.join("a.png");
        make(&p, "public.png", 1);
        for crop in [Rect { x: 30, y: 0, w: 20, h: 10 }, Rect { x: 0, y: 0, w: 0, h: 10 }] {
            assert!(save(&p, &edit(0, false, Some(crop)), false).is_err());
        }
        let svg = dir.join("a.svg");
        fs::write(&svg, "<svg/>").unwrap();
        assert!(save(&svg, &edit(1, false, None), false).is_err());
        assert!(save(Path::new("relative.png"), &edit(1, false, None), false).is_err());
        let names: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 2);
        fs::remove_dir_all(&dir).unwrap();
    }
}
