import { useCallback, useEffect, useRef } from "react";
import { usePane, usePanes, useTabs } from "../stores/tabs";
import { layoutOf, scrollToIndex } from "./useVirtual";
import { moveByRows } from "../util/layout";
import { quickLookSelection } from "../actions";
import { textScale } from "../util/textScale";
import type { FileEntry } from "../types";

/** The element id of a row or tile. It differs in each half of a split. */
export function itemDomId(index: number, pane: number): string {
  return `wf-item-${pane}-${index}`;
}

interface Opts {
  entries: FileEntry[];
  grid: boolean;
  cursor: string | null;
  setCursor: (path: string | null) => void;
  setKbd: (on: boolean) => void;
  openMenu: (x: number, y: number, entry: FileEntry) => void;
}

export function useListNav(opts: Opts) {
  const ref = useRef(opts);
  ref.current = opts;
  const ahead = useRef({ buf: "", at: 0 });
  useEffect(() => {
    ahead.current = { buf: "", at: 0 };
  }, [opts.entries]);

  return useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    const { entries, grid, cursor, setCursor, setKbd, openMenu } = ref.current;
    const n = entries.length;
    if (n === 0) return;

    const tabs = useTabs.getState();
    const tab = tabs.tabs.find((t) => t.id === tabs.activeId);
    if (!tab) return;

    let idx = cursor ? entries.findIndex((x) => x.path === cursor) : -1;
    if (idx < 0 && tab.selection.length > 0) {
      const last = tab.selection[tab.selection.length - 1];
      idx = entries.findIndex((x) => x.path === last);
    }

    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      if (idx < 0) return;
      e.preventDefault();
      const r = document.getElementById(itemDomId(idx, tabs.pane))?.getBoundingClientRect();
      openMenu(r ? r.left + 32 : 120, r ? r.bottom : 120, entries[idx]);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const go = (next: number) => {
      const target = entries[next];
      if (e.shiftKey) {
        const anchorPath = tab.anchor ?? entries[idx < 0 ? next : idx].path;
        const a = entries.findIndex((x) => x.path === anchorPath);
        const lo = Math.min(a < 0 ? next : a, next);
        const hi = Math.max(a < 0 ? next : a, next);
        tabs.setSelection(
          entries.slice(lo, hi + 1).map((x) => x.path),
          anchorPath
        );
      } else {
        tabs.setSelection([target.path], target.path);
      }
      setCursor(target.path);
      setKbd(true);
      scrollToIndex(e.currentTarget, next, grid);
    };

    const layout = layoutOf(e.currentTarget);
    const vertical = (from: number, rows: number) =>
      layout ? moveByRows(layout, from, rows) : Math.min(n - 1, Math.max(0, from + rows));
    const viewport =
      e.currentTarget.closest<HTMLElement>(".content")?.clientHeight ?? 400;
    const pageRows = Math.max(
      1,
      Math.floor(viewport / ((grid ? 122 : 34) * textScale())) - 1
    );
    const from = idx < 0 ? 0 : idx;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        go(idx < 0 ? 0 : vertical(idx, 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        go(idx < 0 ? 0 : vertical(idx, -1));
        return;
      case "ArrowRight":
        if (!grid) return;
        e.preventDefault();
        go(idx < 0 ? 0 : Math.min(n - 1, idx + 1));
        return;
      case "ArrowLeft":
        if (!grid) return;
        e.preventDefault();
        go(idx < 0 ? 0 : Math.max(0, idx - 1));
        return;
      case "Home":
        e.preventDefault();
        go(0);
        return;
      case "End":
        e.preventDefault();
        go(n - 1);
        return;
      case "PageDown":
        e.preventDefault();
        go(vertical(from, pageRows));
        return;
      case "PageUp":
        e.preventDefault();
        go(vertical(from, -pageRows));
        return;
      case " ":
        e.preventDefault();
        if (!e.repeat) quickLookSelection();
        return;
    }

    if (e.key.length === 1 && !e.shiftKey) {
      const now = Date.now();
      const t = ahead.current;
      t.buf = now - t.at > 700 ? e.key : t.buf + e.key;
      t.at = now;
      const needle = t.buf.toLowerCase();
      const start = t.buf.length === 1 ? idx + 1 : Math.max(idx, 0);
      for (let k = 0; k < n; k++) {
        const i = (start + k) % n;
        if (entries[i].name.toLowerCase().startsWith(needle)) {
          e.preventDefault();
          go(i);
          return;
        }
      }
    }
  }, []);
}

export function useRefocusAfterRename(
  listRef: React.RefObject<HTMLElement | null>,
  renaming: string | null
) {
  const pane = usePane();
  const prev = useRef<string | null>(null);
  useEffect(() => {
    const active = document.activeElement;
    const list = listRef.current;
    // A click on the other pane ended this rename: leave focus there.
    const here = usePanes.getState().focused === pane;
    if (prev.current && !renaming && list && here && (!active || active === document.body)) {
      // Enter made this focus count as keyboard focus. Hide the ring until the next key, as the user did not move focus.
      list.dataset.quiet = "";
      const loud = () => delete list.dataset.quiet;
      list.addEventListener("keydown", loud, { once: true });
      list.addEventListener("blur", loud, { once: true });
      list.focus({ preventScroll: true });
    }
    prev.current = renaming;
  }, [renaming, listRef, pane]);
}
