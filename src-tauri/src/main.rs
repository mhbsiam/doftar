#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod alias;
mod archive;
mod cache;
#[cfg(target_os = "macos")]
mod bulk;
mod clipboard;
mod crashlog;
mod data;
mod disk;
mod docx;
mod downloads;
mod fly;
mod dupes;
mod fsops;
mod git;
mod guard;
mod imgedit;
mod jobs;
mod launcher;
mod lock;
mod markdown;
mod menu;
mod netguard;
mod notebook;
mod npy;
mod opened;
mod openwith;
mod pdf;
mod store;
mod tags;
mod uninstall;
mod props;
mod metadata;
mod quarantine;
#[cfg(target_os = "macos")]
mod dock;
mod quicklook;
mod reader;
mod search;
mod share;
mod sheets;
mod skills;
mod sqlite;
mod thumbs;
mod trash;
mod video;
mod viewer;
mod watcher;
mod webview;
mod weights;
mod windows;
mod zoom;

use crate::lock::Locked;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

static PREV_FRAME: Mutex<Vec<(String, PhysicalPosition<i32>, PhysicalSize<u32>)>> =
    Mutex::new(Vec::new());

/// Set when a quit passes the editors' questions. A repeated ⌘Q then does not start a second quit.
static QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Quit like ⌘Q. An editor sends it after it handles its unsaved edits.
#[tauri::command]
fn request_quit(app: tauri::AppHandle) {
    begin_quit(&app);
}

/// An editor with unsaved edits asks first, and the quit waits. Running file operations stop at a clean point. The windows save before exit.
fn begin_quit(app: &tauri::AppHandle) {
    for (label, dirty) in [(viewer::LABEL, viewer::is_dirty()), (reader::LABEL, reader::is_dirty())] {
        if let Some(win) = app.get_webview_window(label).filter(|_| dirty) {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
            let _ = win.emit_to(label, &format!("{label}:confirm-quit"), ());
            return;
        }
    }
    if QUIT_REQUESTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        if jobs::stop_all(Duration::from_secs(10)) {
            // shortcut: fixed wait for stopped-job results to reach the undo history. Add a handshake if it is too short.
            std::thread::sleep(Duration::from_millis(300));
        }
        // The window saves its debounced favorites and recents, then quits. This exit is only for a window that never answers.
        let _ = handle.emit("menu", "quit");
        std::thread::sleep(Duration::from_secs(5));
        handle.exit(0);
    });
}

#[tauri::command]
fn toggle_maximize_window(window: WebviewWindow) -> Result<bool, String> {
    let mut prev = PREV_FRAME.locked();
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

#[tauri::command]
fn set_window_maximized(window: WebviewWindow, on: bool) -> Result<bool, String> {
    let is = PREV_FRAME.locked().iter().any(|(l, ..)| l == window.label());
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
    // Without its buttons AppKit can guess the window is auxiliary, and Stage Manager then won't group it with other apps.
    w.setCollectionBehavior(
        w.collectionBehavior()
            | objc2_app_kit::NSWindowCollectionBehavior::Primary
            | objc2_app_kit::NSWindowCollectionBehavior::FullScreenPrimary,
    );
}

/// Allow only the app's own pages, or the dev server `dev` in a debug build.
/// A link or a taken-over page cannot then load a website or file into a window with Doftar commands.
fn own_page(url: &tauri::Url, dev: Option<&tauri::Url>) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (cfg!(not(target_os = "macos"))
            && matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some("tauri.localhost"))
        || dev.is_some_and(|d| d.origin() == url.origin())
}

