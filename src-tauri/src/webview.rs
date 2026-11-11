//! Webview windows with pages that render at the full display refresh rate.
//!
//! WebKit limits page rendering updates (requestAnimationFrame, scroll handlers, animations not on the compositor) to a whole fraction of the refresh rate nearest 60 Hz.
//! A 120 Hz display gets 60 updates a second. The switch `PreferPageRenderingUpdatesNear60FPSEnabled` is read when the page is made.
//! A later change does nothing until a reload. So every window is built here with the switch off before the page loads.

use std::sync::mpsc;

use tauri::utils::config::WindowConfig;
use tauri::{AppHandle, WebviewWindow, WebviewWindowBuilder};

/// Make the window `cfg` describes. Safe from any thread: the window is built on the main thread and this call waits for it.
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
    let win = builder.build().map_err(|e| e.to_string())?;
    // Every page draws its own, with CaptionButtons.
    #[cfg(target_os = "macos")]
    crate::hide_traffic_lights(&win);
    Ok(win)
}

#[cfg(target_os = "macos")]
mod full_rate {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObjectProtocol};
    use objc2::{msg_send, sel, ClassType, MainThreadMarker};
    use objc2_foundation::{NSArray, NSString};
    use objc2_web_kit::{WKPreferences, WKWebViewConfiguration};

    const KEY: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";

    pub fn configuration(mtm: MainThreadMarker) -> Retained<WKWebViewConfiguration> {
        let config = unsafe { WKWebViewConfiguration::new(mtm) };
        let prefs = unsafe { config.preferences() };
        // macOS 13.3 and later list every switch under `_features`. macOS 13.0 to 13.2 keep this one among the internal debug features.
        let done = unsafe { turn_off(&prefs, true) || turn_off(&prefs, false) };
        if !done {
            eprintln!("Doftar: WebKit doesn't expose its 60 fps preference here; pages render at 60 Hz");
        }
        config
    }

    /// Turn the preference off through the private WebKit feature list. Return whether it was found.
    /// These are WebKit SPI, so check that each selector exists before the call.
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
