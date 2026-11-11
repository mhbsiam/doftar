use tauri::menu::{
    AboutMetadata, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    accel: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, text, true, accel)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        ..Default::default()
    };

    let app_menu = SubmenuBuilder::new(app, &pkg.name)
        .about(Some(about))
        .separator()
        .item(&item(app, "settings", "Settings…", Some("CmdOrCtrl+Comma"))?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file = SubmenuBuilder::with_id(app, "file", "File")
        .item(&item(app, "new_window", "New Window", Some("CmdOrCtrl+N"))?)
        .item(&item(app, "new_tab", "New Tab", Some("CmdOrCtrl+T"))?)
        .item(&item(app, "new_folder", "New Folder", Some("CmdOrCtrl+Shift+N"))?)
        .item(&item(app, "new_folder_selection", "New Folder with Selection", Some("Control+Command+N"))?)
        .item(&item(app, "new_file", "New Text Document", Some("CmdOrCtrl+Alt+N"))?)
        .separator()
        .item(&item(app, "open", "Open", Some("CmdOrCtrl+Down"))?)
        .item(&item(app, "get_info", "Properties", Some("CmdOrCtrl+I"))?)
        .item(&item(app, "rename", "Rename", None)?)
        .item(&item(app, "duplicate", "Duplicate", Some("CmdOrCtrl+D"))?)
        .item(&item(app, "reveal_in_finder", "Reveal in Finder", Some("CmdOrCtrl+Alt+R"))?)
        .item(&item(app, "open_terminal", "Open in Terminal", Some("CmdOrCtrl+Alt+T"))?)
        .item(&item(app, "move_to", "Move to…", None)?)
        .item(&item(app, "copy_to", "Copy to…", None)?)
        .item(&item(app, "toggle_verify_copies", "Verify Copies to Other Drives", None)?)
        .item(&item(app, "compress", "Compress to ZIP", None)?)
        .item(&item(app, "extract", "Extract Here", None)?)
        .item(&item(app, "folder_tree", "Show Folder Tree", Some("CmdOrCtrl+Shift+E"))?)
        .separator()
        .item(&item(app, "move_to_trash", "Move to Trash", Some("CmdOrCtrl+Backspace"))?)
        .item(&item(app, "delete_now", "Delete Immediately…", Some("CmdOrCtrl+Alt+Backspace"))?)
        .separator()
        .item(&item(app, "close_tab", "Close Tab", Some("CmdOrCtrl+W"))?)
        .item(&item(app, "reopen_tab", "Reopen Closed Tab", Some("CmdOrCtrl+Shift+T"))?)
        .build()?;

    let edit = SubmenuBuilder::with_id(app, "edit", "Edit")
        .item(&item(app, "undo", "Undo", Some("CmdOrCtrl+Z"))?)
        .item(&item(app, "redo", "Redo", Some("CmdOrCtrl+Shift+Z"))?)
        .separator()
        .copy()
        .cut()
        .paste()
        .item(&item(app, "paste_move", "Move Item Here", Some("CmdOrCtrl+Alt+V"))?)
        .item(&item(app, "clip_history", "Paste from History…", Some("CmdOrCtrl+Shift+V"))?)
        .item(&item(app, "select_all", "Select All", Some("CmdOrCtrl+A"))?)
        .item(&item(app, "select_pattern", "Select by Pattern…", Some("CmdOrCtrl+Shift+S"))?)
        .item(&item(app, "invert_selection", "Invert Selection", Some("CmdOrCtrl+Shift+I"))?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item(app, "palette", "Command Palette…", Some("CmdOrCtrl+K"))?)
        .separator()
        .item(&item(app, "view_grid", "as Icons", Some("CmdOrCtrl+1"))?)
        .item(&item(app, "view_details", "as Details", Some("CmdOrCtrl+2"))?)
        .item(&item(app, "view_columns", "as Columns", Some("CmdOrCtrl+3"))?)
        .item(&item(app, "icons_larger", "Larger Icons", Some("CmdOrCtrl+Equal"))?)
        .item(&item(app, "icons_smaller", "Smaller Icons", Some("CmdOrCtrl+Minus"))?)
        .separator()
        .item(&item(app, "toggle_hidden", "Show/Hide Hidden Files", Some("CmdOrCtrl+Shift+Period"))?)
        .item(&item(app, "toggle_checkboxes", "Show/Hide Item Check Boxes", None)?)
        .item(&item(app, "toggle_item_info", "Show/Hide Item Info", None)?)
        .item(&item(app, "toggle_nav_pane", "Show/Hide Navigation Pane", None)?)
        .item(&item(app, "toggle_preview", "Show/Hide Preview", Some("CmdOrCtrl+Shift+P"))?)
        .item(&item(app, "toggle_split", "Split View", Some("CmdOrCtrl+Backslash"))?)
        .item(&item(app, "compare_folders", "Compare Folders", None)?)
        .item(&item(app, "switch_pane", "Switch Pane", Some("F6"))?)
        .separator()
        .item(&item(app, "refresh", "Refresh", Some("CmdOrCtrl+R"))?)
        .separator()
        .fullscreen()
        .build()?;

    let go = SubmenuBuilder::new(app, "Go")
        .item(&item(app, "back", "Back", Some("CmdOrCtrl+BracketLeft"))?)
        .item(&item(app, "forward", "Forward", Some("CmdOrCtrl+BracketRight"))?)
        .item(&item(app, "up", "Enclosing Folder", Some("CmdOrCtrl+Up"))?)
        .separator()
        .item(&item(app, "go_home_page", "Home", Some("CmdOrCtrl+Shift+H"))?)
        .item(&item(app, "go_desktop", "Desktop", Some("CmdOrCtrl+Shift+D"))?)
        .item(&item(app, "go_documents", "Documents", Some("CmdOrCtrl+Shift+O"))?)
        .item(&item(app, "go_downloads", "Downloads", Some("CmdOrCtrl+Alt+L"))?)
        .item(&item(app, "go_applications", "Applications", Some("CmdOrCtrl+Shift+A"))?)
        .item(&item(app, "go_home_folder", "Home Folder", None)?)
        .separator()
        .item(&item(app, "go_to_folder", "Go to Folder…", Some("CmdOrCtrl+Shift+G"))?)
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .item(&item(app, "zoom", "Zoom", None)?)
        .separator()
        .item(&item(app, "next_tab", "Show Next Tab", Some("CmdOrCtrl+Shift+BracketRight"))?)
        .item(&item(app, "prev_tab", "Show Previous Tab", Some("CmdOrCtrl+Shift+BracketLeft"))?)
        .separator()
        .item(&item(app, "close_window", "Close Window", Some("CmdOrCtrl+Shift+W"))?)
        .separator()
        .item(&PredefinedMenuItem::bring_all_to_front(app, None)?)
        .build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .item(&item(app, "help", "Doftar Help", Some("CmdOrCtrl+Shift+Slash"))?)
        .item(&item(app, "shortcuts", "Keyboard Shortcuts", Some("CmdOrCtrl+Slash"))?)
        .item(&item(app, "copy_diagnostics", "Copy Diagnostic Info", None)?)
        .build()?;

    #[cfg(target_os = "macos")]
    {
        window.set_as_windows_menu_for_nsapp()?;
        help.set_as_help_menu_for_nsapp()?;
    }

    let menus: [&Submenu<R>; 7] = [&app_menu, &file, &edit, &view, &go, &window, &help];
    Menu::with_items(app, &menus.map(|m| m as &dyn tauri::menu::IsMenuItem<R>))
}

