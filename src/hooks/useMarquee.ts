import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTabs } from "../stores/tabs";
import { isDragHandle } from "../drag";
import { textScale } from "../util/textScale";
import {
  DETAILS_GUTTER,
  DETAILS_HEADER,
  GRID_GAP,
  GRID_PAD_TOP,
  GRID_PAD_X,
  gridColumns,
  layoutOf,
} from "./useVirtual";
import { rowAtY } from "../util/layout";
import type { FileEntry } from "../types";

const DRAG_THRESHOLD = 4;
const EDGE = 32;
const MAX_SCROLL = 28;
const ROW_INSET = 4;

interface Hits {
  indices: number[];
  key: string;
}

function hitItems(
  content: HTMLElement,
  grid: boolean,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): Hits {
  const list = content.querySelector<HTMLElement>(grid ? ".gview" : ".dtable");
  const layout = layoutOf(list);
  if (!layout || layout.rows.length === 0) return { indices: [], key: "none" };
  const k = textScale();
  const l = Math.min(x0, x1);
  const r = Math.max(x0, x1);
  const t = Math.min(y0, y1);
  const b = Math.max(y0, y1);

  let cols = 1;
  let left: number;
  let w: number;
  let gap = 0;
  let top: number;
  if (grid) {
    const padX = GRID_PAD_X * k;
    gap = GRID_GAP * k;
    const inner = content.clientWidth - padX * 2;
    cols = gridColumns(list);
    w = (inner - gap * (cols - 1)) / cols;
    top = GRID_PAD_TOP * k;
    left = padX;
  } else {
    const listW = list?.clientWidth ?? content.clientWidth;
    left = ROW_INSET * k;
    w = listW - DETAILS_GUTTER * k - ROW_INSET * 2 * k;
    top = DETAILS_HEADER * k;
  }

  let c0 = 0;
  let c1 = cols - 1;
  if (grid) {
    const cs = w + gap;
    c0 = Math.max(0, Math.floor((l - left) / cs));
    c1 = Math.min(cols - 1, Math.floor((r - left) / cs));
    if (l > left + c0 * cs + w) c0 += 1;
    if (r < left + c1 * cs) c1 -= 1;
  } else if (r < left || l > left + w) {
    return { indices: [], key: "none" };
  }

  const r0 = rowAtY(layout, (t - top) / k);
  const r1 = rowAtY(layout, (b - top) / k);
  const indices: number[] = [];
  for (let ri = r0; ri <= r1; ri++) {
    const row = layout.rows[ri];
    if (row.group) continue;
    const rowTop = top + row.top * k;
    if (rowTop + row.height * k < t || rowTop > b) continue;
    for (let c = c0; c <= c1; c++) {
      const i = row.start + c;
      if (i < row.end) indices.push(i);
    }
  }
  return { indices, key: `${r0}:${r1}:${c0}:${c1}:${indices.length}` };
}

export function useMarquee(
  contentRef: RefObject<HTMLElement | null>,
  entriesRef: RefObject<FileEntry[]>,
  grid: boolean
) {
  const [active, setActive] = useState(false);
  // The rectangle is drawn straight onto this element, once a frame, so
  // dragging it out doesn't re-render the folder view at every move. The
  // element is only in the list while a drag is on; `last` carries the
  // frame drawn before it mounted.
  const ref = useRef<HTMLDivElement | null>(null);
  const last = useRef<[number, number, number, number] | null>(null);
  const draw = (box: HTMLElement, r: [number, number, number, number]) => {
    box.style.left = `${r[0]}px`;
    box.style.top = `${r[1]}px`;
    box.style.width = `${r[2]}px`;
    box.style.height = `${r[3]}px`;
  };
  useLayoutEffect(() => {
    if (active && ref.current && last.current) draw(ref.current, last.current);
  }, [active]);
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const cleanup = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => () => cleanup.current?.(), []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const content = contentRef.current;
      if (!content) return;
      if (isDragHandle(e.target as HTMLElement)) return;
      if ((e.target as HTMLElement).closest(".dhead, button, input, textarea")) return;
      const box = content.getBoundingClientRect();
      if (
        e.clientX - box.left >= content.clientWidth ||
        e.clientY - box.top >= content.clientHeight
      ) {
        return;
      }

      const additive = e.metaKey || e.ctrlKey || e.shiftKey;
      const tabs = useTabs.getState();
      const startTab = tabs.tabs.find((t) => t.id === tabs.activeId);
      const base = additive ? [...(startTab?.selection ?? [])] : [];
      const baseAnchor = startTab?.anchor ?? null;
      const startX = e.clientX;
      const startY = e.clientY;
      const originX = e.clientX - box.left + content.scrollLeft;
      const originY = e.clientY - box.top + content.scrollTop;
      let px = e.clientX;
      let py = e.clientY;
      let active = false;
      let raf = 0;
      let lastKey = "";

      const frame = () => {
        raf = 0;
        const b = content.getBoundingClientRect();
        let dy = 0;
        if (py < b.top + EDGE) dy = -Math.min(MAX_SCROLL, (b.top + EDGE - py) / 2 + 2);
        else if (py > b.bottom - EDGE) dy = Math.min(MAX_SCROLL, (py - (b.bottom - EDGE)) / 2 + 2);
        if (dy) {
          const before = content.scrollTop;
          content.scrollTop += dy;
          // At the end of the list there is nothing left to scroll; the next
          // pointer move schedules a frame again.
          if (content.scrollTop === before) dy = 0;
        }

        const curX = Math.min(Math.max(px - b.left + content.scrollLeft, 0), content.scrollWidth);
        const curY = Math.min(Math.max(py - b.top + content.scrollTop, 0), content.scrollHeight);
        last.current = [
          Math.min(originX, curX),
          Math.min(originY, curY),
          Math.abs(curX - originX),
          Math.abs(curY - originY),
        ];
        if (ref.current) draw(ref.current, last.current);

        const list = entriesRef.current ?? [];
        const hits = hitItems(content, gridRef.current, originX, originY, curX, curY);
        if (hits.key !== lastKey) {
          lastKey = hits.key;
          const picked = hits.indices.map((i) => list[i].path);
          const merged = additive ? [...new Set([...base, ...picked])] : picked;
          useTabs.getState().setSelection(merged, picked[0] ?? baseAnchor);
        }
        if (dy) raf = requestAnimationFrame(frame);
      };
      const schedule = () => {
        if (!raf) raf = requestAnimationFrame(frame);
      };

      const onMove = (ev: MouseEvent) => {
        px = ev.clientX;
        py = ev.clientY;
        if (!active) {
          if (Math.hypot(px - startX, py - startY) < DRAG_THRESHOLD) return;
          active = true;
          setActive(true);
          content
            .querySelector<HTMLElement>("[role=grid], [role=listbox]")
            ?.focus({ preventScroll: true });
          if (!additive) useTabs.getState().setSelection([], null);
        }
        schedule();
      };
      const onScroll = () => {
        if (active) schedule();
      };
      const stop = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onUp);
        content.removeEventListener("scroll", onScroll);
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        cleanup.current = null;
        setActive(false);
      };
      const onUp = () => {
        const wasDrag = active;
        stop();
        if (wasDrag) {
          suppressClick.current = true;
          setTimeout(() => (suppressClick.current = false), 0);
        }
      };

      cleanup.current?.();
      cleanup.current = stop;
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("blur", onUp);
      content.addEventListener("scroll", onScroll);
    },
    [contentRef, entriesRef]
  );

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      e.stopPropagation();
    }
  }, []);

  return { active, ref, onMouseDown, onClickCapture };
}
