//! Folders and files handed to Doftar from outside: `open -a Doftar x`, a drop on the Dock icon, and the "Reveal in Doftar" service.
//! They wait in a queue that the main window drains, so nothing is lost when they arrive before its page has loaded.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::lock::Locked;

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Opened {
    path: String,
    /// Show the item in its folder, even when it is a folder itself.
    reveal: bool,
}

static PENDING: Mutex<Vec<Opened>> = Mutex::new(Vec::new());
/// Set once the main window's page has asked for the queue. Before that the window is still loading and stays hidden.
static READY: AtomicBool = AtomicBool::new(false);

fn queue(paths: Vec<String>, reveal: bool) {
    PENDING.locked().extend(paths.into_iter().map(|path| Opened { path, reveal }));
}

pub fn hand(app: &AppHandle, paths: Vec<String>, reveal: bool) {
    if paths.is_empty() {
        return;
    }
    queue(paths, reveal);
    if !READY.load(Ordering::Relaxed) {
        return;
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit_to("main", "opened", ());
    }
}

#[tauri::command]
pub fn take_opened(window: WebviewWindow) -> Vec<Opened> {
    if window.label() != "main" {
        return Vec::new();
    }
    READY.store(true, Ordering::Relaxed);
    std::mem::take(&mut *PENDING.locked())
}

#[cfg(target_os = "macos")]
mod service {
    use std::sync::OnceLock;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
    use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSApplication, NSPasteboard};
    use objc2_foundation::NSString;
    use tauri::AppHandle;

    static APP: OnceLock<AppHandle> = OnceLock::new();

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "DoftarServices"]
        struct Provider;

        unsafe impl NSObjectProtocol for Provider {}

        impl Provider {
            /// Named by `NSMessage` in Info.plist.
            #[unsafe(method(revealInDoftar:userData:error:))]
            fn reveal(&self, pboard: &NSPasteboard, _user_data: Option<&NSString>, _error: *mut *mut AnyObject) {
                let Some(app) = APP.get() else { return };
                // The user is in Finder, and the window should come up in front of it.
                #[allow(deprecated)]
                NSApplication::sharedApplication(self.mtm()).activateIgnoringOtherApps(true);
                super::hand(app, crate::clipboard::pasteboard_paths(pboard), true);
            }
        }
    );

    /// Call on the main thread.
    pub fn init(app: &AppHandle) {
        let _ = APP.set(app.clone());
        let Some(mtm) = MainThreadMarker::new() else { return };
        let provider: Retained<Provider> = unsafe { msg_send![super(Provider::alloc(mtm).set_ivars(())), init] };
        unsafe { NSApplication::sharedApplication(mtm).setServicesProvider(Some(&provider)) };
        // Lives as long as the app. Leaked so it holds whether or not AppKit retains its provider.
        std::mem::forget(provider);
    }
}

#[cfg(target_os = "macos")]
pub use service::init;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handed_paths_wait_until_taken_once() {
        queue(vec!["/a".into()], false);
        queue(vec!["/b".into()], true);
        let taken = std::mem::take(&mut *PENDING.locked());
        assert_eq!(
            taken,
            [Opened { path: "/a".into(), reveal: false }, Opened { path: "/b".into(), reveal: true }]
        );
        assert!(PENDING.locked().is_empty());
    }
}
