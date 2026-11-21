/**
 * The keyboard shortcut sheet (Help → Keyboard Shortcuts). Keep in step with docs/REFERENCE.md.
 * Each row is [action, Mac keys, Windows-style keys]. A row with no Windows key shows the Mac one.
 */
export const SHORTCUTS: { group: string; keys: [string, string, string?][] }[] = [
  {
    group: "Files",
    keys: [
      ["Open selection", "Ctrl+↓ or Enter", "Enter"],
      ["Preview in the built-in viewer", "Space"],
      ["Properties", "Ctrl+I or Alt+Enter", "Alt+Enter"],
      ["Rename (several items: batch rename)", "F2"],
      ["New folder / text document", "Ctrl+Shift+N / Ctrl+Alt+N", "Ctrl+Shift+N / Ctrl+Alt+N"],
      ["New folder with selection", "Ctrl+Alt+Shift+N"],
      ["Duplicate", "Ctrl+D", "Ctrl+D"],
      ["Reveal in File Manager", "Ctrl+Alt+R"],
      ["Copy / Cut / Paste", "Ctrl+C / Ctrl+X / Ctrl+V", "Ctrl+C / X / V"],
      ["Move item here", "Ctrl+Alt+V"],
      ["Activity: paste or undo", "Ctrl+Shift+V", "Ctrl+Shift+V"],
      ["Copy as path", "Ctrl+Alt+C", "Ctrl+Alt+C"],
      ["Move to Trash", "Ctrl+Backspace or Delete", "Delete"],
      ["Delete immediately", "Ctrl+Alt+Backspace or Shift+Delete", "Shift+Delete"],
      ["Undo / Redo", "Ctrl+Z / Ctrl+Shift+Z", "Ctrl+Z / Ctrl+Shift+Z"],
      ["Select all", "Ctrl+A", "Ctrl+A"],
      ["Select by pattern / Invert selection", "Ctrl+Shift+S / Ctrl+Shift+I"],
      ["Open in terminal", "Ctrl+Alt+T"],
    ],
  },
  {
    group: "Navigation",
    keys: [
      ["Back / Forward", "Ctrl+[ / Ctrl+] or Alt+← / Alt+→", "Alt+← / Alt+→"],
      ["Enclosing folder", "Ctrl+↑ or Alt+↑", "Alt+↑"],
      ["Go to folder", "Ctrl+Shift+G"],
      ["Home / Desktop / Documents", "Ctrl+Shift+H / Ctrl+Shift+D / Ctrl+Shift+O"],
      ["Downloads / Applications", "Ctrl+Alt+L / Ctrl+Shift+A"],
      ["Search", "Ctrl+F", "Ctrl+F"],
      ["Refresh", "Ctrl+R or F5", "F5 or Ctrl+R"],
    ],
  },
  {
    group: "Tabs, panes and windows",
    keys: [
      ["New window", "Ctrl+N", "Ctrl+N"],
      ["New tab / Close tab", "Ctrl+T / Ctrl+W", "Ctrl+T / W"],
      ["Reopen closed tab", "Ctrl+Shift+T", "Ctrl+Shift+T"],
      ["Next / Previous tab", "Ctrl+Tab / Ctrl+Shift+Tab or Ctrl+Shift+] / Ctrl+Shift+[", "Ctrl+Tab / Ctrl+Shift+Tab"],
      ["Move tab left / right", "Ctrl+Shift+← / Ctrl+Shift+→", "Ctrl+Shift+← / →"],
      ["Split view", "Ctrl+\\"],
      ["Leave split view", "Esc"],
      ["Preview bar", "Ctrl+Shift+P", "Ctrl+Shift+P"],
      ["Switch to the other pane", "F6"],
      ["Folder tree", "Ctrl+Shift+E"],
      ["Close window", "Ctrl+Shift+W"],
    ],
  },
  {
    group: "View",
    keys: [
      ["Icons / List view / Columns", "Ctrl+1 / Ctrl+2 / Ctrl+3"],
      ["Larger / Smaller icons", "Ctrl+= / Ctrl+- or Ctrl+scroll", "Ctrl + scroll"],
      ["Show hidden files", "Ctrl+Shift+.", "Ctrl+H"],
      ["Command palette", "Ctrl+K", "Ctrl+K"],
      ["Settings", "Ctrl+,"],
      ["Keyboard shortcuts", "Ctrl+/"],
      ["Help", "Ctrl+?"],
    ],
  },
];
