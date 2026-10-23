//! Doftar's PDF viewer: one window whose web page draws only the toolbar.
//! The document itself is a native PDFKit view laid over the rest of the
//! window, so a PDF renders and scrolls as it does in Preview and no PDF
//! parsing runs in the web page. Like the image viewer, the window is made
//! hidden at launch and hidden again on close, so a PDF opens at once.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, WebviewWindow, Window};

use crate::fly::{Landing, Picture};
use crate::zoom::CssRect;

pub const LABEL: &str = "pdf";

/// Held while the window is looked up or made.
static OPENING: Mutex<()> = Mutex::new(());
/// Bumped on every open, so a close's zoom never hides a reopened window.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// What the toolbar shows; sent as `pdf:state` whenever it changes.
#[derive(serde::Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfState {
    path: Option<String>,
    /// Why the document isn't showing, when it isn't.
    error: Option<String>,
    /// The document needs a password before it shows.
    locked: bool,
    pages: usize,
    /// The page in view, from 0.
    page: usize,
    /// 1 is actual size.
    scale: f64,
    fit: bool,
    two_up: bool,
    thumbnails: bool,
    /// Whether the last search found anything; none before a search.
    found: Option<bool>,
}

/// A request from the toolbar.
#[derive(serde::Deserialize, Debug)]
#[serde(tag = "do", rename_all = "camelCase")]
pub enum PdfAction {
    /// Goes to page `index`, from 0.
    Page { index: usize },
    Step { delta: i64 },
    ZoomIn,
    ZoomOut,
    Fit,
    ActualSize,
    TwoUp { on: bool },
    Thumbnails { on: bool },
    Find { query: String, backwards: bool },
    Unlock { password: String },
    SelectAll,
    /// The toolbar's height in points; the document fills the window below it.
    Inset { top: f64 },
    Theme { dark: bool },
    /// Hands the keyboard to the document.
    Focus,
}