/// `win` if it is a file window (main or a torn-off tab), else the main window. Only those have toasts and dialogs.
fn file_window<R: Runtime>(app: &AppHandle<R>, win: tauri::WebviewWindow<R>) -> Option<tauri::WebviewWindow<R>> {
    if win.label() == "main" || win.label().starts_with("tab-") {
        Some(win)
    } else {
        app.get_webview_window("main")
    }
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let focused = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"));
    let Some(win) = focused else { return };
    match id {
        "close_window" => {
            let _ = win.close();
        }
        "copy_diagnostics" => {
            let result = if crate::crashlog::copy_diagnostics().is_ok() {
                "diagnostics_copied"
            } else {
                "diagnostics_not_copied"
            };
            // Viewer windows have no toasts, so the main window reports for them.
            if let Some(w) = file_window(app, win) {
                let _ = w.emit_to(w.label(), "menu", result.to_string());
            }
        }
        "settings" => {
            // Viewer windows have no Settings dialog, so the main window comes forward and shows it.
            if let Some(w) = file_window(app, win) {
                let _ = w.set_focus();
                let _ = w.emit_to(w.label(), "menu", id.to_string());
            }
        }
        _ => {
            let _ = win.emit_to(win.label(), "menu", id.to_string());
        }
    }
}

#[tauri::command]
pub fn set_terminal_label<R: Runtime>(app: AppHandle<R>, name: String) {
    let Some(menu) = app.menu() else { return };
    let Some(MenuItemKind::Submenu(file)) = menu.get("file") else {
        return;
    };
    if let Some(MenuItemKind::MenuItem(mi)) = file.get("open_terminal") {
        let _ = mi.set_text(format!("Open in {name}"));
    }
}

#[tauri::command]
pub fn set_undo_labels<R: Runtime>(app: AppHandle<R>, undo: Option<String>, redo: Option<String>) {
    let Some(menu) = app.menu() else { return };
    let Some(MenuItemKind::Submenu(edit)) = menu.get("edit") else {
        return;
    };
    for (id, verb, what) in [("undo", "Undo", undo), ("redo", "Redo", redo)] {
        if let Some(MenuItemKind::MenuItem(mi)) = edit.get(id) {
            let text = match what {
                Some(w) => format!("{verb} {w}"),
                None => verb.to_string(),
            };
            let _ = mi.set_text(text);
        }
    }
}