fn main() {
    // Run first. This process and its children get no IP sockets.
    if let Err(e) = netguard::install() {
        eprintln!("Doftar: network guard not applied: {e}");
    }
    crashlog::install();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("navguard")
                .on_navigation(|webview, url| {
                    let dev = webview.config().build.dev_url.as_ref();
                    own_page(url, dev.filter(|_| cfg!(debug_assertions)))
                })
                .build(),
        )
        .manage(watcher::WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            crashlog::log_ui_error,
            crashlog::copy_diagnostics,
            fsops::list_dir,
            fsops::list_dir_stream,
            fsops::cancel_list_stream,
            fsops::list_dir_capped,
            fsops::request_folder_access,
            fsops::system_info,
            fsops::free_space,
            fsops::path_exists,
            fsops::is_folder,
            fsops::file_ids,
            fsops::file_revision,
            fsops::item_ids,
            fsops::dir_stamp,
            git::git_info,
            git::git_overview,
            git::git_switch,
            git::git_worktree_status,
            git::git_repos,
            skills::list_skills,
            skills::create_skill,
            skills::link_skill,
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
            fsops::rename_taken,
            fsops::create_dir,
            fsops::create_file,
            fsops::create_text_file,
            fsops::trash_paths,
            fsops::apply_steps,
            fsops::discard_asides,
            jobs::cancel_job,
            jobs::pause_job,
            clipboard::clipboard_write_files,
            clipboard::clipboard_read_files,
            clipboard::clipboard_change_count,
            clipboard::clipboard_clear,
            clipboard::clipboard_paste_data,
            archive::archive_list,
            dupes::find_duplicates,
            menu::set_undo_labels,
            menu::set_terminal_label,
            fsops::delete_permanently,
            fsops::open_terminal,
            fsops::run_in_terminal,
            props::item_info,
            props::folder_size,
            props::cancel_size,
            props::file_checksums,
            metadata::item_metadata,
            metadata::media_info,
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
            trash::eject_volume,
            openwith::open_with_apps,
            openwith::open_with,
            openwith::open_path,
            openwith::open_link_target,
            openwith::reveal_in_finder,
            openwith::pick_application,
            openwith::terminal_apps,
            openwith::editor_apps,
            openwith::runs_as_program,
            thumbs::thumbnail,
            thumbs::thumbnail_cached,
            thumbs::pdf_page_sizes,
            thumbs::pdf_page_picture,
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
            opened::take_opened,
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
            reader::reader_set_dirty,
            reader::read_text,
            docx::read_docx_text,
            reader::write_text,
            reader::read_document,
            reader::open_web_link,
            data::read_data_part,
            reader::is_text_file,
            pdf::open_pdf,
            pdf::pdf_action,
            pdf::pdf_state,
            video::open_video,
            video::video_ready,
            alias::resolve_alias,
            toggle_maximize_window,
            set_window_maximized,
            quit_app,
            request_quit,
            watcher::watch_path,
            watcher::unwatch_path,
            downloads::download_file,
            watcher::watch_files,
            store::load_store,
            store::set_aside_store,
            store::save_store,
        ])
        .on_window_event(|window, event| {
            // The main window hides on close, so the Dock icon can bring it back. The image viewer, reader, PDF viewer and video player hide too, to open the next file at once.
            // Tab windows close.
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
                } else if window.label() == video::LABEL {
                    api.prevent_close();
                    video::close_requested(window);
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
                let _ = window.app_handle().emit("window:destroyed", window.label());
                if window.label() == viewer::LABEL {
                    viewer::forget();
                }
                if window.label() == reader::LABEL {
                    reader::forget();
                }
                if window.label() == video::LABEL {
                    video::forget();
                }
                watcher::forget_window(&window.state::<watcher::WatcherState>(), window.label());
                PREV_FRAME.locked().retain(|(l, ..)| l != window.label());
            }
        })
        .menu(menu::build)
        .on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()))
        .setup(|app| {
            downloads::init(app.handle().clone());
            watcher::init(app.handle().clone());
            quicklook::init(app.handle());
            #[cfg(target_os = "macos")]
            dock::init(app.handle());
            #[cfg(target_os = "macos")]
            opened::init(app.handle());
            cache::secure_dirs();
            cache::drop_session_previews();
            cache::start_janitor();
            std::thread::spawn(fsops::sweep_stale_partials);
            let data_dir = app.path().app_data_dir()?;
            cache::make_private(&data_dir);
            store::set_path(data_dir.join("store.json"));

            // Built here, not from the config, so its page renders at the display refresh rate. See webview.rs.
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

            // Ready before the first file opens. One window at a time keeps launch light.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                viewer::prewarm(&handle);
                std::thread::sleep(std::time::Duration::from_secs(1));
                reader::prewarm(&handle);
                std::thread::sleep(std::time::Duration::from_secs(1));
                pdf::prewarm(&handle);
                std::thread::sleep(std::time::Duration::from_secs(1));
                video::prewarm(&handle);
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
            // Handle every ⌘Q and Dock quit. A second one while the first waits must not skip the save. `quit_app` exits with a code.
            api.prevent_exit();
            begin_quit(app);
        }
        if let tauri::RunEvent::Exit = &event {
            cache::drop_session_previews();
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &event {
            // A folder's URL ends in a slash. Collecting the components drops it.
            let paths = urls.iter().filter_map(|u| u.to_file_path().ok()).map(|p| p.components().collect::<std::path::PathBuf>());
            opened::hand(app, paths.map(|p| p.to_string_lossy().into_owned()).collect(), false);
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
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
    fn windows_stay_on_the_apps_own_pages() {
        let url = |s: &str| tauri::Url::parse(s).unwrap();
        let dev = url("http://localhost:5173");
        assert!(super::own_page(&url("tauri://localhost/index.html?reader#x"), None));
        assert!(super::own_page(&url("http://localhost:5173/?viewer"), Some(&dev)));
        for other in [
            "https://example.com/",
            "http://localhost:8080/",
            "file:///Users/me/.zshrc",
            "asset://localhost/%2FUsers%2Fme",
            "tauri://example.com/",
            "data:text/html,hi",
            "blob:tauri://localhost/1",
        ] {
            assert!(!super::own_page(&url(other), Some(&dev)), "{other}");
        }
        assert!(!super::own_page(&url("http://localhost:5173/"), None));
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
            include_str!("../capabilities/video.json"),
        ]
        .concat();
        for cmd in &handled {
            assert!(build.contains(&format!("\"{cmd}\",")), "{cmd} is missing from build.rs");
            let grant = format!("\"allow-{}\"", cmd.replace('_', "-"));
            assert!(caps.contains(&grant), "no capability grants {cmd}");
        }
    }
}
