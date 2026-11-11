import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  copyDiagnostics,
  deleteSelection,
  diagnosticsCopied,
  showError,
  getViewEntries,
  newFile,
  newFolder,
  newFolderWithSelection,
  sendSelectionTo,
  invertSelection,
  openEntry,
  paste,
  propertiesForSelection,
  redoLast,
  refreshSoon,
  selectAll,
  startRename,
  compressSelection,
  exportShotList,
  openTerminalHere,
  extractSelection,
  showFolderTreeHere,
  togglePreview,
  compareSplitFolders,
  compareSelectedFiles,
  undoLast,
  openNewWindow,
  duplicateSelection,
  revealInFinder,
} from "../actions";
import { api } from "../ipc";
import { folderMapUp } from "../components/FolderMap";
import { ZOOM_EVENT } from "../components/CaptionButtons";
import { topOf, useHistory } from "../stores/history";
import { focusPane, joinName, reopenClosedTab, toggleSplit, usePanes, useTabs } from "../stores/tabs";
import { useSettings } from "../stores/settings";
import { setFolderView, stepIconSize } from "./useFolderView";
import { activeModal, useUI } from "../stores/ui";
import { flushAppData, useAppData } from "../stores/appdata";
import { saveSessionNow } from "../session";

export const EDIT_ADDRESS_EVENT = "wf:edit-address";

function switchPane() {
  const { split, focused } = usePanes.getState();
  if (!split) return;
  const other = 1 - focused;
  focusPane(other);
  const content = document.querySelector<HTMLElement>(`.pane[data-pane="${other}"] .content`);
  (content?.querySelector<HTMLElement>('[tabindex="0"]') ?? content)?.focus();
}

type TextField = HTMLInputElement | HTMLTextAreaElement;

function focusedTextField(): TextField | null {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && el.type !== "checkbox") return el;
  return null;
}

