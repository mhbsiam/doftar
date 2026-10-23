import { useEffect } from "react";
import {
  copyAsPath,
  openTerminalHere,
  copySelection,
  cutSelection,
  deleteSelection,
  getViewEntries,
  newFolder,
  newFile,
  openEntry,
  paste,
  redoLast,
  refreshByUser,
  selectAll,
  startRename,
  undoLast,
  propertiesForSelection,
} from "../actions";
import { api } from "../ipc";
import { uncut } from "../stores/clipboard";
import { useTabs } from "../stores/tabs";
import { useSettings } from "../stores/settings";
import { activeModal, useUI } from "../stores/ui";

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.metaKey || e.ctrlKey;
      const tabs = useTabs.getState();
      const active = tabs.tabs.find((t) => t.id === tabs.activeId);

      if (e.key === "Escape") {
        void api.quicklookClose().catch(() => {});
        tabs.setRenaming(null);
        // Calls a pending cut off, as Explorer does.
        if (!isEditable(e.target)) uncut();
        return;
      }
      if (isEditable(e.target)) return;
      if (!active) return;
      if (activeModal()) return;

      const key = e.key.toLowerCase();

      if (ctrl && e.shiftKey && key === "n") {
        e.preventDefault();
        newFolder();
        return;
      }
      if (ctrl && e.shiftKey && key === "t") {
        e.preventDefault();
        newFile();
        return;
      }

      if (e.metaKey && e.altKey && e.code === "KeyT") {
        e.preventDefault();
        openTerminalHere();
        return;
      }

      if (ctrl && e.altKey && e.code === "KeyC") {
        e.preventDefault();
        copyAsPath();
        return;
      }

      if (ctrl) {
        switch (key) {
          case "c":
            e.preventDefault();
            copySelection();
            return;
          case "x":
            e.preventDefault();
            cutSelection();
            return;
          case "v":
            e.preventDefault();
            void paste(e.altKey);
            return;
          case "z":
            e.preventDefault();
            void (e.shiftKey ? redoLast() : undoLast());
            return;
          case "a":
            e.preventDefault();
            selectAll();
            return;
          case "f": {
            e.preventDefault();
            const box = document.getElementById(`wf-search-input-${tabs.pane}`) as HTMLInputElement | null;
            if (box?.disabled) useUI.getState().pushToast("Open a folder to search");
            else box?.focus();
            return;
          }
          case "h":
            if (!e.metaKey) {
              e.preventDefault();
              useSettings
                .getState()
                .set({ showHidden: !useSettings.getState().showHidden });
            }
            return;
          case "t":
          case "n":
            e.preventDefault();
            tabs.newTab();
            return;
          case "w":
            e.preventDefault();
            tabs.closeTab(tabs.activeId);
            return;
          case "r":
            e.preventDefault();
            refreshByUser();
            return;
          case "backspace":
            e.preventDefault();
            deleteSelection(e.altKey);
            return;
          default:
            if (e.key === "F5") {
              e.preventDefault();
              refreshByUser();
            }
            return;
        }
      }

      switch (e.key) {
        case "F2":
          e.preventDefault();
          startRename();
          break;
        case "F5":
          e.preventDefault();
          refreshByUser();
          break;
        case "Delete":
          if ((e.target as HTMLElement | null)?.closest("[role=tab]")) break;
          e.preventDefault();
          deleteSelection(e.shiftKey);
          break;
        case "Backspace":
          if (e.altKey) {
            e.preventDefault();
            tabs.goUp();
          }
          break;
        case "ArrowLeft":
          if (e.altKey) {
            e.preventDefault();
            tabs.go(-1);
          }
          break;
        case "ArrowRight":
          if (e.altKey) {
            e.preventDefault();
            tabs.go(1);
          }
          break;
        case "ArrowUp":
          if (e.altKey) {
            e.preventDefault();
            tabs.goUp();
          }
          break;
        case "Enter": {
          if (active.selection.length === 0) break;
          const el = e.target as HTMLElement | null;
          if (el && el.closest("button, input, [role=menuitem], [role=menu], [role=tab]")) {
            break;
          }
          e.preventDefault();
          if (e.altKey) {
            // Alt+Enter is advertised as Properties in the context menu.
            propertiesForSelection();
            break;
          }
          if (active.selection.length === 1) {
            const entry = getViewEntries().find(
              (x) => x.path === active.selection[0]
            );
            if (entry) openEntry(entry);
          }
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
