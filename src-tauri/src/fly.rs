//! A file opened from a listing flies out of its thumbnail into its viewer
//! (an image into the image viewer, a PDF onto its first page, a text file's
//! icon into the reader), and back into the listing when the viewer closes,
//! as Quick Look's panel does. The viewer window itself never changes size
//! for it: growing a page from a 72-point tile would lay it out afresh at
//! every frame. A borderless window that ignores the mouse carries the
//! picture instead, above everything, while the viewer fades in or out
//! underneath; AppKit animates its frame, so it stays smooth however busy
//! either page is. Each viewer window keeps its own idea of what it shows
//! and where it came from, so the three can be open at once.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use tauri::{Emitter, Manager, WebviewWindow, Window};

use crate::zoom::CssRect;

/// How long the thumbnail takes to fly to the viewer, and back.
const FLY_IN: Duration = Duration::from_millis(360);
const FLY_BACK: Duration = Duration::from_millis(320);
/// How long the viewer takes to fade out under a thumbnail flying back.
const FADE_OUT: Duration = Duration::from_millis(140);
/// Once the image is drawn, how long the thumbnail takes to settle onto it
/// while the viewer fades in, then to fade away over it.
const SETTLE: Duration = Duration::from_millis(140);
const FADE: Duration = Duration::from_millis(180);
/// How long a landed thumbnail waits for the page to draw the image before
/// uncovering the viewer anyway.
const LAND_WAIT: Duration = Duration::from_millis(1200);
/// How long the thumbnail stays over its tile after landing, so the tile has
/// painted again before it goes.
const LINGER: Duration = Duration::from_millis(50);
/// How long a close waits to hear where its thumbnail is in the listing.
const ASK_WAIT: Duration = Duration::from_millis(80);
/// The thumbnail size listings show; `THUMB_PX` in src/components/FileIcon.tsx.
const THUMB_PX: u32 = 160;
/// Where the viewer's stage sits in its window before the page first says,
/// the toolbar's height in CSS pixels; see `.iv-bar` in global.css.
const BAR_H: f64 = 40.0;

/// What a viewer page shows, as it last said: for flying back on closing.
#[derive(Clone)]
struct Shown {
    path: Option<String>,
    /// Where the picture is drawn, while it is drawn whole and unedited.
    /// None where the viewer draws no picture (the reader): the flight then
    /// lands on, and leaves from, a badge in the middle of the stage.
    pic: Option<CssRect>,
    /// How much of the picture `pic` shows, from its top: a PDF page taller
    /// than the window is cut off at the bottom.
    visible: f64,
    stage: CssRect,
}

/// What flies: a cached thumbnail on disk, a picture drawn just now (a PDF
/// page), or a file's icon as the listing drew it (SVG). Pictures of a
/// file's contents get the panel's shadow, as a photo would; an icon has
/// its own look and none.
#[derive(Clone)]
pub enum Picture {
    File(PathBuf),
    Data(Vec<u8>),
    Icon(Vec<u8>),
}

/// Where a picture lands in its viewer.
#[derive(Clone, Copy)]
pub enum Landing {
    /// Onto the picture the viewer draws, of this pixel size when known,
    /// fitted into the stage as the viewer fits it.
    Image(Option<(f64, f64)>),
    /// Exactly onto `rect`, which shows the top `visible` of the picture.
    Exact { rect: CssRect, visible: f64 },
    /// As a badge in the middle of the stage, for a viewer that draws no
    /// picture to land on; it fades away as the page shows through.
    Badge,
}

/// How much of the stage's shorter side a badge takes.
const BADGE: f64 = 0.4;

/// By viewer window label.
static SHOWN: Mutex<Option<HashMap<String, Shown>>> = Mutex::new(None);
/// The listing window each viewer was last opened from by a flight, by label.
static OPENER: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
/// Closes waiting to hear where their thumbnail is, by request id.
static ASKS: Mutex<Option<HashMap<u64, mpsc::Sender<Option<CssRect>>>>> = Mutex::new(None);
static NEXT_ASK: AtomicU64 = AtomicU64::new(1);

