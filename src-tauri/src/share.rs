//! The macOS share menu (AirDrop, Mail, Messages, Notes...) for files.

use std::path::Path;

/// Where to point the picker: a rect in CSS pixels from the webview's
/// top-left corner, usually the button or the right-click point.
#[derive(serde::Deserialize, Clone, Copy, Debug)]
pub struct Anchor {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg(target_os = "macos")]
mod picker {
    use super::Anchor;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSSharingServicePicker, NSView};
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSRectEdge, NSSize, NSString, NSURL};
    use std::cell::RefCell;

    thread_local! {
        // AppKit doesn't promise to keep the picker alive while its menu is
        // up, so hold the latest one until the next share replaces it.
        static CURRENT: RefCell<Option<Retained<NSSharingServicePicker>>> =
            const { RefCell::new(None) };
    }

    /// Must run on the main thread with `view` being the WKWebView.
    pub unsafe fn show(view: *mut std::ffi::c_void, paths: &[String], anchor: Anchor) {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let Some(view) = (view as *mut NSView).as_ref() else { return };
        let urls: Vec<Retained<NSURL>> = paths
            .iter()
            .map(|p| NSURL::fileURLWithPath(&NSString::from_str(p)))
            .collect();
        let items: Retained<NSArray<AnyObject>> = NSArray::from_retained_slice(
            &urls
                .into_iter()
                .map(|u| Retained::into_super(Retained::into_super(u)))
                .collect::<Vec<_>>(),
        );
        let picker = NSSharingServicePicker::initWithItems(mtm.alloc(), &items);
        let (w, h) = (anchor.width.max(1.0), anchor.height.max(1.0));
        // CSS y grows downward; convert when the view's origin is bottom-left.
        let y = if view.isFlipped() {
            anchor.y
        } else {
            view.bounds().size.height - anchor.y - h
        };
        let rect = NSRect::new(NSPoint::new(anchor.x, y), NSSize::new(w, h));
        if let Some(old) = CURRENT.with(|c| c.borrow_mut().take()) {
            old.close();
        }
        picker.showRelativeToRect_ofView_preferredEdge(rect, view, NSRectEdge::MaxY);
        CURRENT.with(|c| *c.borrow_mut() = Some(picker));
    }
}

#[tauri::command]
pub fn share_paths(
    window: tauri::WebviewWindow,
    paths: Vec<String>,
    anchor: Anchor,
) -> Result<(), String> {
    let paths: Vec<String> = paths
        .into_iter()
        .filter(|p| p.starts_with('/') && Path::new(p).exists())
        .collect();
    if paths.is_empty() {
        return Err("nothing to share".into());
    }
    #[cfg(target_os = "macos")]
    {
        window
            .with_webview(move |wv| unsafe { picker::show(wv.inner(), &paths, anchor) })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, anchor);
        Err("sharing isn't supported on this platform".into())
    }
}
