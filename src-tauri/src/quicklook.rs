//! Quick Look for the selection, in macOS's own preview panel as Finder shows
//! it. Tapping Space opens it and tapping again (or Escape) closes it;
//! holding Space peeks, closing it when Space is let go.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use tauri::AppHandle;

const MAX_ITEMS: usize = 50;
/// Space held longer than this peeks: the preview closes when it is let go.
const HOLD: Duration = Duration::from_millis(400);
const POLL: Duration = Duration::from_millis(20);

static APP: OnceLock<AppHandle> = OnceLock::new();
/// Bumped on every open and close, so a peek's release only closes its own preview.
static GENERATION: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "macos")]
mod keys {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
    }
    const COMBINED_SESSION_STATE: i32 = 0;
    const VK_SPACE: u16 = 49;

    pub fn space_down() -> bool {
        unsafe { CGEventSourceKeyState(COMBINED_SESSION_STATE, VK_SPACE) }
    }
}

#[cfg(not(target_os = "macos"))]
mod keys {
    pub fn space_down() -> bool {
        false
    }
}

/// Lets Quick Look be closed from anywhere (ejecting, hiding the main window).
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

/// Opens the preview for `paths`, or closes it if it is already showing.
#[tauri::command]
pub fn quicklook(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    init(&app);
    let paths: Vec<String> = paths
        .into_iter()
        .filter(|p| p.starts_with('/') && std::path::Path::new(p).exists())
        .take(MAX_ITEMS)
        .collect();
    if paths.is_empty() {
        return Err("nothing to preview".into());
    }
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(native::toggle(&paths));
    })
    .map_err(|e| e.to_string())?;

    thread::spawn(move || {
        if !rx.recv_timeout(Duration::from_secs(2)).unwrap_or(false) {
            return;
        }
        let start = Instant::now();
        while start.elapsed() < HOLD {
            if !keys::space_down() {
                return;
            }
            thread::sleep(POLL);
        }
        while keys::space_down() {
            thread::sleep(POLL);
        }
        if GENERATION.load(Ordering::SeqCst) == generation {
            quicklook_close();
        }
    });
    Ok(())
}

#[tauri::command]
pub fn quicklook_close() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Some(app) = APP.get() {
        let _ = app.run_on_main_thread(native::close);
    }
}

#[cfg(target_os = "macos")]
mod native {
    use std::cell::{OnceCell, RefCell};
    use std::ffi::CStr;

    use objc2::rc::Retained;
    use objc2::runtime::{
        AnyClass, AnyObject, Bool, Imp, NSObject, NSObjectProtocol, ProtocolObject, Sel,
    };
    use objc2::{define_class, msg_send, sel, MainThreadMarker, MainThreadOnly};
    use objc2_foundation::{NSInteger, NSString, NSURL};
    use objc2_quick_look_ui::{QLPreviewItem, QLPreviewPanel, QLPreviewPanelDataSource};

    thread_local! {
        /// What the panel shows; only touched on the main thread.
        static ITEMS: RefCell<Vec<Retained<NSURL>>> = const { RefCell::new(Vec::new()) };
        static SOURCE: OnceCell<Retained<Source>> = const { OnceCell::new() };
    }

    define_class!(
        /// Hands the panel the files to preview.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "DoftarQuickLookSource"]
        struct Source;

        unsafe impl NSObjectProtocol for Source {}

        unsafe impl QLPreviewPanelDataSource for Source {
            #[unsafe(method(numberOfPreviewItemsInPreviewPanel:))]
            fn count(&self, _panel: Option<&QLPreviewPanel>) -> NSInteger {
                ITEMS.with(|i| i.borrow().len() as NSInteger)
            }

            #[unsafe(method_id(previewPanel:previewItemAtIndex:))]
            fn item(
                &self,
                _panel: Option<&QLPreviewPanel>,
                index: NSInteger,
            ) -> Option<Retained<ProtocolObject<dyn QLPreviewItem>>> {
                let at = usize::try_from(index).ok();
                let url = ITEMS.with(|i| at.and_then(|at| i.borrow().get(at).cloned()));
                url.map(ProtocolObject::from_retained)
            }
        }
    );

