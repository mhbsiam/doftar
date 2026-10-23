import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  deleteSelection,
  getViewEntries,
  newFile,
  newFolder,
  openEntry,
  paste,
  propertiesForSelection,
  redoLast,
  refreshSoon,
  selectAll,
  startRename,
  compressSelection,
  openTerminalHere,
  extractSelection,
  undoLast,
} from "../actions";
import { api } from "../ipc";
import { folderMapUp } from "../components/FolderMap";
import { topOf, useHistory } from "../stores/history";
import { joinName, toggleSplit, useTabs } from "../stores/tabs";
import { useSettings } from "../stores/settings";
import { setFolderView } from "./useFolderView";
import { activeModal, useUI } from "../stores/ui";
import { flushAppData, useAppData } from "../stores/appdata";

export const EDIT_ADDRESS_EVENT = "wf:edit-address";
export const ZOOM_EVENT = "wf:zoom";

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
    // The menu bar is shared, so it follows whichever window is in front.
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
    // Window-scoped: the backend sends menu commands to the front window only.
    const unlisten = getCurrentWebviewWindow().listen<string>("menu", ({ payload: id }) => {
      if (id === "quit") {
        // Sent by the backend when a native quit is requested: save the
        // debounced favorites/recents first, then let the app exit.
        void flushAppData().finally(() => api.quit().catch(() => {}));
        return;
      }
      const tabs = useTabs.getState();
      const field = focusedTextField();
      const modal = activeModal();
      // A context menu doesn't block the menu bar: choosing from it there
      // closes the context menu and runs the command as usual.
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
      switch (id) {
        case "new_tab":
          tabs.newTab();
          return;
        case "close_tab":
          tabs.closeTab(tabs.activeId);
          return;
        case "new_folder":
          newFolder();
          return;
        case "new_file":
          newFile();
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
        case "compress":
          compressSelection();
          return;
        case "open_terminal":
          if (!field) openTerminalHere();
          return;
        case "extract":
          extractSelection();
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
        case "toggle_nav_pane":
          tabs.toggleNavPane();
          return;
        case "toggle_split":
          toggleSplit();
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
          useUI.getState().openConfirm({
            title: "Keyboard shortcuts",
            message:
              "⌘T new tab · ⌘W close tab · ⌘⇧N new folder · ⌘↓ open · ⌘I properties · " +
              "⌘⌫ move to Trash · ⌘⌥⌫ delete immediately · ⌘C/⌘X/⌘V copy, cut, paste (also with Finder) · ⌘⌥V move here · ⌘Z / ⇧⌘Z undo, redo · " +
              "⌥⌘T open in terminal · ⌘A select all · ⌘⇧. hidden files · ⌘R refresh · ⌘[ / ⌘] back / forward · " +
              "⌘↑ enclosing folder · ⌘⇧G go to folder · F2 rename · Delete / ⇧Delete also work.",
            confirmLabel: "OK",
            hideCancel: true,
            onConfirm: () => {},
          });
          return;
        default:
          return;
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);
}
