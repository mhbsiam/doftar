import { useLayoutEffect, useRef, type RefObject } from "react";
import { itemDomId } from "./useListNav";
import { usePane } from "../stores/tabs";
import {
  DETAILS_HEADER,
  DETAILS_ROW,
  GRID_GAP,
  GRID_MIN_W,
  GRID_PAD_TOP,
  GRID_PAD_X,
  GRID_TILE_H,
  type VirtualWindow,
} from "./useVirtual";
import { textScale } from "../util/textScale";
import type { Layout } from "../util/layout";
import { EASE, dur } from "../util/motion";
import type { FileEntry } from "../types";
import { isFlying } from "../flight";

const MAX_ENTRIES = 5000;
const MAX_TRAVEL_ROWS = 12;
const MAX_TOUCHED = 150;
const MAX_GHOSTS = 24;
const INITIAL_GRACE_MS = 1500;

interface Snapshot {
  scope: string;
  since: number;
  entries: FileEntry[];
  index: Map<string, number> | null;
  win: VirtualWindow;
  layout: Layout;
  nodes: Map<string, HTMLElement>;
}

interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
}

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function slotter(grid: boolean, cols: number, width: number, k: number) {
  const gap = GRID_GAP * k;
  const tileW = Math.max(
    GRID_MIN_W * k,
    (width - 2 * GRID_PAD_X * k - (cols - 1) * gap) / cols
  );
  return (i: number, layout: Layout): Slot => {
    const row = layout.rows[layout.rowOf[i]];
    if (!row) return { x: 0, y: 0, w: 0, h: 0 };
    if (!grid) {
      return { x: 0, y: (DETAILS_HEADER + row.top) * k, w: 0, h: DETAILS_ROW * k };
    }
    return {
      x: GRID_PAD_X * k + (i - row.start) * (tileW + gap),
      y: (GRID_PAD_TOP + row.top) * k,
      w: tileW,
      h: GRID_TILE_H * k,
    };
  };
}

export function useRowMotion(opts: {
  listRef: RefObject<HTMLElement | null>;
  ghostRef: RefObject<HTMLElement | null>;
  entries: FileEntry[];
  win: VirtualWindow;
  scope: string;
  grid: boolean;
}) {
  const { listRef, ghostRef, entries, win, scope, grid } = opts;
  const pane = usePane();
  const snap = useRef<Snapshot | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const prev = snap.current;
    const index =
      entries.length <= MAX_ENTRIES
        ? new Map(entries.map((e, i) => [e.path, i] as const))
        : null;
    const nodes = new Map<string, HTMLElement>();
    for (let i = win.first; i < win.last; i++) {
      const el = document.getElementById(itemDomId(i, pane));
      if (el && entries[i]) nodes.set(entries[i].path, el);
    }
    const sameScope = prev !== null && prev.scope === scope;
    snap.current = {
      scope,
      since: sameScope ? prev.since : performance.now(),
      entries,
      index,
      win,
      layout: win.layout,
      nodes,
    };

    if (
      !prev ||
      !sameScope ||
      prev.entries === entries ||
      !prev.index ||
      !index ||
      reducedMotion()
    ) {
      return;
    }
    if (
      prev.entries.length === 0 &&
      performance.now() - prev.since < INITIAL_GRACE_MS
    ) {
      return;
    }

    const old = prev.index;
    const moved: number[] = [];
    const entered: number[] = [];
    const exited: number[] = [];
    const end = Math.min(win.last, entries.length);
    for (let i = win.first; i < end; i++) {
      const oi = old.get(entries[i].path);
      if (oi === undefined) entered.push(i);
      else if (oi !== i) moved.push(i);
    }
    for (let oi = prev.win.first; oi < prev.win.last; oi++) {
      const e = prev.entries[oi];
      if (e && !index.has(e.path)) exited.push(oi);
    }
    const touched = moved.length + entered.length + exited.length;
    if (touched === 0 || touched > MAX_TOUCHED) return;

    const k = textScale();
    const slowMs = dur("slow");
    const baseMs = dur("base");
    const cols = Math.max(1, win.cols);
    const slot = slotter(grid, cols, list.clientWidth, k);
    const reach = MAX_TRAVEL_ROWS * (grid ? GRID_TILE_H + GRID_GAP : DETAILS_ROW) * k;

    for (const i of moved) {
      const el = document.getElementById(itemDomId(i, pane));
      if (!el) continue;
      const from = slot(old.get(entries[i].path)!, prev.layout);
      const to = slot(i, win.layout);
      const dx = from.x - to.x;
      const dy = from.y - to.y;
      if (Math.hypot(dx, dy) > reach) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: slowMs,
          easing: EASE,
        });
      } else {
        el.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: "translate(0, 0)" },
          ],
          { duration: slowMs, easing: EASE }
        );
      }
    }

    for (const i of entered) {
      // An item flying in arrives by itself.
      if (isFlying(entries[i].path)) continue;
      document.getElementById(itemDomId(i, pane))?.animate(
        [
          { opacity: 0, transform: "translateY(-0.357rem)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: slowMs, easing: EASE }
      );
    }

    const layer = ghostRef.current;
    if (!layer) return;
    let ghosts = 0;
    for (const oi of exited) {
      if (ghosts >= MAX_GHOSTS) break;
      // An item flying out has its own copy on the way.
      if (isFlying(prev.entries[oi].path)) continue;
      const node = prev.nodes.get(prev.entries[oi].path);
      if (!node || node.querySelector("input.rename-input")) continue;
      const at = slot(oi, prev.layout);
      const ghost = node.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("id");
      ghost.removeAttribute("role");
      ghost.setAttribute("aria-hidden", "true");
      ghost.classList.remove("cursor", "spring");
      ghost.classList.add("ghost");
      ghost.style.top = `${at.y}px`;
      if (grid) {
        ghost.style.left = `${at.x}px`;
        ghost.style.width = `${at.w}px`;
        ghost.style.height = `${at.h}px`;
      }
      layer.appendChild(ghost);
      ghosts++;
      const gone = () => ghost.remove();
      ghost
        .animate(
          [
            { opacity: 1, transform: "none" },
            { opacity: 0, transform: "translateX(-0.571rem)" },
          ],
          { duration: baseMs, easing: EASE, fill: "forwards" }
        )
        .finished.then(gone, gone);
    }
  }, [listRef, ghostRef, entries, win.first, win.last, win.cols, win.layout, scope, grid]);
}
