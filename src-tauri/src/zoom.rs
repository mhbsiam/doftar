//! How the viewer windows (images, the reader, PDFs) come and go: opening
//! zooms a window up from a little smaller as it fades in, and closing zooms
//! it back down as it fades out. AppKit animates the window frame and the
//! window server draws it, so it stays smooth however busy the page is; the
//! page and the PDF view simply follow the frame. "Reduce motion" turns it off.
//! Maximizing and restoring a window glides its frame the same way. An image
//! opened from a listing flies out of its thumbnail instead (see `fly`).

use std::sync::OnceLock;
use std::time::Duration;

use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow, Window};

/// How long a window takes to zoom in, and out.
const OPEN: Duration = Duration::from_millis(240);
const CLOSE: Duration = Duration::from_millis(190);
/// How long a window takes to grow to fill the screen, or shrink back.
const GLIDE: Duration = Duration::from_millis(260);
/// The size a window zooms in from and out to, against its own.
const FROM: f64 = 0.86;
/// How far towards the item it was opened from a window starts its zoom.
const AIM_PULL: f64 = 0.35;

/// A rect in CSS pixels from a window's top-left, as a page measures it.
#[derive(serde::Deserialize, serde::Serialize, Clone, Copy, Debug, PartialEq)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The factor in `DOFTAR_SLOW_MOTION` (1 when unset), for tuning motion by eye.
pub fn scale() -> f64 {
    static SCALE: OnceLock<f64> = OnceLock::new();
    *SCALE.get_or_init(|| {
        std::env::var("DOFTAR_SLOW_MOTION")
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v >= 1.0)
            .unwrap_or(1.0)
    })
}

/// `d`, slowed down by `DOFTAR_SLOW_MOTION`.
pub fn slow(d: Duration) -> Duration {
    d.mul_f64(scale())
}

/// So the page's animations slow down with the windows'.
#[tauri::command]
pub fn motion_scale() -> f64 {
    scale()
}

