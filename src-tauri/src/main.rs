#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod alias;
mod archive;
mod cache;
#[cfg(target_os = "macos")]
mod bulk;
mod clipboard;
mod disk;
mod fly;
mod fsops;
mod guard;
mod imgedit;
mod jobs;
mod launcher;
mod markdown;
mod menu;
mod netguard;
mod openwith;
mod pdf;
mod store;
mod tags;
mod uninstall;
mod props;
mod quarantine;
mod quicklook;
mod reader;
mod search;
mod share;
mod thumbs;
mod trash;
mod viewer;
mod watcher;
mod webview;
mod windows;
mod zoom;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Each zoomed window's frame from before it was zoomed, by window label.
static PREV_FRAME: Mutex<Vec<(String, PhysicalPosition<i32>, PhysicalSize<u32>)>> =
    Mutex::new(Vec::new());

/// Set once a native quit has been intercepted so the frontend can flush
/// its store; the second request (from `quit_app`) is allowed through.
static QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn toggle_maximize_window(window: WebviewWindow) -> Result<bool, String> {
    let mut prev = PREV_FRAME.lock().unwrap();
    if let Some(i) = prev.iter().position(|(l, ..)| l == window.label()) {
        let (_, pos, size) = prev.remove(i);
        zoom::set_frame(&window, pos, size).map_err(|e| e.to_string())?;
        return Ok(false);
    }
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no monitor for window".to_string())?;
    prev.push((
        window.label().to_string(),
        window.outer_position().map_err(|e| e.to_string())?,
        window.outer_size().map_err(|e| e.to_string())?,
    ));
    zoom::set_frame(&window, *monitor.position(), *monitor.size()).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Fills the screen (`on`) or goes back to the size it had before, like the
/// maximize button; true when the window changed.
#[tauri::command]
fn set_window_maximized(window: WebviewWindow, on: bool) -> Result<bool, String> {
    let is = PREV_FRAME.lock().unwrap().iter().any(|(l, ..)| l == window.label());
    if is == on {
        return Ok(false);
    }
    toggle_maximize_window(window).map(|_| true)
}

#[cfg(target_os = "macos")]
pub(crate) fn hide_traffic_lights(win: &WebviewWindow) {
    use objc2_app_kit::NSWindowButton;
    let Ok(ns_window) = win.ns_window() else {
        return;
    };
    let w = unsafe { &*(ns_window as *mut objc2_app_kit::NSWindow) };
    for button in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        if let Some(btn) = w.standardWindowButton(button) {
            btn.setHidden(true);
        }
    }
}

