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
  activateEntry,
  paste,
  redoLast,
  refreshByUser,
  selectAll,
  startRename,
  undoLast,
  propertiesForSelection,
  duplicateSelection,
  openNewWindow,
} from "../actions";
import { api } from "../ipc";
import { uncut } from "../stores/clipboard";
import { focusPane, paneAt, paneStore, reopenClosedTab, useTabs } from "../stores/tabs";
import { useSettings } from "../stores/settings";
import { activeModal, useUI } from "../stores/ui";
import { swipeTracker } from "../util/swipe";

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
        // Cancel a pending cut, as Explorer does.
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
        reopenClosedTab();
        return;
      }
      if (ctrl && e.altKey && e.code === "KeyN") {
        e.preventDefault();
        newFile();
        return;
      }
      // Ctrl+Tab on both systems. ⌘⇧[ and ⌘⇧] as in browsers.
      if (e.ctrlKey && !e.metaKey && e.key === "Tab") {
        e.preventDefault();
        tabs.cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (ctrl && e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        e.preventDefault();
        tabs.cycleTab(e.code === "BracketRight" ? 1 : -1);
        return;
      }
      if (ctrl && !e.shiftKey && !e.altKey && key === "d") {
        e.preventDefault();
        void duplicateSelection();
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
            if (e.shiftKey) useUI.getState().setClipHistoryOpen(true);
            else void paste(e.altKey);
            return;
          case "z":
            e.preventDefault();
            void (e.shiftKey ? redoLast() : undoLast());
            return;
          case "a":
            // The menu bar owns ⌘⇧A (Applications) and ⌘⇧W (Close Window).
            if (e.shiftKey) return;
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
          case "k":
            // ⌘K comes from the menu bar. Ctrl+K is the Windows-style key.
            if (!e.metaKey) {
              e.preventDefault();
              useUI.getState().setPaletteOpen(true);
            }
            return;
          case "h":
            if (!e.metaKey) {
              e.preventDefault();
              useSettings
                .getState()
                .set({ showHidden: !useSettings.getState().showHidden });
            }
            return;
          case "t":
            e.preventDefault();
            tabs.newTab();
            return;
          case "n":
            e.preventDefault();
            void openNewWindow();
            return;
          case "w":
            if (e.shiftKey) return;
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
            // Alt+Enter is shown as Properties in the context menu.
            propertiesForSelection();
            break;
          }
          if (active.selection.length === 1) {
            const entry = getViewEntries().find(
              (x) => x.path === active.selection[0]
            );
            if (entry) activateEntry(entry);
          }
          break;
        }
        default:
          break;
      }
    };
    // The mouse side buttons (3 = back, 4 = forward) go Back and Forward in the pane under the pointer.
    const onMouseUp = (e: MouseEvent) => {
      if ((e.button !== 3 && e.button !== 4) || activeModal()) return;
      e.preventDefault();
      const pane = paneAt(e.clientX, e.clientY);
      focusPane(pane);
      paneStore(pane).getState().go(e.button === 3 ? -1 : 1);
    };
    // A sideways two-finger swipe over the file area goes Back and Forward in that pane, as in Finder.
    let swipePane = 0;
    let swipeFrame: HTMLElement | null = null;
    const canGo = (pane: number, dir: number) => {
      const s = paneStore(pane).getState();
      const tab = s.tabs.find((t) => t.id === s.activeId);
      const i = (tab?.historyIndex ?? 0) + dir;
      return !!tab && i >= 0 && i < tab.history.length;
    };
    // An arrow grows at the edge the swipe goes to, so the user sees it coming and can swipe back to stop.
    const showSwipe = (p: number) => {
      if (!swipeFrame) return;
      const dir = p < 0 ? -1 : 1;
      const on = p !== 0 && canGo(swipePane, dir);
      if (on) swipeFrame.dataset.swipe = dir < 0 ? "back" : "forward";
      swipeFrame.style.setProperty("--swipe", on ? Math.abs(p).toFixed(3) : "0");
    };
    const swipes = swipeTracker(
      (dir) => {
        focusPane(swipePane);
        paneStore(swipePane).getState().go(dir);
      },
      { distance: 180, onProgress: showSwipe }
    );
    const onWheel = (e: WheelEvent) => {
      // A mostly sideways move only: a diagonal scroll down a list is not a swipe.
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaX) <= 2 * Math.abs(e.deltaY) || activeModal()) return;
      if (!useSettings.getState().swipeNavigation) return;
      const frame = e.target instanceof Element ? e.target.closest<HTMLElement>(".content-frame") : null;
      if (!frame) return;
      // A list that scrolls sideways (columns, a wide table) keeps the swipe for itself.
      for (let el = e.target as Element | null; el && el !== frame.parentElement; el = el.parentElement) {
        if (el.scrollWidth > el.clientWidth && /auto|scroll/.test(getComputedStyle(el).overflowX)) return;
      }
      if (swipeFrame !== frame) swipeFrame?.style.setProperty("--swipe", "0");
      swipeFrame = frame;
      swipePane = paneAt(e.clientX, e.clientY);
      swipes.feed(e.deltaX);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("wheel", onWheel);
      swipes.cancel();
    };
  }, []);
}