#[cfg(target_os = "macos")]
pub(crate) mod mac {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::time::Duration;

    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAnimatablePropertyContainer, NSAnimationContext, NSScreen, NSWindow};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use objc2_quartz_core::{
        kCAMediaTimingFunctionEaseIn, kCAMediaTimingFunctionEaseInEaseOut,
        kCAMediaTimingFunctionEaseOut, CAMediaTimingFunction,
    };

    use super::{slow, CssRect, AIM_PULL, FROM};

    thread_local! {
        /// The frame each window rests at while it is zoomed down, by NSWindow
        /// address; only touched on the main thread.
        static RESTING: RefCell<HashMap<usize, NSRect>> = RefCell::new(HashMap::new());
        /// Where on screen each window's next zoom in comes from, by NSWindow
        /// address, when it was opened from an item in a listing.
        static AIM: RefCell<HashMap<usize, NSPoint>> = RefCell::new(HashMap::new());
    }

    fn key(ns: &NSWindow) -> usize {
        ns as *const NSWindow as usize
    }

    /// `frame` scaled down about its centre, then pulled towards `aim`.
    fn shrunk(frame: NSRect, aim: Option<NSPoint>) -> NSRect {
        let mut r = frame;
        r.size.width *= FROM;
        r.size.height *= FROM;
        r.origin.x += (frame.size.width - r.size.width) / 2.0;
        r.origin.y += (frame.size.height - r.size.height) / 2.0;
        if let Some(p) = aim {
            r.origin.x += (p.x - (frame.origin.x + frame.size.width / 2.0)) * AIM_PULL;
            r.origin.y += (p.y - (frame.origin.y + frame.size.height / 2.0)) * AIM_PULL;
        }
        r
    }

    pub fn reduce_motion() -> bool {
        objc2_app_kit::NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceMotion()
    }

    /// `r`, measured in CSS pixels from the top-left of `ns`'s page while the
    /// window sits at `frame`, in AppKit screen points (bottom-up). The page
    /// fills the window, title bar included.
    pub fn css_to_screen(ns: &NSWindow, frame: NSRect, r: CssRect) -> NSRect {
        let content = ns.contentRectForFrameRect(frame);
        NSRect::new(
            NSPoint::new(content.origin.x + r.x, content.origin.y + content.size.height - r.y - r.h),
            NSSize::new(r.w, r.h),
        )
    }

    /// The frame `ns` comes to rest at: its own, or the one from before a
    /// zoom out that is still running.
    pub fn resting(ns: &NSWindow) -> NSRect {
        RESTING.with(|r| r.borrow().get(&key(ns)).copied()).unwrap_or_else(|| ns.frame())
    }

    pub fn aim(ns: &NSWindow, at: NSPoint) {
        AIM.with(|a| a.borrow_mut().insert(key(ns), at));
    }

    fn animate(ns: &NSWindow, frame: NSRect, alpha: f64, over: Duration, opening: bool) {
        NSAnimationContext::beginGrouping();
        let ctx = NSAnimationContext::currentContext();
        ctx.setDuration(slow(over).as_secs_f64());
        let curve = unsafe {
            if opening {
                kCAMediaTimingFunctionEaseOut
            } else {
                kCAMediaTimingFunctionEaseIn
            }
        };
        ctx.setTimingFunction(Some(&CAMediaTimingFunction::functionWithName(curve)));
        let a = ns.animator();
        a.setFrame_display(frame, true);
        a.setAlphaValue(alpha);
        NSAnimationContext::endGrouping();
    }

    /// Readies a window to zoom in: a hidden one starts small and clear.
    /// Returns the frame it zooms to.
    pub fn before_show(ns: &NSWindow) -> NSRect {
        let frame = RESTING
            .with(|r| r.borrow_mut().remove(&key(ns)))
            .unwrap_or_else(|| ns.frame());
        let aim = AIM.with(|a| a.borrow_mut().remove(&key(ns)));
        if reduce_motion() {
            ns.setFrame_display(frame, false);
            ns.setAlphaValue(1.0);
        } else if !ns.isVisible() {
            ns.setFrame_display(shrunk(frame, aim), false);
            ns.setAlphaValue(0.0);
        }
        frame
    }

    /// Readies a hidden window to fade in where it rests, with nothing
    /// shown, while something flies in over it.
    pub fn before_fade_in(ns: &NSWindow) {
        let frame = RESTING
            .with(|r| r.borrow_mut().remove(&key(ns)))
            .unwrap_or_else(|| ns.frame());
        AIM.with(|a| a.borrow_mut().remove(&key(ns)));
        ns.setFrame_display(frame, false);
        ns.setAlphaValue(0.0);
    }

    pub fn after_show(ns: &NSWindow, frame: NSRect) {
        if !reduce_motion() {
            animate(ns, frame, 1.0, super::OPEN, true);
        }
    }

    /// Starts zooming a window out; returns how long until it can hide.
    pub fn zoom_out(ns: &NSWindow) -> Duration {
        if reduce_motion() {
            return Duration::ZERO;
        }
        // A second close keeps the size from before the first.
        let frame = RESTING.with(|r| *r.borrow_mut().entry(key(ns)).or_insert_with(|| ns.frame()));
        animate(ns, shrunk(frame, None), 0.0, super::CLOSE, false);
        slow(super::CLOSE)
    }

    /// Glides a window to a frame given in points from the top-left of the main
    /// screen; false when it can't (not on the main thread).
    pub fn glide(ns: &NSWindow, x: f64, y: f64, width: f64, height: f64) -> bool {
        let Some(mtm) = MainThreadMarker::new() else {
            return false;
        };
        let Some(main) = NSScreen::screens(mtm).firstObject() else {
            return false;
        };
        // AppKit measures up from the bottom of the main screen.
        let bottom = main.frame().size.height - y - height;
        let frame = NSRect::new(NSPoint::new(x, bottom), NSSize::new(width, height));
        NSAnimationContext::beginGrouping();
        let ctx = NSAnimationContext::currentContext();
        ctx.setDuration(slow(super::GLIDE).as_secs_f64());
        let curve = unsafe { kCAMediaTimingFunctionEaseInEaseOut };
        ctx.setTimingFunction(Some(&CAMediaTimingFunction::functionWithName(curve)));
        ns.animator().setFrame_display(frame, true);
        NSAnimationContext::endGrouping();
        true
    }

    /// Puts a hidden window back to its own size, ready to zoom in again.
    pub fn rest(ns: &NSWindow) {
        if let Some(frame) = RESTING.with(|r| r.borrow_mut().remove(&key(ns))) {
            ns.setFrame_display(frame, false);
        }
        ns.setAlphaValue(1.0);
    }
}

