//! The Dock icon's right-click menu. macOS adds the window list, Options, Hide and Quit to it.

use std::cell::OnceCell;
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, NSObject, NSObjectProtocol, Sel};
use objc2::{define_class, msg_send, sel, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
use objc2_foundation::NSString;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Each item opens a new window. Its place is empty for the Home page, an absolute path, or a folder in the home folder.
const ITEMS: [(&str, &str); 5] = [
    ("New Window", ""),
    ("Desktop", "Desktop"),
    ("Documents", "Documents"),
    ("Downloads", "Downloads"),
    ("Applications", "/Applications"),
];

static APP: OnceLock<AppHandle> = OnceLock::new();

thread_local! {
    /// Only touched on the main thread. A menu item does not retain its target.
    static MENU: OnceCell<(Retained<Target>, Retained<NSMenu>)> = const { OnceCell::new() };
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DoftarDockTarget"]
    struct Target;

    unsafe impl NSObjectProtocol for Target {}

    impl Target {
        #[unsafe(method(dockItem:))]
        fn dock_item(&self, sender: &NSMenuItem) {
            let (Some(app), Some((_, place))) =
                (APP.get(), ITEMS.get(sender.tag() as usize))
            else {
                return;
            };
            // The user may be in another app, and the new window should come up in front of it.
            #[allow(deprecated)] // `activate` only asks. This must come to the front.
            NSApplication::sharedApplication(self.mtm()).activateIgnoringOtherApps(true);
            if let Some(win) = target(app) {
                let _ = win.emit_to(win.label(), "dock", *place);
            }
        }
    }
);

/// The file window that opens the new one and places it. A viewer window has no window commands. The main window answers even while hidden.
fn target(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.label().starts_with("tab-") && w.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"))
}

fn build(mtm: MainThreadMarker) -> (Retained<Target>, Retained<NSMenu>) {
    let target: Retained<Target> = unsafe { msg_send![super(Target::alloc(mtm).set_ivars(())), init] };
    let menu = NSMenu::new(mtm);
    for (i, (label, _)) in ITEMS.iter().enumerate() {
        if i == 1 {
            menu.addItem(&NSMenuItem::separatorItem(mtm));
        }
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                &NSString::from_str(label),
                Some(sel!(dockItem:)),
                &NSString::new(),
            )
        };
        unsafe { item.setTarget(Some(&target)) };
        item.setTag(i as isize);
        menu.addItem(&item);
    }
    (target, menu)
}

unsafe extern "C-unwind" fn dock_menu(_: &AnyObject, _: Sel, _: *mut AnyObject) -> *const NSMenu {
    MENU.with(|m| m.get().map_or(std::ptr::null(), |(_, menu)| Retained::as_ptr(menu)))
}

/// Call on the main thread. AppKit asks the app delegate for this menu, and tao's delegate has no such method, so it is added to tao's class.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let (Some(mtm), Some(class)) = (MainThreadMarker::new(), AnyClass::get(c"TaoAppDelegateParent"))
    else {
        return;
    };
    MENU.with(|m| {
        m.get_or_init(|| build(mtm));
    });
    type Handler = unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> *const NSMenu;
    unsafe {
        objc2::ffi::class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            sel!(applicationDockMenu:),
            std::mem::transmute::<Handler, Imp>(dock_menu),
            c"@@:@".as_ptr(),
        );
    }
}