fn is_pdf(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

/// Makes the (hidden) PDF window. Callers hold `OPENING`.
fn build(app: &AppHandle) -> Result<WebviewWindow, String> {
    let mut cfg = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("no window config")?;
    cfg.label = LABEL.to_string();
    cfg.width = 900.0;
    cfg.height = 1000.0;
    cfg.min_width = Some(480.0);
    cfg.min_height = Some(320.0);
    cfg.center = true;
    cfg.visible = false;
    cfg.transparent = false;
    cfg.window_effects = None;
    let win = crate::webview::build(app, cfg)?;
    let w = win.clone();
    let _ = win.run_on_main_thread(move || native::install(&w));
    Ok(win)
}

/// Makes the PDF window ahead of time, hidden, so the first PDF opens at once.
pub fn prewarm(app: &AppHandle) {
    let _guard = OPENING.lock().unwrap();
    if app.get_webview_window(LABEL).is_none() {
        let _ = build(app);
    }
}

/// Shows the PDF at `path`, making the window if it isn't there.
/// `from` is where the calling page draws the file's icon: its thumbnail
/// flies from there onto the first page, or, without one, the window zooms
/// up from near it. Returns whether it flies, so the page knows to hide the
/// icon until it hears `viewer:flown`.
#[tauri::command]
pub async fn open_pdf(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
    from: Option<CssRect>,
) -> Result<bool, String> {
    if crate::watcher::is_ejecting(&path) {
        return Err("volume is being ejected".to_string());
    }
    let p = Path::new(&path);
    if !p.is_absolute() || !is_pdf(p) {
        return Err("not a PDF".into());
    }
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if crate::thumbs::is_dataless(&meta) {
        return Err("the file is not downloaded".into());
    }
    let flies = from.is_some() && !crate::zoom::reduce_motion();
    let flown = flies;
    crate::fly::set_opener(LABEL, from.map(|_| window.label().to_string()));
    let _guard = OPENING.lock().unwrap();
    GENERATION.fetch_add(1, Ordering::SeqCst);
    let win = match app.get_webview_window(LABEL) {
        Some(win) => win,
        None => build(&app)?,
    };
    let w = win.clone();
    win.run_on_main_thread(move || {
        crate::fly::cancel();
        native::open(&w, &path);
        if let (true, Some(from)) = (flies, from) {
            // The first page is drawn already: a picture of it, drawn by
            // PDFKit from the open document (so it is there at the very
            // first open, before the listing has made a thumbnail), flies
            // from the icon and lands on it. Without a page to land on
            // (unreadable, locked) it doesn't fly.
            if let (Some((rect, visible)), Some(page)) =
                (native::first_page(&w), native::page_picture())
            {
                let landing = Landing::Exact { rect, visible };
                if crate::fly::fly_in(&w, &window, from, &Picture::Data(page), landing) {
                    crate::fly::land(&w, Some(rect));
                    return;
                }
            }
            let _ = window.emit_to(window.label(), "viewer:flown", ());
        }
        if let Some(from) = from {
            crate::zoom::aim(&w, &window, from);
        }
        crate::zoom::show(&w);
    })
    .map_err(|e| e.to_string())?;
    Ok(flown)
}

/// Carries out a request from the toolbar.
#[tauri::command]
pub fn pdf_action(window: WebviewWindow, action: PdfAction) {
    let w = window.clone();
    let _ = window.run_on_main_thread(move || native::act(&w, action));
}

/// The toolbar's state, for a page that has just loaded.
#[tauri::command]
pub async fn pdf_state(window: WebviewWindow) -> PdfState {
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = window.run_on_main_thread(move || {
        let _ = tx.send(native::state());
    });
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// Closing flies the first page back into its thumbnail when the listing
/// it came from still shows it (and the page is in view), or else zooms the
/// window out; either way the window hides, then lets the document go. A
/// PDF opened meanwhile keeps it up. Runs on the main thread.
pub fn close_requested(win: &Window) {
    crate::fly::cancel();
    let generation = GENERATION.load(Ordering::SeqCst);
    let still_closing = move || GENERATION.load(Ordering::SeqCst) == generation;
    let picture = native::shown(win).and_then(|_| native::page_picture()).map(Picture::Data);
    let landing = Landing::Exact {
        rect: CssRect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 },
        visible: 1.0,
    };
    if !crate::fly::fly_back(win, picture, landing, still_closing, native::close) {
        crate::zoom::hide(win, still_closing, native::close);
    }
}

#[cfg(target_os = "macos")]
mod native {
    use std::cell::RefCell;
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSAutoresizingMaskOptions, NSColor, NSView, NSWindow, NSWorkspace};
    use objc2_foundation::{
        NSNotification, NSNotificationCenter, NSOperationQueue, NSPoint, NSRect, NSSize,
        NSString, NSStringCompareOptions, NSURL,
    };
    use objc2_pdf_kit::{
        PDFActionRemoteGoTo, PDFDisplayBox, PDFDisplayMode, PDFDocument, PDFThumbnailView,
        PDFView, PDFViewDelegate, PDFViewPageChangedNotification,
        PDFViewScaleChangedNotification,
    };
    use tauri::{Emitter, Manager, Runtime, WebviewWindow, Window};

    use super::{PdfAction, PdfState, LABEL};
    use crate::zoom::CssRect;

    const SIDEBAR: f64 = 168.0;
    /// The toolbar's height until the page says otherwise.
    const DEFAULT_TOP: f64 = 40.0;

    define_class!(
        /// Lets a PDF's links open web and mail addresses only. Left to
        /// itself PDFKit hands any URL to the system, which would let a
        /// document launch apps or open files with a click.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "DoftarPDFLinkGuard"]
        struct LinkGuard;

        unsafe impl NSObjectProtocol for LinkGuard {}

        unsafe impl PDFViewDelegate for LinkGuard {
            #[unsafe(method(PDFViewWillClickOnLink:withURL:))]
            fn will_click(&self, _sender: &PDFView, url: &NSURL) {
                let scheme = url.scheme().map(|s| s.to_string().to_ascii_lowercase());
                if matches!(scheme.as_deref(), Some("http" | "https" | "mailto")) {
                    NSWorkspace::sharedWorkspace().openURL(url);
                }
            }

            #[unsafe(method(PDFViewOpenPDF:forRemoteGoToAction:))]
            fn open_remote(&self, _sender: &PDFView, _action: &PDFActionRemoteGoTo) {}
        }
    );

    impl LinkGuard {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    struct Native {
        pdf: Retained<PDFView>,
        thumbs: Retained<PDFThumbnailView>,
        _guard: Retained<LinkGuard>,
        _observers: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
        path: Option<String>,
        error: Option<String>,
        top: f64,
        thumbnails: bool,
        found: Option<bool>,
    }

    thread_local! {
        /// The window's native views; only touched on the main thread.
        static NATIVE: RefCell<Option<Native>> = const { RefCell::new(None) };
    }

    fn ns_window<R: Runtime>(w: &impl HasNsWindow<R>) -> Option<&'static NSWindow> {
        w.ns().map(|p| unsafe { &*(p as *const NSWindow) })
    }

    /// Both window types give their NSWindow.
    pub trait HasNsWindow<R: Runtime> {
        fn ns(&self) -> Option<*mut std::ffi::c_void>;
    }
    impl<R: Runtime> HasNsWindow<R> for WebviewWindow<R> {
        fn ns(&self) -> Option<*mut std::ffi::c_void> {
            self.ns_window().ok()
        }
    }
    impl<R: Runtime> HasNsWindow<R> for Window<R> {
        fn ns(&self) -> Option<*mut std::ffi::c_void> {
            self.ns_window().ok()
        }
    }

    /// Lays the views out below the toolbar, the thumbnails (when shown) on the left.
    fn layout(n: &Native, content: &NSView) {
        let b = content.bounds();
        let h = (b.size.height - n.top).max(0.0);
        let y = if content.isFlipped() { n.top } else { 0.0 };
        let side = if n.thumbnails { SIDEBAR } else { 0.0 };
        n.thumbs.setFrame(NSRect::new(NSPoint::new(0.0, y), NSSize::new(side, h)));
        n.thumbs.setHidden(!n.thumbnails || n.path.is_none());
        n.pdf.setFrame(NSRect::new(
            NSPoint::new(side, y),
            NSSize::new((b.size.width - side).max(0.0), h),
        ));
    }

    fn with<T>(f: impl FnOnce(&mut Native) -> T) -> Option<T> {
        NATIVE.with(|cell| cell.borrow_mut().as_mut().map(f))
    }

    /// Reads the views unless they are being changed right now: PDFKit
    /// announces a page change from inside `setDocument` and `goToPage`, and
    /// whatever changed them sends the state itself once done.
    fn peek<T>(f: impl FnOnce(&Native) -> T) -> Option<T> {
        NATIVE.with(|cell| cell.try_borrow().ok()?.as_ref().map(f))
    }

    /// Adds the native views to the window. Runs on the main thread.
    pub fn install(win: &WebviewWindow) {
        let Some(mtm) = MainThreadMarker::new() else { return };
        if NATIVE.with(|c| c.borrow().is_some()) {
            return;
        }
        let Some(content) = ns_window(win).and_then(|w| w.contentView()) else { return };
        let zero = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
        let pdf = unsafe { PDFView::initWithFrame(PDFView::alloc(mtm), zero) };
        let thumbs = unsafe { PDFThumbnailView::initWithFrame(PDFThumbnailView::alloc(mtm), zero) };
        let guard = LinkGuard::new(mtm);
        unsafe {
            pdf.setAutoScales(true);
            pdf.setDisplayMode(PDFDisplayMode::SinglePageContinuous);
            pdf.setDelegate(Some(ProtocolObject::from_ref(&*guard)));
            thumbs.setPDFView(Some(&pdf));
            thumbs.setThumbnailSize(NSSize::new(SIDEBAR - 44.0, SIDEBAR));
        }
        type Mask = NSAutoresizingMaskOptions;
        pdf.setAutoresizingMask(Mask::ViewWidthSizable | Mask::ViewHeightSizable);
        thumbs.setAutoresizingMask(Mask::ViewHeightSizable | Mask::ViewMaxXMargin);
        pdf.setHidden(true);
        content.addSubview(&thumbs);
        content.addSubview(&pdf);

        // Page and zoom changes reach the toolbar once the change is done.
        let app = win.app_handle().clone();
        let center = NSNotificationCenter::defaultCenter();
        let queue = NSOperationQueue::mainQueue();
        let observers = [unsafe { PDFViewPageChangedNotification }, unsafe {
            PDFViewScaleChangedNotification
        }]
        .into_iter()
        .map(|name| {
            let app = app.clone();
            let block = RcBlock::new(move |_: NonNull<NSNotification>| {
                let app = app.clone();
                let _ = app.clone().run_on_main_thread(move || send(&app));
            });
            unsafe {
                center.addObserverForName_object_queue_usingBlock(
                    Some(name),
                    Some(&*pdf as &AnyObject),
                    Some(&queue),
                    &block,
                )
            }
        })
        .collect();

        let native = Native {
            pdf,
            thumbs,
            _guard: guard,
            _observers: observers,
            path: None,
            error: None,
            top: DEFAULT_TOP,
            thumbnails: false,
            found: None,
        };
        layout(&native, &content);
        NATIVE.with(|c| *c.borrow_mut() = Some(native));
    }

    pub fn state() -> PdfState {
        peek(|n| {
            let doc = unsafe { n.pdf.document() };
            let locked = doc.as_ref().is_some_and(|d| unsafe { d.isLocked() });
            let pages = doc.as_ref().map_or(0, |d| unsafe { d.pageCount() });
            let page = doc
                .as_ref()
                .zip(unsafe { n.pdf.currentPage() })
                .map_or(0, |(d, p)| unsafe { d.indexForPage(&p) });
            PdfState {
                path: n.path.clone(),
                error: n.error.clone(),
                locked,
                pages,
                page,
                scale: unsafe { n.pdf.scaleFactor() },
                fit: unsafe { n.pdf.autoScales() },
                two_up: unsafe { n.pdf.displayMode() } == PDFDisplayMode::TwoUpContinuous,
                thumbnails: n.thumbnails,
                found: n.found,
            }
        })
        .unwrap_or_default()
    }

    fn send<R: Runtime>(app: &tauri::AppHandle<R>) {
        if NATIVE.with(|cell| cell.try_borrow().is_ok()) {
            let _ = app.emit_to(LABEL, "pdf:state", state());
        }
    }

    /// Shows the document whichever way it turned out: the view for a
    /// readable one, the page's message or password box otherwise.
    fn refresh(n: &Native, win: &NSWindow) {
        let doc = unsafe { n.pdf.document() };
        let readable = doc.is_some_and(|d| !unsafe { d.isLocked() });
        n.pdf.setHidden(!readable);
        if let Some(content) = win.contentView() {
            layout(n, &content);
        }
        if readable {
            win.makeFirstResponder(Some(&n.pdf));
        }
    }

    /// The document view's frame as a CSS rect in the window: the stage a
    /// flight lands in.
    fn stage(n: &Native, content: &NSView) -> CssRect {
        let b = content.bounds();
        let f = n.pdf.frame();
        let y = if content.isFlipped() { f.origin.y } else { b.size.height - f.origin.y - f.size.height };
        CssRect { x: f.origin.x, y, w: f.size.width, h: f.size.height }
    }

    /// Where the first page is drawn, as a CSS rect in the window cut to the
    /// document view, and how much of the page that shows from its top; none
    /// without a readable document, or with the page mostly out of view.
    /// Tells the flight what the window shows meanwhile. Runs on the main
    /// thread.
    pub fn first_page<R: Runtime>(win: &impl HasNsWindow<R>) -> Option<(CssRect, f64)> {
        let ns = ns_window(win)?;
        let content = ns.contentView()?;
        with(|n| {
            let doc = unsafe { n.pdf.document() }?;
            if unsafe { d_locked(&doc) } || n.pdf.isHidden() {
                return None;
            }
            let page = unsafe { doc.pageAtIndex(0) }?;
            unsafe { n.pdf.layoutDocumentView() };
            let bounds = unsafe { page.boundsForBox(PDFDisplayBox::CropBox) };
            let in_view = unsafe { n.pdf.convertRect_fromPage(bounds, &page) };
            let in_window = n.pdf.convertRect_toView(in_view, None);
            let b = content.bounds();
            // Top-left origin, as a page measures.
            let full = CssRect {
                x: in_window.origin.x,
                y: b.size.height - in_window.origin.y - in_window.size.height,
                w: in_window.size.width,
                h: in_window.size.height,
            };
            let stage = stage(n, &content);
            let x0 = full.x.max(stage.x);
            let y0 = full.y.max(stage.y);
            let x1 = (full.x + full.w).min(stage.x + stage.w);
            let y1 = (full.y + full.h).min(stage.y + stage.h);
            let shown = (x1 > x0 && y1 > y0).then(|| CssRect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
            let path = n.path.clone();
            // Only a page cut off at the bottom alone flies true: the panel
            // shows the top of the thumbnail.
            let page = shown.filter(|r| {
                r.y == full.y && r.x == full.x && (r.w - full.w).abs() < 0.5 && r.h >= full.h * 0.3
            });
            let visible = page.map_or(1.0, |r| (r.h / full.h).min(1.0));
            crate::fly::set_shown(LABEL, path, page, visible, stage);
            page.map(|r| (r, visible))
        })
        .flatten()
    }

    unsafe fn d_locked(doc: &PDFDocument) -> bool {
        unsafe { doc.isLocked() }
    }

    /// The longer side of the picture of page 1 that flies, in pixels.
    const PICTURE_PX: f64 = 320.0;

    /// A picture of the first page, as TIFF data, drawn by PDFKit from the
    /// open document. Runs on the main thread.
    pub fn page_picture() -> Option<Vec<u8>> {
        with(|n| {
            let doc = unsafe { n.pdf.document() }?;
            if unsafe { d_locked(&doc) } {
                return None;
            }
            let page = unsafe { doc.pageAtIndex(0) }?;
            let b = unsafe { page.boundsForBox(PDFDisplayBox::CropBox) };
            if b.size.width <= 0.0 || b.size.height <= 0.0 {
                return None;
            }
            let k = PICTURE_PX / b.size.width.max(b.size.height);
            let size = NSSize::new((b.size.width * k).round(), (b.size.height * k).round());
            let image = unsafe { page.thumbnailOfSize_forBox(size, PDFDisplayBox::CropBox) };
            image.TIFFRepresentation().map(|d| d.to_vec())
        })
        .flatten()
    }

    /// The document shown, for its picture; refreshes where it is drawn.
    pub fn shown(win: &Window) -> Option<String> {
        first_page(win).map(|_| ()).and_then(|_| with(|n| n.path.clone()).flatten())
    }

    /// Loads `path` into the window, which the caller then shows. Runs on
    /// the main thread.
    pub fn open(win: &WebviewWindow, path: &str) {
        install(win);
        let Some(ns) = ns_window(win) else { return };
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let doc = unsafe { PDFDocument::initWithURL(PDFDocument::alloc(), &url) };
        with(|n| {
            n.path = Some(path.to_string());
            n.found = None;
            n.error = doc.is_none().then(|| "Doftar can't read this PDF".to_string());
            unsafe {
                n.pdf.setDocument(doc.as_deref());
                n.pdf.setAutoScales(true);
                n.pdf.clearSelection();
            }
            refresh(n, ns);
        });
        let title = std::path::Path::new(path)
            .file_name()
            .map_or_else(|| path.to_string(), |n| n.to_string_lossy().into_owned());
        let _ = win.set_title(&title);
        send(win.app_handle());
    }

    /// Lets the document go once the window has hidden. Runs on the main thread.
    pub fn close(win: &Window) {
        with(|n| {
            unsafe { n.pdf.setDocument(None) };
            n.path = None;
            n.error = None;
            n.found = None;
            n.pdf.setHidden(true);
            n.thumbs.setHidden(true);
        });
        send(win.app_handle());
    }

    /// Carries out a toolbar request. Runs on the main thread.
    pub fn act(win: &WebviewWindow, action: PdfAction) {
        let Some(ns) = ns_window(win) else { return };
        with(|n| {
            let doc = unsafe { n.pdf.document() };
            match action {
                PdfAction::Page { index } => {
                    if let Some(page) = doc.and_then(|d| unsafe { d.pageAtIndex(index) }) {
                        unsafe { n.pdf.goToPage(&page) };
                    }
                }
                PdfAction::Step { delta } => {
                    if let Some(d) = doc {
                        let count = unsafe { d.pageCount() } as i64;
                        let at = unsafe { n.pdf.currentPage() }
                            .map_or(0, |p| unsafe { d.indexForPage(&p) } as i64);
                        let to = (at + delta).clamp(0, (count - 1).max(0)) as usize;
                        if let Some(page) = unsafe { d.pageAtIndex(to) } {
                            unsafe { n.pdf.goToPage(&page) };
                        }
                    }
                }
                PdfAction::ZoomIn => unsafe {
                    if n.pdf.canZoomIn() {
                        n.pdf.zoomIn(None);
                    }
                },
                PdfAction::ZoomOut => unsafe {
                    if n.pdf.canZoomOut() {
                        n.pdf.zoomOut(None);
                    }
                },
                PdfAction::Fit => unsafe { n.pdf.setAutoScales(true) },
                PdfAction::ActualSize => unsafe {
                    n.pdf.setAutoScales(false);
                    n.pdf.setScaleFactor(1.0);
                },
                PdfAction::TwoUp { on } => unsafe {
                    n.pdf.setDisplayMode(if on {
                        PDFDisplayMode::TwoUpContinuous
                    } else {
                        PDFDisplayMode::SinglePageContinuous
                    });
                },
                PdfAction::Thumbnails { on } => {
                    n.thumbnails = on;
                    refresh(n, ns);
                }
                PdfAction::Find { query, backwards } => {
                    n.found = None;
                    if let (Some(d), false) = (doc, query.is_empty()) {
                        let mut options = NSStringCompareOptions::CaseInsensitiveSearch;
                        if backwards {
                            options |= NSStringCompareOptions::BackwardsSearch;
                        }
                        let q = NSString::from_str(&query);
                        let from = unsafe { n.pdf.currentSelection() };
                        // Wraps round to the other end when nothing is left that way.
                        let find = |from: Option<&objc2_pdf_kit::PDFSelection>| unsafe {
                            d.findString_fromSelection_withOptions(&q, from, options)
                        };
                        let hit = find(from.as_deref()).or_else(|| find(None));
                        n.found = Some(hit.is_some());
                        if let Some(sel) = hit {
                            unsafe {
                                n.pdf.setCurrentSelection_animate(Some(&sel), true);
                                n.pdf.goToSelection(&sel);
                            }
                        }
                    }
                }
                PdfAction::Unlock { password } => {
                    let password = NSString::from_str(&password);
                    let ok = doc.is_some_and(|d| unsafe { d.unlockWithPassword(&password) });
                    n.error = (!ok).then(|| "That password didn't open it".to_string());
                    if ok {
                        unsafe { n.pdf.layoutDocumentView() };
                    }
                    refresh(n, ns);
                }
                PdfAction::SelectAll => unsafe { n.pdf.selectAll(None) },
                PdfAction::Inset { top } => {
                    n.top = top.max(0.0);
                    if let Some(content) = ns.contentView() {
                        layout(n, &content);
                    }
                }
                PdfAction::Theme { dark } => {
                    // Matches the image viewer's stage.
                    let (r, g, b) = if dark { (0x1d, 0x20, 0x27) } else { (0xe8, 0xe8, 0xe8) };
                    let c = |v: u8| f64::from(v) / 255.0;
                    let color = NSColor::colorWithSRGBRed_green_blue_alpha(c(r), c(g), c(b), 1.0);
                    unsafe {
                        n.pdf.setBackgroundColor(&color);
                        n.thumbs.setBackgroundColor(Some(&color));
                    }
                }
                PdfAction::Focus => {
                    if !n.pdf.isHidden() {
                        ns.makeFirstResponder(Some(&n.pdf));
                    }
                }
            }
        });
        send(win.app_handle());
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use super::{PdfAction, PdfState};
    use tauri::{WebviewWindow, Window};

    pub fn install(_: &WebviewWindow) {}
    pub fn open(_: &WebviewWindow, _: &str) {}
    pub fn close(_: &Window) {}
    pub fn first_page(_: &WebviewWindow) -> Option<(crate::zoom::CssRect, f64)> {
        None
    }
    pub fn page_picture() -> Option<Vec<u8>> {
        None
    }
    pub fn shown(_: &Window) -> Option<String> {
        None
    }
    pub fn act(_: &WebviewWindow, _: PdfAction) {}
    pub fn state() -> PdfState {
        PdfState { error: Some("PDFs need macOS".into()), ..Default::default() }
    }
}
