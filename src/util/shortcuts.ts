/**
 * The keyboard shortcut sheet (Help → Keyboard Shortcuts). Keep in step with docs/REFERENCE.md.
 * Each row is [action, Mac keys, Windows-style keys]. A row with no Windows key shows the Mac one.
 */
export const SHORTCUTS: { group: string; keys: [string, string, string?][] }[] = [
  {
    group: "Files",
    keys: [
      ["Open selection", "⌘↓ or Enter", "Enter"],
      ["Quick Look", "Space"],
      ["Properties", "⌘I or ⌥Enter", "Alt+Enter"],
      ["Rename (several items: batch rename)", "F2"],
      ["New folder / text document", "⌘⇧N / ⌘⌥N", "Ctrl+Shift+N / Ctrl+Alt+N"],
      ["New folder with selection", "⌃⌘N"],
      ["Duplicate", "⌘D", "Ctrl+D"],
      ["Reveal in Finder", "⌥⌘R"],
      ["Copy / Cut / Paste", "⌘C / ⌘X / ⌘V", "Ctrl+C / X / V"],
      ["Move item here", "⌘⌥V"],
      ["Activity: paste or undo", "⌘⇧V", "Ctrl+Shift+V"],
      ["Copy as path", "⌥⌘C", "Ctrl+Alt+C"],
      ["Move to Trash", "⌘⌫ or Delete", "Delete"],
      ["Delete immediately", "⌘⌥⌫ or ⇧Delete", "Shift+Delete"],
      ["Undo / Redo", "⌘Z / ⇧⌘Z", "Ctrl+Z / Ctrl+Shift+Z"],
      ["Select all", "⌘A", "Ctrl+A"],
      ["Select by pattern / Invert selection", "⌘⇧S / ⌘⇧I"],
      ["Open in terminal", "⌥⌘T"],
    ],
  },
  {
    group: "Navigation",
    keys: [
      ["Back / Forward", "⌘[ / ⌘] or ⌥← / ⌥→", "Alt+← / Alt+→"],
      ["Enclosing folder", "⌘↑ or ⌥↑", "Alt+↑"],
      ["Go to folder", "⌘⇧G"],
      ["Home / Desktop / Documents", "⌘⇧H / ⌘⇧D / ⌘⇧O"],
      ["Downloads / Applications", "⌘⌥L / ⌘⇧A"],
      ["Search", "⌘F", "Ctrl+F"],
      ["Refresh", "⌘R or F5", "F5 or Ctrl+R"],
    ],
  },
  {
    group: "Tabs, panes and windows",
    keys: [
      ["New window", "⌘N", "Ctrl+N"],
      ["New tab / Close tab", "⌘T / ⌘W", "Ctrl+T / W"],
      ["Reopen closed tab", "⌘⇧T", "Ctrl+Shift+T"],
      ["Next / Previous tab", "⌃Tab / ⌃⇧Tab or ⌘⇧] / ⌘⇧[", "Ctrl+Tab / Ctrl+Shift+Tab"],
      ["Move tab left / right", "⌘⇧← / ⌘⇧→", "Ctrl+Shift+← / →"],
      ["Split view", "⌘\\"],
      ["Preview bar", "⇧⌘P", "Ctrl+Shift+P"],
      ["Switch to the other pane", "F6"],
      ["Folder tree", "⌘⇧E"],
      ["Close window", "⌘⇧W"],
    ],
  },
  {
    group: "View",
    keys: [
      ["Icons / List view / Columns", "⌘1 / ⌘2 / ⌘3"],
      ["Larger / Smaller icons", "⌘= / ⌘- or ⌘ + scroll", "Ctrl + scroll"],
      ["Show hidden files", "⌘⇧.", "Ctrl+H"],
      ["Command palette", "⌘K", "Ctrl+K"],
      ["Settings", "⌘,"],
      ["Keyboard shortcuts", "⌘/"],
      ["Help", "⌘?"],
    ],
  },
];