#[derive(serde::Serialize, Clone)]
struct Where {
    id: u64,
    path: String,
}

/// The cached listing thumbnail for `path`, if there is one.
pub fn thumb_for(path: &str) -> Option<PathBuf> {
    if crate::watcher::is_ejecting(path) {
        return None;
    }
    crate::thumbs::cached(path, THUMB_PX)
}

/// Remembers which listing window the viewer `label` flies back to (none:
/// it was opened some other way).
pub fn set_opener(label: &str, source: Option<String>) {
    let mut map = OPENER.lock().unwrap();
    let map = map.get_or_insert_with(HashMap::new);
    match source {
        Some(s) => {
            map.insert(label.to_string(), s);
        }
        None => {
            map.remove(label);
        }
    }
}

fn opener(label: &str) -> Option<String> {
    OPENER.lock().unwrap().as_ref()?.get(label).cloned()
}

fn shown(label: &str) -> Option<Shown> {
    SHOWN.lock().unwrap().as_ref()?.get(label).cloned()
}

/// Records what the viewer `label` shows and where, for flying back on
/// closing; `visible` is how much of the picture `pic` shows, from its top.
pub fn set_shown(
    label: &str,
    path: Option<String>,
    pic: Option<CssRect>,
    visible: f64,
    stage: CssRect,
) {
    SHOWN
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(label.to_string(), Shown { path, pic, visible, stage });
}

/// The file the viewer `label` last said it shows.
pub fn shown_path(label: &str) -> Option<String> {
    shown(label)?.path
}

/// The badge box in the middle of `stage`.
fn badge(stage: CssRect) -> CssRect {
    let side = (stage.w.min(stage.h) * BADGE).max(1.0);
    CssRect {
        x: stage.x + (stage.w - side) / 2.0,
        y: stage.y + (stage.h - side) / 2.0,
        w: side,
        h: side,
    }
}

/// Where a `w` × `h` image is drawn in `stage`, as the viewer page places it:
/// centred and shrunk to fit, never enlarged unless `enlarge`.
fn fit(w: f64, h: f64, stage: CssRect, enlarge: bool) -> CssRect {
    let mut s = (stage.w / w).min(stage.h / h);
    if !enlarge {
        s = s.min(1.0);
    }
    let (fw, fh) = (w * s, h * s);
    CssRect {
        x: stage.x + (stage.w - fw) / 2.0,
        y: stage.y + (stage.h - fh) / 2.0,
        w: fw,
        h: fh,
    }
}

/// Where the viewer `label`'s picture will go, for a window `width` ×
/// `height` in CSS pixels: its stage as the page last measured it, or a guess.
fn stage_for(label: &str, width: f64, height: f64) -> CssRect {
    shown(label).map(|s| s.stage).unwrap_or(CssRect {
        x: 0.0,
        y: BAR_H,
        w: width,
        h: (height - BAR_H).max(1.0),
    })
}

/// A viewer page says what it shows and where.
#[tauri::command]
pub fn viewer_shown(
    window: WebviewWindow,
    path: Option<String>,
    pic: Option<CssRect>,
    stage: CssRect,
) {
    set_shown(window.label(), path, pic, 1.0, stage);
}

/// A listing answers where the thumbnail a close asked about is.
#[tauri::command]
pub fn viewer_return_rect(id: u64, rect: Option<CssRect>) {
    if let Some(tx) = ASKS.lock().unwrap().as_mut().and_then(|m| m.remove(&id)) {
        let _ = tx.send(rect);
    }
}

/// Runs `f` on the main thread after `d`.
fn later(w: &WebviewWindow, d: Duration, f: impl FnOnce() + Send + 'static) {
    let w = w.clone();
    std::thread::spawn(move || {
        std::thread::sleep(crate::zoom::slow(d));
        let _ = w.run_on_main_thread(f);
    });
}

/// Starts `picture` flying from `from` in `source`'s page into `viewer`,
/// with the viewer coming up underneath it; false when it can't, and the
/// caller shows the viewer as usual. Runs on the main thread.
pub fn fly_in(
    viewer: &WebviewWindow,
    source: &WebviewWindow,
    from: CssRect,
    picture: &Picture,
    landing: Landing,
) -> bool {
    #[cfg(target_os = "macos")]
    return mac::fly_in(viewer, source, from, picture, landing);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (viewer, source, from, picture, landing);
        false
    }
}

