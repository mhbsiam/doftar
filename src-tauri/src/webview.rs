//! Making webview windows, with pages that render at the display's full
//! refresh rate.
//!
//! WebKit paces a page's rendering updates (requestAnimationFrame, scroll
//! handlers, any animation that isn't on the compositor) at the whole
//! fraction of the display's refresh rate nearest 60 Hz, so on a 120 Hz
//! display a page gets 60 updates a second. The switch behind that,
//! `PreferPageRenderingUpdatesNear60FPSEnabled`, is read when the page is
//! made and changing it later does nothing until a reload, so every window
//! is built here from a configuration that has it off before the page loads.

use std::sync::mpsc;

use tauri::utils::config::WindowConfig;
use tauri::{AppHandle, WebviewWindow, WebviewWindowBuilder};

/// Makes the window `cfg` describes. Safe to call from any thread: the
/// window is built on the main thread and this waits for it, as
/// `WebviewWindowBuilder::build` does.
pub fn build(app: &AppHandle, cfg: WindowConfig) -> Result<WebviewWindow, String> {
    let (tx, rx) = mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(build_here(&handle, &cfg));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

fn build_here(app: &AppHandle, cfg: &WindowConfig) -> Result<WebviewWindow, String> {
    let builder = WebviewWindowBuilder::from_config(app, cfg).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let builder = match objc2::MainThreadMarker::new() {
        Some(mtm) => builder.with_webview_configuration(full_rate::configuration(mtm)),
        None => builder,
    };
    builder.build().map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
mod full_rate {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObjectProtocol};
    use objc2::{msg_send, sel, ClassType, MainThreadMarker};
    use objc2_foundation::{NSArray, NSString};
    use objc2_web_kit::{WKPreferences, WKWebViewConfiguration};

    const KEY: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";

    /// A fresh configuration whose pages update at the display's rate.
    pub fn configuration(mtm: MainThreadMarker) -> Retained<WKWebViewConfiguration> {
        let config = unsafe { WKWebViewConfiguration::new(mtm) };
        let prefs = unsafe { config.preferences() };
        // macOS 13.3 and later list every switch under `_features`; 13.0 to
        // 13.2 keep this one among the internal debug features.
        let done = unsafe { turn_off(&prefs, true) || turn_off(&prefs, false) };
        if !done {
            eprintln!("Doftar: WebKit doesn't expose its 60 fps preference here; pages render at 60 Hz");
        }
        config
    }

    /// Turns the preference off through WebKit's private feature list and
    /// says whether it was found. These are WebKit SPI, so every step
    /// checks the selector exists before calling it.
    unsafe fn turn_off(prefs: &WKPreferences, unified: bool) -> bool {
        let cls = WKPreferences::class();
        let (list, setter) = if unified {
            (sel!(_features), sel!(_setEnabled:forFeature:))
        } else {
            (
                sel!(_internalDebugFeatures),
                sel!(_setEnabled:forInternalDebugFeature:),
            )
        };
        if !cls.metaclass().responds_to(list) || !prefs.respondsToSelector(setter) {
            return false;
        }
        let features: Option<Retained<NSArray<AnyObject>>> = if unified {
            msg_send![cls, _features]
        } else {
            msg_send![cls, _internalDebugFeatures]
        };
        let Some(features) = features else {
            return false;
        };
        for feature in features.iter() {
            let feature: &AnyObject = &feature;
            if !feature.class().responds_to(sel!(key)) {
                continue;
            }
            let key: Option<Retained<NSString>> = msg_send![feature, key];
            if key.is_some_and(|k| k.to_string() == KEY) {
                if unified {
                    let _: () = msg_send![prefs, _setEnabled: false, forFeature: feature];
                } else {
                    let _: () =
                        msg_send![prefs, _setEnabled: false, forInternalDebugFeature: feature];
                }
                return true;
            }
        }
        false
    }
}