    fn source(mtm: MainThreadMarker) -> Retained<Source> {
        SOURCE.with(|s| {
            s.get_or_init(|| {
                let this = Source::alloc(mtm).set_ivars(());
                unsafe { msg_send![super(this), init] }
            })
            .clone()
        })
    }

    // Quick Look finds who controls the panel by asking the key window's
    // responder chain. Doftar's windows are tao's, so the three controller
    // methods are added to tao's window class.
    unsafe extern "C-unwind" fn accepts(_: &AnyObject, _: Sel, _: *mut AnyObject) -> Bool {
        Bool::YES
    }

    unsafe extern "C-unwind" fn begin(_: &AnyObject, _: Sel, panel: *mut AnyObject) {
        let panel = (panel as *const QLPreviewPanel).as_ref();
        let (Some(mtm), Some(panel)) = (MainThreadMarker::new(), panel) else {
            return;
        };
        let source = source(mtm);
        panel.setDataSource(Some(ProtocolObject::from_ref(&*source)));
    }

    unsafe extern "C-unwind" fn end(_: &AnyObject, _: Sel, panel: *mut AnyObject) {
        if let Some(panel) = (panel as *const QLPreviewPanel).as_ref() {
            panel.setDataSource(None);
        }
    }

    fn adopt_controller() {
        thread_local! { static DONE: OnceCell<()> = const { OnceCell::new() }; }
        DONE.with(|d| {
            d.get_or_init(|| {
                let Some(class) = AnyClass::get(c"TaoWindow") else { return };
                let class = class as *const AnyClass as *mut AnyClass;
                let add = |name: Sel, imp: Imp, types: &CStr| unsafe {
                    objc2::ffi::class_addMethod(class, name, imp, types.as_ptr());
                };
                unsafe {
                    add(
                        sel!(acceptsPreviewPanelControl:),
                        std::mem::transmute::<
                            unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> Bool,
                            Imp,
                        >(accepts),
                        c"B@:@",
                    );
                    type Hook = unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject);
                    let hook = |f: Hook| std::mem::transmute::<Hook, Imp>(f);
                    add(sel!(beginPreviewPanelControl:), hook(begin), c"v@:@");
                    add(sel!(endPreviewPanelControl:), hook(end), c"v@:@");
                }
            });
        });
    }

    /// Opens the panel on `paths`, or closes it when it is showing. Returns
    /// whether it opened. Runs on the main thread.
    pub fn toggle(paths: &[String]) -> bool {
        let Some(mtm) = MainThreadMarker::new() else { return false };
        adopt_controller();
        let panel = unsafe { QLPreviewPanel::sharedPreviewPanel(mtm) };
        let Some(panel) = panel else { return false };
        if panel.isVisible() {
            panel.orderOut(None);
            return false;
        }
        ITEMS.with(|i| {
            *i.borrow_mut() = paths
                .iter()
                .map(|p| NSURL::fileURLWithPath(&NSString::from_str(p)))
                .collect();
        });
        unsafe {
            panel.updateController();
            if panel.dataSource().is_none() {
                let source = source(mtm);
                panel.setDataSource(Some(ProtocolObject::from_ref(&*source)));
            }
            panel.reloadData();
            panel.setCurrentPreviewItemIndex(0);
        }
        panel.makeKeyAndOrderFront(None);
        true
    }

    /// Closes the panel if it is showing. Runs on the main thread.
    pub fn close() {
        let Some(mtm) = MainThreadMarker::new() else { return };
        if !unsafe { QLPreviewPanel::sharedPreviewPanelExists(mtm) } {
            return;
        }
        if let Some(panel) = unsafe { QLPreviewPanel::sharedPreviewPanel(mtm) } {
            if panel.isVisible() {
                panel.orderOut(None);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    pub fn toggle(_: &[String]) -> bool {
        false
    }
    pub fn close() {}
}