/// The viewer page has drawn its image at `pic`: a thumbnail flying in for
/// `win` settles onto it and uncovers the viewer. False when none is.
/// Runs on the main thread.
pub fn land(win: &WebviewWindow, pic: Option<CssRect>) -> bool {
    #[cfg(target_os = "macos")]
    return mac::land(win, pic);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (win, pic);
        false
    }
}

/// Drops a thumbnail still flying in, for a viewer closing under it.
/// Runs on the main thread.
pub fn cancel() {
    #[cfg(target_os = "macos")]
    mac::cancel();
}

/// Closes the viewer `win` by flying `picture` (its file's, as it flew in)
/// back into the listing it came from, when that still shows the file; true
/// when it took the close over (it may still fall back to the usual zoom
/// out). Runs on the main thread.
pub fn fly_back(
    win: &Window,
    picture: Option<Picture>,
    landing: Landing,
    still_closing: impl Fn() -> bool + Send + 'static,
    hidden: impl FnOnce(&Window) + Send + 'static,
) -> bool {
    if crate::zoom::reduce_motion() {
        return false;
    }
    let Some(shown) = shown(win.label()) else { return false };
    let Some(path) = shown.path else { return false };
    let pic = match (landing, shown.pic) {
        (Landing::Image(_) | Landing::Exact { .. }, Some(pic)) => Some(pic),
        (Landing::Image(_) | Landing::Exact { .. }, None) => return false,
        (Landing::Badge, _) => None,
    };
    let visible = shown.visible;
    let stage = shown.stage;
    let Some(label) = opener(win.label()) else { return false };
    let Some(source) = win.app_handle().get_webview_window(&label) else { return false };
    if !source.is_visible().unwrap_or(false) || source.is_minimized().unwrap_or(true) {
        return false;
    }
    let Some(thumb) = picture else { return false };

    let id = NEXT_ASK.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    ASKS.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, tx);
    if source.emit_to(&label, "viewer:where", Where { id, path }).is_err() {
        ASKS.lock().unwrap().as_mut().map(|m| m.remove(&id));
        return false;
    }
    let win = win.clone();
    std::thread::spawn(move || {
        let to = rx.recv_timeout(ASK_WAIT).ok().flatten();
        ASKS.lock().unwrap().as_mut().map(|m| m.remove(&id));
        let w = win.clone();
        let _ = win.run_on_main_thread(move || {
            if !still_closing() {
                return;
            }
            #[cfg(target_os = "macos")]
            if let Some(to) = to {
                if mac::fly_out(&w, &source, pic, visible, stage, to, &thumb) {
                    let wait = crate::zoom::slow(FLY_BACK + LINGER);
                    crate::zoom::hide_after(&w, wait, still_closing, hidden);
                    return;
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (to, pic, visible, stage, &thumb, &source);
            crate::zoom::hide(&w, still_closing, hidden);
        });
    });
    true
}

/// The pixel size `path` is drawn at, its orientation applied, when ImageIO
/// can read it.
pub fn image_size(path: &Path) -> Option<(f64, f64)> {
    #[cfg(target_os = "macos")]
    return mac::image_size(path);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        None
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::{Cell, RefCell};
    use std::path::Path;
    use std::time::Duration;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::{AllocAnyThread, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSAnimatablePropertyContainer, NSAnimationContext, NSAutoresizingMaskOptions,
        NSBackingStoreType, NSColor, NSFloatingWindowLevel, NSImage, NSView,
        NSWindow, NSWindowAnimationBehavior, NSWindowCollectionBehavior, NSWindowStyleMask,
    };
    use objc2_core_foundation::{
        CFDictionary, CFNumber, CFRetained, CFString, CFType, CFURLPathStyle, CFURL,
    };
    use objc2_foundation::{
        ns_string, NSData, NSDictionary, NSNull, NSPoint, NSRect, NSSize, NSString,
    };
    use objc2_image_io::{
        kCGImagePropertyOrientation, kCGImagePropertyPixelHeight, kCGImagePropertyPixelWidth,
        CGImageSource,
    };
    use objc2_core_foundation::CGRect;
    use objc2_quartz_core::{
        kCAGravityResizeAspectFill, CAAction, CALayer, CAMediaTimingFunction, CATransaction,
    };
    use tauri::{Emitter, WebviewWindow, Window};

    use super::{
        badge, fit, later, stage_for, CssRect, Landing, Picture, FADE, FADE_OUT, FLY_BACK,
        FLY_IN, LAND_WAIT, LINGER, SETTLE,
    };
    use crate::zoom::{mac as zoom, ns, slow};

    /// Fast out, long settle: ease-out-quint.
    const SETTLING: [f32; 4] = [0.22, 1.0, 0.36, 1.0];

    struct Flight {
        id: u64,
        viewer: WebviewWindow,
        source: WebviewWindow,
        arrived: bool,
        /// Where the page drew the image, once it has said.
        drawn: Option<Option<CssRect>>,
        /// The viewer was hidden, so it fades in under the thumbnail.
        reveal: bool,
    }

    thread_local! {
        static PANEL: RefCell<Option<(Retained<NSWindow>, Retained<CALayer>)>> =
            const { RefCell::new(None) };
        static FLIGHT: RefCell<Option<Flight>> = const { RefCell::new(None) };
        /// Bumped at every new use of the panel, so a step left over from an
        /// earlier one leaves it alone.
        static USE: Cell<u64> = const { Cell::new(0) };
    }

    fn panel(mtm: MainThreadMarker) -> (Retained<NSWindow>, Retained<CALayer>) {
        PANEL.with(|p| {
            p.borrow_mut()
                .get_or_insert_with(|| {
                    let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(16.0, 16.0));
                    let w = unsafe {
                        NSWindow::initWithContentRect_styleMask_backing_defer(
                            NSWindow::alloc(mtm),
                            rect,
                            NSWindowStyleMask::Borderless,
                            NSBackingStoreType::Buffered,
                            false,
                        )
                    };
                    unsafe { w.setReleasedWhenClosed(false) };
                    w.setOpaque(false);
                    w.setBackgroundColor(Some(&NSColor::clearColor()));
                    w.setHasShadow(true);
                    w.setIgnoresMouseEvents(true);
                    w.setLevel(NSFloatingWindowLevel);
                    w.setExcludedFromWindowsMenu(true);
                    w.setAnimationBehavior(NSWindowAnimationBehavior::None);
                    w.setCollectionBehavior(
                        NSWindowCollectionBehavior::Transient
                            | NSWindowCollectionBehavior::IgnoresCycle
                            | NSWindowCollectionBehavior::FullScreenAuxiliary,
                    );

                    // A layer-hosting view: AppKit never draws over its contents.
                    let layer = CALayer::new();
                    layer.setContentsGravity(unsafe { kCAGravityResizeAspectFill });
                    layer.setMasksToBounds(true);
                    // The window's frame animates; the layer just follows it.
                    let none = NSNull::null();
                    let none: &ProtocolObject<dyn CAAction> = ProtocolObject::from_ref(&*none);
                    let keys = [
                        ns_string!("bounds"),
                        ns_string!("position"),
                        ns_string!("frame"),
                        ns_string!("contents"),
                    ];
                    layer.setActions(Some(&NSDictionary::from_slices(&keys, &[none; 4])));
                    let view = NSView::initWithFrame(NSView::alloc(mtm), rect);
                    view.setLayer(Some(&layer));
                    view.setWantsLayer(true);
                    view.setAutoresizingMask(
                        NSAutoresizingMaskOptions::ViewWidthSizable
                            | NSAutoresizingMaskOptions::ViewHeightSizable,
                    );
                    w.setContentView(Some(&view));
                    (w, layer)
                })
                .clone()
        })
    }

    fn next_use() -> u64 {
        USE.with(|u| {
            u.set(u.get() + 1);
            u.get()
        })
    }

    fn current_use() -> u64 {
        USE.with(|u| u.get())
    }

    fn animate(over: Duration, curve: [f32; 4], steps: impl FnOnce()) {
        NSAnimationContext::beginGrouping();
        let ctx = NSAnimationContext::currentContext();
        ctx.setDuration(slow(over).as_secs_f64());
        let [a, b, c, d] = curve;
        ctx.setTimingFunction(Some(&CAMediaTimingFunction::functionWithControlPoints(a, b, c, d)));
        steps();
        NSAnimationContext::endGrouping();
    }

    fn image(picture: &Picture) -> Option<Retained<NSImage>> {
        match picture {
            Picture::File(path) => NSImage::initWithContentsOfFile(
                NSImage::alloc(),
                &NSString::from_str(&path.to_string_lossy()),
            ),
            Picture::Data(bytes) | Picture::Icon(bytes) => {
                NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes))
            }
        }
    }

    /// Puts `picture` up at `at`, ready to fly; returns the panel and the
    /// picture's size.
    fn launch(at: NSRect, picture: &Picture) -> Option<(Retained<NSWindow>, NSSize)> {
        let mtm = MainThreadMarker::new()?;
        let image = image(picture)?;
        let (w, layer) = panel(mtm);
        next_use();
        let contents: &AnyObject = &image;
        unsafe { layer.setContents(Some(contents)) };
        layer.setContentsScale(w.backingScaleFactor());
        CATransaction::begin();
        CATransaction::setDisableActions(true);
        layer.setContentsRect(crop(1.0));
        CATransaction::commit();
        w.setHasShadow(!matches!(picture, Picture::Icon(_)));
        w.setAlphaValue(1.0);
        w.setFrame_display(at, false);
        w.orderFrontRegardless();
        Some((w, image.size()))
    }

    /// Where a `size` picture lands in `stage` for `landing`.
    fn landing_rect(landing: Landing, size: NSSize, stage: CssRect) -> CssRect {
        let own = (size.width > 0.0 && size.height > 0.0).then_some((size.width, size.height));
        match landing {
            // Without the image's own size the thumbnail's shape has to do.
            Landing::Image(Some((w, h))) if w > 0.0 && h > 0.0 => fit(w, h, stage, false),
            Landing::Image(_) => own.map_or(stage, |(w, h)| fit(w, h, stage, true)),
            Landing::Exact { rect, .. } => rect,
            Landing::Badge => own.map_or(badge(stage), |(w, h)| fit(w, h, badge(stage), true)),
        }
    }

    /// The part of the picture the panel shows: its top `visible`, in the
    /// layer's unit square (bottom-up).
    fn crop(visible: f64) -> CGRect {
        let v = visible.clamp(0.05, 1.0);
        CGRect::new(
            objc2_core_foundation::CGPoint::new(0.0, 1.0 - v),
            objc2_core_foundation::CGSize::new(1.0, v),
        )
    }

    /// Glides the panel's crop to `visible` over `over`, with the frame.
    fn recrop(over: Duration, visible: f64) {
        let Some((_, layer)) = PANEL.with(|p| p.borrow().clone()) else { return };
        CATransaction::begin();
        CATransaction::setAnimationDuration(slow(over).as_secs_f64());
        let [a, b, c, d] = SETTLING;
        CATransaction::setAnimationTimingFunction(Some(
            &CAMediaTimingFunction::functionWithControlPoints(a, b, c, d),
        ));
        layer.setContentsRect(crop(visible));
        CATransaction::commit();
    }

    /// Takes the panel down, unless it has been put to another use since `u`.
    fn put_away(u: u64) {
        if current_use() != u {
            return;
        }
        PANEL.with(|p| {
            if let Some((w, layer)) = p.borrow().as_ref() {
                w.orderOut(None);
                unsafe { layer.setContents(None) };
            }
        });
    }

    fn flown(source: &WebviewWindow) {
        let _ = source.emit_to(source.label(), "viewer:flown", ());
    }

    pub fn fly_in(
        viewer: &WebviewWindow,
        source: &WebviewWindow,
        from: CssRect,
        picture: &Picture,
        landing: Landing,
    ) -> bool {
        if zoom::reduce_motion() {
            return false;
        }
        let (Ok(v), Ok(s)) = (viewer.ns_window(), source.ns_window()) else { return false };
        let (v, s) = (ns(v), ns(s));
        let start = zoom::css_to_screen(s, s.frame(), from);
        let hidden = !v.isVisible();
        let frame = zoom::resting(v);
        let content = v.contentRectForFrameRect(frame);
        let stage = stage_for(viewer.label(), content.size.width, content.size.height);

        cancel();
        let Some((w, size)) = launch(start, picture) else { return false };
        let pic = landing_rect(landing, size, stage);
        let end = zoom::css_to_screen(v, frame, pic);

        if hidden {
            zoom::before_fade_in(v);
            let _ = viewer.unminimize();
            let _ = viewer.show();
            let _ = viewer.set_focus();
        } else {
            crate::zoom::show(viewer);
        }
        // The viewer just took the keyboard; the thumbnail stays on top.
        w.orderFrontRegardless();
        animate(FLY_IN, SETTLING, || w.animator().setFrame_display(end, true));
        if let Landing::Exact { visible, .. } = landing {
            recrop(FLY_IN, visible);
        }

        let id = current_use();
        FLIGHT.with(|f| {
            if let Some(old) = f.borrow_mut().replace(Flight {
                id,
                viewer: viewer.clone(),
                source: source.clone(),
                arrived: false,
                drawn: None,
                reveal: hidden,
            }) {
                flown(&old.source);
            }
        });
        later(viewer, FLY_IN, move || arrive(id));
        true
    }

    fn arrive(id: u64) {
        let ready = FLIGHT.with(|f| {
            let mut f = f.borrow_mut();
            let flight = f.as_mut().filter(|fl| fl.id == id)?;
            flight.arrived = true;
            flown(&flight.source);
            Some((flight.drawn, flight.viewer.clone()))
        });
        match ready {
            Some((Some(pic), _)) => settle(id, pic),
            Some((None, viewer)) => later(&viewer, LAND_WAIT, move || settle(id, None)),
            None => {}
        }
    }

    pub fn land(win: &WebviewWindow, pic: Option<CssRect>) -> bool {
        let state = FLIGHT.with(|f| {
            let mut f = f.borrow_mut();
            let flight = f.as_mut().filter(|fl| fl.viewer.label() == win.label())?;
            if !flight.arrived {
                flight.drawn = Some(pic);
            }
            Some((flight.id, flight.arrived))
        });
        match state {
            Some((id, true)) => {
                settle(id, pic);
                true
            }
            Some((_, false)) => true,
            None => false,
        }
    }

    /// Settles the landed thumbnail onto where the page drew the image while
    /// the viewer fades in under it, then fades the thumbnail away.
    fn settle(id: u64, pic: Option<CssRect>) {
        let Some(flight) = FLIGHT.with(|f| {
            let mut f = f.borrow_mut();
            if f.as_ref().is_some_and(|fl| fl.id == id) {
                f.take()
            } else {
                None
            }
        }) else {
            return;
        };
        let Ok(v) = flight.viewer.ns_window() else { return put_away(id) };
        let v = ns(v);
        let Some((w, _)) = PANEL.with(|p| p.borrow().clone()) else { return };
        animate(SETTLE, SETTLING, || {
            if let Some(pic) = pic {
                w.animator().setFrame_display(zoom::css_to_screen(v, v.frame(), pic), true);
            }
            if flight.reveal {
                v.animator().setAlphaValue(1.0);
            }
        });
        let viewer = flight.viewer.clone();
        later(&flight.viewer, SETTLE, move || {
            if current_use() != id {
                return;
            }
            let Some((w, _)) = PANEL.with(|p| p.borrow().clone()) else { return };
            animate(FADE, SETTLING, || w.animator().setAlphaValue(0.0));
            later(&viewer, FADE, move || put_away(id));
        });
    }

    pub fn cancel() {
        if let Some(flight) = FLIGHT.with(|f| f.borrow_mut().take()) {
            put_away(flight.id);
            flown(&flight.source);
            if flight.reveal {
                if let Ok(v) = flight.viewer.ns_window() {
                    ns(v).setAlphaValue(1.0);
                }
            }
        }
    }

    /// Flies `picture` from `pic` in the closing `viewer` (or, with none,
    /// from a badge in the middle of `stage`, where it fades in as the
    /// viewer fades out) to `to` in `source`'s page.
    pub fn fly_out(
        viewer: &Window,
        source: &WebviewWindow,
        pic: Option<CssRect>,
        visible: f64,
        stage: CssRect,
        to: CssRect,
        picture: &Picture,
    ) -> bool {
        let (Ok(v), Ok(s)) = (viewer.ns_window(), source.ns_window()) else { return false };
        let (v, s) = (ns(v), ns(s));
        let Some(image) = image(picture) else { return false };
        let pic = pic.unwrap_or_else(|| landing_rect(Landing::Badge, image.size(), stage));
        let start = zoom::css_to_screen(v, v.frame(), pic);
        let end = zoom::css_to_screen(s, s.frame(), to);
        let Some((w, _)) = launch(start, picture) else { return false };
        let Some((_, layer)) = PANEL.with(|p| p.borrow().clone()) else { return false };
        let u = current_use();
        if visible < 1.0 {
            // Starts cut off as the page is, and grows whole on the way.
            CATransaction::begin();
            CATransaction::setDisableActions(true);
            layer.setContentsRect(crop(visible));
            CATransaction::commit();
            recrop(FLY_BACK, 1.0);
        }
        if matches!(picture, Picture::Icon(_)) {
            // Nothing in the viewer looks like the icon: it condenses out
            // of the page as that goes.
            w.setAlphaValue(0.0);
            animate(SETTLE, SETTLING, || w.animator().setAlphaValue(1.0));
        }
        animate(FADE_OUT, SETTLING, || v.animator().setAlphaValue(0.0));
        animate(FLY_BACK, SETTLING, || w.animator().setFrame_display(end, true));
        let src = source.clone();
        later(source, FLY_BACK, move || {
            let _ = src.emit_to(src.label(), "viewer:returned", ());
            later(&src, LINGER, move || put_away(u));
        });
        true
    }

    pub fn image_size(path: &Path) -> Option<(f64, f64)> {
        let s = CFString::from_str(&path.to_string_lossy());
        let url = CFURL::with_file_system_path(
            None,
            Some(&s),
            CFURLPathStyle::CFURLPOSIXPathStyle,
            false,
        )?;
        let src = unsafe { CGImageSource::with_url(&url, None) }?;
        let props = unsafe { src.properties_at_index(0, None) }?;
        // SAFETY: ImageIO property dictionaries have CFString keys.
        let props: CFRetained<CFDictionary<CFString, CFType>> =
            unsafe { CFRetained::cast_unchecked(props) };
        let num = |key: &CFString| {
            props
                .get(key)
                .and_then(|v| v.downcast::<CFNumber>().ok())
                .and_then(|n| n.as_f64())
        };
        let w = num(unsafe { kCGImagePropertyPixelWidth })?;
        let h = num(unsafe { kCGImagePropertyPixelHeight })?;
        let turned = num(unsafe { kCGImagePropertyOrientation }).is_some_and(|o| o >= 5.0);
        Some(if turned { (h, w) } else { (w, h) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAGE: CssRect = CssRect { x: 0.0, y: 40.0, w: 1000.0, h: 680.0 };

    #[test]
    fn a_big_image_shrinks_to_fit_its_stage_centred() {
        let r = fit(4000.0, 2000.0, STAGE, false);
        assert_eq!(r, CssRect { x: 0.0, y: 40.0 + 90.0, w: 1000.0, h: 500.0 });
    }

    #[test]
    fn a_small_image_keeps_its_size_unless_enlarged() {
        let r = fit(200.0, 100.0, STAGE, false);
        assert_eq!(r, CssRect { x: 400.0, y: 40.0 + 290.0, w: 200.0, h: 100.0 });
        let big = fit(200.0, 100.0, STAGE, true);
        assert_eq!(big.w, 1000.0);
    }
}