fn main() {
    // Before anything else: no IP sockets for this process or its children.
    if let Err(e) = netguard::install() {
        eprintln!("Doftar: network guard not applied: {e}");
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        .manage(watcher::WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            fsops::list_dir,
            fsops::list_dir_stream,
            fsops::cancel_list_stream,
            fsops::list_dir_capped,
            fsops::system_info,
            fsops::path_exists,
            fsops::file_ids,
            fsops::dir_stamp,
            archive::compress_paths,
            archive::extract_archive,
            fsops::copy_paths,
            fsops::find_conflicts,
            fsops::stat_entries,
            fsops::move_paths,
            fsops::transfer_paths,
            fsops::drop_moves,
            fsops::drop_plan,
            fsops::rename_path,
            fsops::create_dir,
            fsops::create_file,
            fsops::trash_paths,
            fsops::apply_steps,
            jobs::cancel_job,
            clipboard::clipboard_write_files,
            clipboard::clipboard_read_files,
            clipboard::clipboard_change_count,
            clipboard::clipboard_clear,
            menu::set_undo_labels,
            menu::set_terminal_label,
            fsops::delete_permanently,
            fsops::open_terminal,
            fsops::run_in_terminal,
            props::item_info,
            props::folder_size,
            props::cancel_size,
            disk::disk_scan,
            disk::cancel_disk_scan,
            disk::disk_map,
            disk::disk_map_forget,
            search::search_dir,
            search::search_tags,
            search::cancel_search,
            tags::edit_tags,
            tags::scan_tags,
            trash::empty_trash,
            trash::trash_dirs,
            trash::ensure_dir,
            trash::put_back_finder,
            trash::eject_volume,
            openwith::open_with_apps,
            openwith::open_with,
            openwith::open_path,
            openwith::open_link_target,
            openwith::pick_application,
            openwith::terminal_apps,
            openwith::runs_as_program,
            thumbs::thumbnail,
            thumbs::thumbnail_cached,
            thumbs::cancel_thumbnail,
            cache::cache_info,
            uninstall::app_leftovers,
            uninstall::delete_apps_with_admin,
            cache::clear_cache,
            quicklook::quicklook,
            quicklook::quicklook_close,
            share::share_paths,
            windows::open_tab_window,
            windows::take_window_init,
            windows::tab_window_at,
            viewer::open_image_viewer,
            viewer::list_images,
            viewer::viewer_image,
            viewer::viewer_ready,
            zoom::show_zoomed,
            zoom::motion_scale,
            fly::viewer_shown,
            fly::viewer_return_rect,
            viewer::viewer_set_dirty,
            imgedit::save_image_edit,
            reader::open_reader,
            reader::reader_ready,
            reader::read_document,
            reader::is_text_file,
            pdf::open_pdf,
            pdf::pdf_action,
            pdf::pdf_state,
            alias::resolve_alias,
            toggle_maximize_window,
            set_window_maximized,
            quit_app,
            watcher::watch_path,
            watcher::unwatch_path,
            watcher::watch_files,
            store::load_store,
            store::save_store,
        ])
        .on_window_event(|window, event| {
            // The main window hides rather than closes, so the app stays open
            // and the Dock icon brings it back; tab windows close for good.
            // The image viewer, reader and PDF viewer hide too, so the next
            // file opens at once.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == viewer::LABEL {
                    api.prevent_close();
                    viewer::close_requested(window);
                } else if window.label() == reader::LABEL {
                    api.prevent_close();
                    reader::close_requested(window);
                } else if window.label() == pdf::LABEL {
                    api.prevent_close();
                    pdf::close_requested(window);
                }
            }
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                    quicklook::quicklook_close();
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                windows::forget(window.label());
                if window.label() == viewer::LABEL {
                    viewer::forget();
                }
                if window.label() == reader::LABEL {
                    reader::forget();
                }
                watcher::forget_window(&window.state::<watcher::WatcherState>(), window.label());
                PREV_FRAME.lock().unwrap().retain(|(l, ..)| l != window.label());
            }
        })
        .menu(|app| menu::build(app))
        .on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()))
        .setup(|app| {
            watcher::init(app.handle().clone());
            quicklook::init(app.handle());
            cache::secure_dirs();
            cache::drop_session_previews();
            cache::start_janitor();
            let data_dir = app.path().app_data_dir()?;
            cache::make_private(&data_dir);
            store::set_path(data_dir.join("store.json"));

            // Built here rather than from the config (`"create": false`) so
            // its page renders at the display's refresh rate; see webview.rs.
            let main_cfg = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("no window config")?;
            let win = webview::build(app.handle(), main_cfg)?;
            let _ = win.set_min_size(Some(tauri::LogicalSize::new(760.0, 500.0)));
            let _ = win.set_size(tauri::LogicalSize::new(1240.0, 800.0));
            let _ = win.center();
            #[cfg(target_os = "macos")]
            hide_traffic_lights(&win);

            // Ready before the first image, document or PDF is opened, so
            // it opens at once; one at a time, so launch stays light.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                viewer::prewarm(&handle);
                std::thread::sleep(std::time::Duration::from_secs(1));
                reader::prewarm(&handle);
                std::thread::sleep(std::time::Duration::from_secs(1));
                pdf::prewarm(&handle);
            });

            let fallback = win.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                let _ = fallback.show();
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, code: None, .. } = &event {
            // ⌘Q / Dock quit: the webview debounces its favorites/recents
            // save, so give it a moment to flush before exiting for real.
            if !QUIT_REQUESTED.swap(true, Ordering::SeqCst) {
                api.prevent_exit();
                let _ = app.emit("menu", "quit");
                let handle = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1500));
                    handle.exit(0);
                });
            }
        }
        if let tauri::RunEvent::Exit = &event {
            cache::drop_session_previews();
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
            // Bring back the main window only when no other window is showing.
            if let Some(win) = app.get_webview_window("main").filter(|_| !has_visible_windows) {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}

#[cfg(test)]
mod tests {
    /// The command names between `generate_handler![` and `])` in `source`.
    fn handler_commands(source: &str) -> Vec<String> {
        let start = source.find("generate_handler![").unwrap() + "generate_handler![".len();
        let end = start + source[start..].find("])").unwrap();
        source[start..end]
            .split(',')
            .map(|c| c.trim().rsplit("::").next().unwrap().to_string())
            .filter(|c| !c.is_empty())
            .collect()
    }

    #[test]
    fn every_command_has_a_permission_and_a_window() {
        let handled = handler_commands(include_str!("main.rs"));
        let build = include_str!("../build.rs");
        let caps = [
            include_str!("../capabilities/default.json"),
            include_str!("../capabilities/viewer.json"),
            include_str!("../capabilities/reader.json"),
            include_str!("../capabilities/pdf.json"),
        ]
        .concat();
        for cmd in &handled {
            assert!(build.contains(&format!("\"{cmd}\",")), "{cmd} is missing from build.rs");
            let grant = format!("\"allow-{}\"", cmd.replace('_', "-"));
            assert!(caps.contains(&grant), "no capability grants {cmd}");
        }
    }
}