/// Whether "Reduce motion" is on; windows then just appear and go.
pub fn reduce_motion() -> bool {
    #[cfg(target_os = "macos")]
    return mac::reduce_motion();
    #[cfg(not(target_os = "macos"))]
    false
}

#[cfg(target_os = "macos")]
pub(crate) fn ns(ptr: *mut std::ffi::c_void) -> &'static objc2_app_kit::NSWindow {
    unsafe { &*(ptr as *const objc2_app_kit::NSWindow) }
}

/// Moves and resizes `win`, gliding there unless "Reduce motion" is on. Runs
/// on the main thread.
pub fn set_frame(
    win: &WebviewWindow,
    pos: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    if let (Ok(p), Ok(scale)) = (win.ns_window(), win.scale_factor()) {
        let pt = |v: f64| v / scale;
        if !mac::reduce_motion()
            && mac::glide(
                ns(p),
                pt(pos.x as f64),
                pt(pos.y as f64),
                pt(size.width as f64),
                pt(size.height as f64),
            )
        {
            return Ok(());
        }
    }
    win.set_position(pos)?;
    win.set_size(size)
}

/// Makes `win`'s next zoom in start a little towards `from`, the item in
/// `source`'s page it was opened from. Runs on the main thread.
pub fn aim(win: &WebviewWindow, source: &WebviewWindow, from: CssRect) {
    #[cfg(target_os = "macos")]
    if let (Ok(w), Ok(s)) = (win.ns_window(), source.ns_window()) {
        let s = ns(s);
        let r = mac::css_to_screen(s, s.frame(), from);
        let centre = objc2_foundation::NSPoint::new(
            r.origin.x + r.size.width / 2.0,
            r.origin.y + r.size.height / 2.0,
        );
        mac::aim(ns(w), centre);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (win, source, from);
}

/// Shows `win` zooming in (or back up, if a close is still zooming it out)
/// and gives it the keyboard. Runs on the main thread.
pub fn show(win: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    let target = win.ns_window().ok().map(|p| (ns(p), mac::before_show(ns(p))));
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    #[cfg(target_os = "macos")]
    if let Some((ns, frame)) = target {
        mac::after_show(ns, frame);
    }
}

/// Shows the calling window zooming in: for a viewer page that shows itself
/// once its first file has painted. `pic` is where the page drew its image,
/// so a thumbnail flying in can settle onto it exactly.
#[tauri::command]
pub fn show_zoomed(window: WebviewWindow, pic: Option<CssRect>) {
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        if !crate::fly::land(&w, pic) {
            show(&w);
        }
    });
}

/// Zooms `win` out, then hides it and runs `hidden`, unless `still_closing`
/// says it was opened again meanwhile. Runs on the main thread.
pub fn hide(
    win: &Window,
    still_closing: impl Fn() -> bool + Send + 'static,
    hidden: impl FnOnce(&Window) + Send + 'static,
) {
    #[cfg(target_os = "macos")]
    let wait = win.ns_window().map_or(Duration::ZERO, |p| mac::zoom_out(ns(p)));
    #[cfg(not(target_os = "macos"))]
    let wait = Duration::ZERO;
    hide_after(win, wait, still_closing, hidden);
}

/// Hides `win` after `wait` and runs `hidden`, unless `still_closing` says it
/// was opened again meanwhile.
pub fn hide_after(
    win: &Window,
    wait: Duration,
    still_closing: impl Fn() -> bool + Send + 'static,
    hidden: impl FnOnce(&Window) + Send + 'static,
) {
    let win = win.clone();
    std::thread::spawn(move || {
        std::thread::sleep(wait);
        let w = win.clone();
        let _ = win.run_on_main_thread(move || {
            if !still_closing() {
                return;
            }
            let _ = w.hide();
            #[cfg(target_os = "macos")]
            if let Ok(p) = w.ns_window() {
                mac::rest(ns(p));
            }
            hidden(&w);
        });
    });
}
