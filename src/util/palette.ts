/**
 * The commands of the command palette. They are the commands of the menu bar, with the same ids, so each runs as its menu item does.
 * Keep in step with src-tauri/src/menu.rs.
 */
export const PALETTE_COMMANDS: { id: string; label: string; group: string; keys?: string; also?: string }[] = [
  { id: "new_window", label: "New window", group: "File", keys: "⌘N" },
  { id: "new_tab", label: "New tab", group: "File", keys: "⌘T" },
  { id: "new_folder", label: "New folder", group: "File", keys: "⌘⇧N" },
  { id: "new_file", label: "New text document", group: "File", keys: "⌘⌥N" },
  { id: "new_folder_selection", label: "New folder with selection", group: "File", keys: "⌃⌘N", also: "group move into" },
  { id: "move_to", label: "Move to…", group: "File", also: "send folder destination" },
  { id: "copy_to", label: "Copy to…", group: "File", also: "send folder destination" },
  { id: "open", label: "Open selection", group: "File", keys: "⌘↓" },
  { id: "get_info", label: "Properties", group: "File", keys: "⌘I", also: "info details size" },
  { id: "rename", label: "Rename", group: "File", keys: "F2" },
  { id: "duplicate", label: "Duplicate", group: "File", keys: "⌘D", also: "copy clone" },
  { id: "reveal_in_finder", label: "Reveal in Finder", group: "File", keys: "⌥⌘R", also: "show finder" },
  { id: "open_terminal", label: "Open in Terminal", group: "File", keys: "⌥⌘T", also: "shell console" },
  { id: "toggle_verify_copies", label: "Verify copies to other drives: turn on or off", group: "File", also: "checksum sha256 integrity external usb safe" },
  { id: "compress", label: "Compress to ZIP", group: "File", also: "archive" },
  { id: "export_shot_list", label: "Export shot list (CSV)", group: "File", also: "clips video media duration spreadsheet" },
  { id: "extract", label: "Extract here", group: "File", also: "unzip archive" },
  { id: "folder_tree", label: "Show folder tree", group: "File", keys: "⌘⇧E", also: "outline map explorer sizes" },
  { id: "move_to_trash", label: "Move to Trash", group: "File", keys: "⌘⌫", also: "delete remove" },
  { id: "delete_now", label: "Delete immediately", group: "File", keys: "⌘⌥⌫", also: "remove permanently" },
  { id: "close_tab", label: "Close tab", group: "File", keys: "⌘W" },
  { id: "reopen_tab", label: "Reopen closed tab", group: "File", keys: "⌘⇧T", also: "restore undo close" },
  { id: "undo", label: "Undo", group: "Edit", keys: "⌘Z" },
  { id: "redo", label: "Redo", group: "Edit", keys: "⇧⌘Z" },
  { id: "paste_move", label: "Move item here", group: "Edit", keys: "⌘⌥V", also: "paste cut" },
  { id: "clip_history", label: "Paste from history…", group: "Edit", keys: "⌘⇧V", also: "clipboard recent copies" },
  { id: "select_all", label: "Select all", group: "Edit", keys: "⌘A" },
  { id: "select_pattern", label: "Select by pattern…", group: "Edit", keys: "⌘⇧S", also: "wildcard glob extension match" },
  { id: "invert_selection", label: "Invert selection", group: "Edit", keys: "⌘⇧I", also: "reverse others" },
  { id: "view_grid", label: "View as icons", group: "View", keys: "⌘1", also: "grid" },
  { id: "view_details", label: "View as list", group: "View", keys: "⌘2", also: "details" },
  { id: "view_columns", label: "View as columns", group: "View", keys: "⌘3" },
  { id: "icons_larger", label: "Larger icons", group: "View", keys: "⌘=", also: "zoom bigger" },
  { id: "icons_smaller", label: "Smaller icons", group: "View", keys: "⌘-", also: "zoom" },
  { id: "toggle_hidden", label: "Show or hide hidden files", group: "View", keys: "⌘⇧.", also: "dotfiles" },
  { id: "toggle_checkboxes", label: "Show or hide item check boxes", group: "View" },
  { id: "toggle_item_info", label: "Show or hide item info", group: "View", also: "icons size under name" },
  { id: "toggle_nav_pane", label: "Show or hide navigation pane", group: "View", also: "sidebar" },
  { id: "toggle_preview", label: "Show or hide preview", group: "View", keys: "⇧⌘P", also: "preview pane sidebar inspector" },
  { id: "toggle_split", label: "Split view", group: "View", keys: "⌘\\", also: "dual pane" },
  { id: "compare_folders", label: "Compare folders", group: "View", also: "split diff missing newer sync" },
  { id: "compare_files", label: "Compare two files", group: "View", also: "diff text changes data csv parquet anndata rows" },
  { id: "switch_pane", label: "Switch to the other pane", group: "View", keys: "F6" },
  { id: "refresh", label: "Refresh", group: "View", keys: "⌘R", also: "reload" },
  { id: "back", label: "Back", group: "Go", keys: "⌘[" },
  { id: "forward", label: "Forward", group: "Go", keys: "⌘]" },
  { id: "up", label: "Enclosing folder", group: "Go", keys: "⌘↑", also: "parent up" },
  { id: "go_home_page", label: "Home", group: "Go", keys: "⌘⇧H", also: "quick access" },
  { id: "go_home_folder", label: "Home folder", group: "Go" },
  { id: "go_desktop", label: "Desktop", group: "Go", keys: "⌘⇧D" },
  { id: "go_documents", label: "Documents", group: "Go", keys: "⌘⇧O" },
  { id: "go_downloads", label: "Downloads", group: "Go", keys: "⌘⌥L" },
  { id: "go_applications", label: "Applications", group: "Go", keys: "⌘⇧A", also: "apps" },
  { id: "go_to_folder", label: "Go to folder…", group: "Go", keys: "⌘⇧G", also: "path address" },
  { id: "next_tab", label: "Show next tab", group: "Window", keys: "⌃Tab", also: "switch cycle" },
  { id: "prev_tab", label: "Show previous tab", group: "Window", keys: "⌃⇧Tab", also: "switch cycle" },
  { id: "settings", label: "Settings…", group: "Window", keys: "⌘,", also: "preferences options theme text size colors date terminal editor" },
  { id: "help", label: "Doftar Help", group: "Help", keys: "⌘?", also: "guide manual how limits" },
  { id: "shortcuts", label: "Keyboard shortcuts", group: "Help", keys: "⌘/", also: "keys" },
  { id: "copy_diagnostics", label: "Copy diagnostic info", group: "Help", also: "crash log error bug report" },
];

/**
 * How well `query` matches `text`. Higher is better. -1 is no match.
 * Every query character must appear in order. A run scores more, and more again at the start of a word.
 */
export function matchScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let at = 0;
  let run = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, at);
    if (i < 0) return -1;
    run = i === at ? run + 1 : 1;
    const wordStart = i === 0 || /[\s/._-]/.test(t[i - 1]);
    score += run * 2 + (wordStart ? 6 : 0) - Math.min(i - at, 6);
    at = i + 1;
  }
  return score;
}

const KEYS = new Map(PALETTE_COMMANDS.flatMap((c) => (c.keys ? [[c.id, c.keys] as const] : [])));

/** The shortcut of a command, for menus that show the same command. */
export const keysOf = (id: string): string | undefined => KEYS.get(id);

const MONTH_MS = 30 * 24 * 3600 * 1000;

/** Extra score for a folder opened often. Halved once it has not been opened for a month. */
export function visitBonus(visits: number | undefined, ts: number, now: number): number {
  const bonus = Math.min(12, Math.log2((visits ?? 1) + 1) * 3);
  return now - ts > MONTH_MS ? bonus / 2 : bonus;
}
