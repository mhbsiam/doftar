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
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file = SubmenuBuilder::with_id(app, "file", "File")
        .item(&item(app, "new_tab", "New Tab", Some("CmdOrCtrl+T"))?)
        .item(&item(app, "new_folder", "New Folder", Some("CmdOrCtrl+Shift+N"))?)
        .item(&item(app, "new_file", "New Text Document", None)?)
        .separator()
        .item(&item(app, "open", "Open", Some("CmdOrCtrl+Down"))?)
        .item(&item(app, "get_info", "Properties", Some("CmdOrCtrl+I"))?)
        .item(&item(app, "rename", "Rename", None)?)
        .item(&item(app, "open_terminal", "Open in Terminal", Some("CmdOrCtrl+Alt+T"))?)
        .item(&item(app, "compress", "Compress to ZIP", None)?)
        .item(&item(app, "extract", "Extract Here", None)?)
        .separator()
        .item(&item(app, "move_to_trash", "Move to Trash", Some("CmdOrCtrl+Backspace"))?)
        .item(&item(app, "delete_now", "Delete Immediately…", Some("CmdOrCtrl+Alt+Backspace"))?)
        .separator()
        .item(&item(app, "close_tab", "Close Tab", Some("CmdOrCtrl+W"))?)
        .build()?;

    let edit = SubmenuBuilder::with_id(app, "edit", "Edit")
        .item(&item(app, "undo", "Undo", Some("CmdOrCtrl+Z"))?)
        .item(&item(app, "redo", "Redo", Some("CmdOrCtrl+Shift+Z"))?)
        .separator()
        .copy()
        .cut()
        .paste()
        .item(&item(app, "paste_move", "Move Item Here", Some("CmdOrCtrl+Alt+V"))?)
        .item(&item(app, "select_all", "Select All", Some("CmdOrCtrl+A"))?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item(app, "view_grid", "as Icons", Some("CmdOrCtrl+1"))?)
        .item(&item(app, "view_details", "as Details", Some("CmdOrCtrl+2"))?)
        .separator()
        .item(&item(app, "toggle_hidden", "Show/Hide Hidden Files", Some("CmdOrCtrl+Shift+Period"))?)
        .item(&item(app, "toggle_checkboxes", "Show/Hide Item Check Boxes", None)?)
        .item(&item(app, "toggle_nav_pane", "Show/Hide Navigation Pane", None)?)
        .item(&item(app, "toggle_split", "Split View", Some("CmdOrCtrl+Backslash"))?)
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
        .item(&item(app, "close_window", "Close Window", Some("CmdOrCtrl+Shift+W"))?)
        .separator()
        .item(&PredefinedMenuItem::bring_all_to_front(app, None)?)
        .build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .item(&item(app, "shortcuts", "Keyboard Shortcuts", None)?)
        .build()?;

    #[cfg(target_os = "macos")]
    {
        window.set_as_windows_menu_for_nsapp()?;
        help.set_as_help_menu_for_nsapp()?;
    }

    let menus: [&Submenu<R>; 7] = [&app_menu, &file, &edit, &view, &go, &window, &help];
    Menu::with_items(app, &menus.map(|m| m as &dyn tauri::menu::IsMenuItem<R>))
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
        _ => {
            let _ = win.emit_to(win.label(), "menu", id.to_string());
        }
    }
}

/// Names File > Open in … after the default terminal, e.g. "Open in Warp".
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