function replaceRange(el: TextField, start: number, end: number) {
  el.setRangeText("", start, end, "end");
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function goToHomeChild(name: string) {
  const home = useAppData.getState().home;
  useTabs.getState().navigate({ kind: "path", path: joinName(home, name) });
}

export function useMenuEvents() {
  useEffect(() => {
    const push = () => {
      const { undo, redo } = useHistory.getState();
      void api
        .setUndoLabels(topOf(undo)?.label ?? null, topOf(redo)?.label ?? null)
        .catch(() => {});
    };
    push();
    // The menu bar is shared, so it follows the front window.
    const unfocus = getCurrentWebviewWindow().onFocusChanged(({ payload }) => {
      if (payload) push();
    });
    const unsub = useHistory.subscribe((s, prev) => {
      if (s.undo !== prev.undo || s.redo !== prev.redo) push();
    });
    return () => {
      unsub();
      void unfocus.then((f) => f());
    };
  }, []);

  useEffect(() => {
    // The backend sends menu commands to the front window only.
    const unlisten = getCurrentWebviewWindow().listen<string>("menu", ({ payload: id }) => {
      if (id === "quit") {
        // The backend sends this on a native quit. Save the debounced favorites and recents, then let the app exit.
        saveSessionNow();
        void flushAppData().finally(() => api.quit().catch(() => {}));
        return;
      }
      // Results of a copy the backend already did, so an open dialog must not stop them.
      if (id === "diagnostics_copied") {
        diagnosticsCopied();
        return;
      }
      if (id === "diagnostics_not_copied") {
        showError("Couldn't copy diagnostic info");
        return;
      }
      const field = focusedTextField();
      const modal = activeModal();
      if (id === "palette") {
        const ui = useUI.getState();
        if (modal === "palette") ui.setPaletteOpen(false);
        else if (!modal || modal === "menu") {
          ui.closeContextMenu();
          ui.setPaletteOpen(true);
        }
        return;
      }
      // A context menu does not block the menu bar. A choice there closes the context menu and runs the command.
      if (modal === "menu") useUI.getState().closeContextMenu();
      else if (modal) {
        if (!field) return;
        switch (id) {
          case "undo":
          case "redo":
            document.execCommand(id);
            return;
          case "select_all":
            field.select();
            return;
          case "move_to_trash":
          case "delete_now": {
            const { selectionStart: s, selectionEnd: e } = field;
            if (s !== null && e !== null) replaceRange(field, s === e ? 0 : s, e);
            return;
          }
          default:
            return;
        }
      }
      runCommand(id, field);
    });
    // The Dock menu can reach a hidden window with a modal open, so this skips the checks above.
    const unDock = getCurrentWebviewWindow().listen<string>("dock", ({ payload: place }) => {
      const path = place.startsWith("/") ? place : joinName(useAppData.getState().home, place);
      void openNewWindow(place ? { kind: "path", path } : undefined);
    });
    return () => {
      void unlisten.then((f) => f());
      void unDock.then((f) => f());
    };
  }, []);
}

/**
 * Runs menu command `id` in the front window. The command palette uses it too.
 * `field` is the focused text field. Some commands act on it.
 */
export function runCommand(id: string, field: TextField | null = focusedTextField()) {
  const tabs = useTabs.getState();
  switch (id) {
    case "new_tab":
      tabs.newTab();
      return;
    case "close_tab":
      tabs.closeTab(tabs.activeId);
      return;
    case "reopen_tab":
      reopenClosedTab();
      return;
    case "next_tab":
      tabs.cycleTab(1);
      return;
    case "prev_tab":
      tabs.cycleTab(-1);
      return;
    case "new_window":
      void openNewWindow();
      return;
    case "new_folder":
      newFolder();
      return;
    case "new_file":
      newFile();
      return;
    case "new_folder_selection":
      if (!field) void newFolderWithSelection();
      return;
    case "move_to":
      if (!field) sendSelectionTo("move");
      return;
    case "copy_to":
      if (!field) sendSelectionTo("copy");
      return;
    case "toggle_verify_copies": {
      const s = useSettings.getState();
      s.set({ verifyCopies: !s.verifyCopies });
      useUI.getState().pushToast(
        s.verifyCopies
          ? "Copies to other drives are no longer verified"
          : "Copies and moves to other drives are now read back and compared. They take about twice as long."
      );
      return;
    }
    case "select_pattern":
      if (!field) useUI.getState().setSelectPatternOpen(true);
      return;
    case "invert_selection":
      if (!field) invertSelection();
      return;
    case "open": {
      if (field) return;
      const tab = tabs.tabs.find((t) => t.id === tabs.activeId);
      if (tab?.selection.length !== 1) return;
      const entry = getViewEntries().find((e) => e.path === tab.selection[0]);
      if (entry) openEntry(entry);
      return;
    }
    case "get_info":
      propertiesForSelection();
      return;
    case "rename":
      startRename();
      return;
    case "duplicate":
      if (!field) void duplicateSelection();
      return;
    case "reveal_in_finder":
      if (!field) revealInFinder();
      return;
    case "compress":
      compressSelection();
      return;
    case "open_terminal":
      if (!field) openTerminalHere();
      return;
    case "extract":
      extractSelection();
      return;
    case "folder_tree":
      showFolderTreeHere();
      return;
    case "compare_folders":
      compareSplitFolders();
      return;
    case "compare_files":
      compareSelectedFiles();
      return;
    case "export_shot_list":
      void exportShotList();
      return;
    case "move_to_trash":
    case "delete_now":
      if (field) {
        const { selectionStart: s, selectionEnd: e } = field;
        if (s !== null && e !== null) replaceRange(field, s === e ? 0 : s, e);
        return;
      }
      deleteSelection(id === "delete_now");
      return;
    case "undo":
    case "redo":
      if (field) document.execCommand(id);
      else void (id === "undo" ? undoLast() : redoLast());
      return;
    case "paste_move":
      if (!field) void paste(true);
      return;
    case "clip_history":
      if (!field) useUI.getState().setClipHistoryOpen(true);
      return;
    case "select_all":
      if (field) field.select();
      else selectAll();
      return;
    case "view_grid":
      setFolderView({ viewMode: "grid" });
      return;
    case "view_details":
      setFolderView({ viewMode: "details" });
      return;
    case "view_columns":
      setFolderView({ viewMode: "columns" });
      return;
    case "icons_larger":
      stepIconSize(1);
      return;
    case "icons_smaller":
      stepIconSize(-1);
      return;
    case "toggle_hidden": {
      const s = useSettings.getState();
      s.set({ showHidden: !s.showHidden });
      return;
    }
    case "toggle_checkboxes": {
      const s = useSettings.getState();
      s.set({ showCheckboxes: !s.showCheckboxes });
      return;
    }
    case "toggle_item_info": {
      const s = useSettings.getState();
      s.set({ gridItemInfo: !s.gridItemInfo });
      return;
    }
    case "toggle_nav_pane":
      tabs.toggleNavPane();
      return;
    case "toggle_split":
      toggleSplit();
      return;
    case "toggle_preview":
      togglePreview();
      return;
    case "refresh":
      refreshSoon();
      return;
    case "back":
      if (!field) tabs.go(-1);
      return;
    case "forward":
      if (!field) tabs.go(1);
      return;
    case "up":
      if (field) field.setSelectionRange(0, 0);
      else if (!folderMapUp()) tabs.goUp();
      return;
    case "go_home_page":
      tabs.navigate({ kind: "home" });
      return;
    case "go_home_folder":
      tabs.navigate({ kind: "path", path: useAppData.getState().home });
      return;
    case "go_desktop":
      goToHomeChild("Desktop");
      return;
    case "go_documents":
      goToHomeChild("Documents");
      return;
    case "go_downloads":
      goToHomeChild("Downloads");
      return;
    case "go_applications":
      tabs.navigate({ kind: "path", path: "/Applications" });
      return;
    case "go_to_folder":
      window.dispatchEvent(new Event(EDIT_ADDRESS_EVENT));
      return;
    case "zoom":
      window.dispatchEvent(new Event(ZOOM_EVENT));
      return;
    case "shortcuts":
      useUI.getState().setShortcutsOpen(true);
      return;
    case "settings":
      useUI.getState().setSettingsOpen(true);
      return;
    case "help":
      useUI.getState().setHelpOpen(true);
      return;
    case "copy_diagnostics":
      copyDiagnostics();
      return;
    case "switch_pane":
      switchPane();
      return;
    default:
      return;
  }
}
