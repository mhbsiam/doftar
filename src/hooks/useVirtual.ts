import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useSettings } from "../stores/settings";
import { textScale } from "../util/textScale";
import {
  buildLayout,
  rowAtY,
  type Geometry,
  type Group,
  type Layout,
} from "../util/layout";
import type { FileEntry } from "../types";

export const DETAILS_ROW = 34;
export const DETAILS_HEADER = 32;
export const DETAILS_GUTTER = 36;
export const DETAILS_GROUP_H = 36;
export const GRID_GROUP_H = 36;
export const GRID_TILE_H = 118;
export const GRID_GAP = 4;
export const GRID_MIN_W = 104;
export const GRID_PAD_X = 12;
export const GRID_PAD_TOP = 8;
export const GRID_PAD_BOTTOM = 16;

const OVERSCAN_ROWS = 6;
/* The rendered window is kept while the view stays this many rows inside
   it, so scrolling re-renders every few rows rather than at every row. */
const SLACK_ROWS = 3;

export interface VirtualWindow {
  /** Entry range [first, last) covered by the rendered rows. */
  first: number;
  last: number;
  /** Layout row range [firstRow, lastRow) to render. */
  firstRow: number;
  lastRow: number;
  cols: number;
  layout: Layout;
}

const DETAILS_GEOM: Geometry = { rowH: DETAILS_ROW, headerH: DETAILS_GROUP_H, gap: 0 };
const GRID_GEOM: Geometry = { rowH: GRID_TILE_H, headerH: GRID_GROUP_H, gap: GRID_GAP };

const layouts = new WeakMap<HTMLElement, Layout>();

/** The layout the list element currently renders, if it has mounted. */
export const layoutOf = (list: HTMLElement | null): Layout | undefined =>
  list ? layouts.get(list) : undefined;

const scroller = (list: HTMLElement | null) =>
  list?.closest<HTMLElement>(".content") ?? null;

export function gridColumns(list: HTMLElement | null): number {
  const el = scroller(list);
  if (!el) return 1;
  // Prefer the browser's own track list: the CSS uses rounded rem values,
  // so the arithmetic below can disagree with it by one column at exact
  // widths or non-default text sizes.
  if (list) {
    const tracks = getComputedStyle(list).gridTemplateColumns;
    if (tracks && tracks !== "none") {
      const n = tracks.split(" ").filter((t) => t.endsWith("px")).length;
      if (n > 0) return n;
    }
  }
  const k = textScale();
  return Math.max(
    1,
    Math.floor(
      (el.clientWidth - GRID_PAD_X * 2 * k + GRID_GAP * k) /
        ((GRID_MIN_W + GRID_GAP) * k)
    )
  );
}

export function useVirtualWindow(
  listRef: RefObject<HTMLElement | null>,
  count: number,
  grid: boolean,
  groups: Group[] | null
): VirtualWindow {
  const scaleSetting = useSettings((s) => s.textScale);
  const [cols, setCols] = useState(1);
  const layout = useMemo(
    () => buildLayout(count, groups, cols, grid ? GRID_GEOM : DETAILS_GEOM),
    [count, groups, cols, grid]
  );
  const [win, setWin] = useState<VirtualWindow>(() => {
    const lastRow = Math.min(layout.rows.length, 80);
    return {
      first: 0,
      last: lastRow >= layout.rows.length ? count : layout.rows[lastRow].start,
      firstRow: 0,
      lastRow,
      cols,
      layout,
    };
  });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list) layouts.set(list, layout);
  }, [layout, listRef]);

  const measure = useCallback(() => {
    const el = scroller(listRef.current);
    if (!el) return;
    const c = grid ? gridColumns(listRef.current) : 1;
    if (c !== cols) {
      setCols(c);
      return;
    }
    const k = textScale();
    const { rows } = layout;
    if (rows.length === 0) return;
    const base = (grid ? GRID_PAD_TOP : DETAILS_HEADER) * k;
    const y0 = (el.scrollTop - base) / k;
    const y1 = (el.scrollTop + el.clientHeight - base) / k;
    const seenFirst = rowAtY(layout, y0);
    const seenLast = rowAtY(layout, y1) + 1;
    const firstRow = Math.max(0, seenFirst - OVERSCAN_ROWS);
    const lastRow = Math.min(rows.length, seenLast + OVERSCAN_ROWS);
    const first = rows[firstRow].start;
    const last = lastRow >= rows.length ? count : rows[lastRow].start;
    setWin((w) => {
      if (w.cols !== c || w.layout !== layout) {
        return { first, last, firstRow, lastRow, cols: c, layout };
      }
      if (w.firstRow === firstRow && w.lastRow === lastRow) return w;
      const topOk = w.firstRow === 0 || seenFirst >= w.firstRow + SLACK_ROWS;
      const bottomOk = w.lastRow >= rows.length || seenLast <= w.lastRow - SLACK_ROWS;
      return topOk && bottomOk ? w : { first, last, firstRow, lastRow, cols: c, layout };
    });
  }, [listRef, layout, cols, count, grid, scaleSetting]);

  useLayoutEffect(() => {
    measure();
    const el = scroller(listRef.current);
    if (!el) return;
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [measure, listRef]);

  // `win` lags one render behind a layout change; never hand out a stale layout.
  return useMemo(() => (win.layout === layout ? win : { ...win, layout }), [win, layout]);
}

export function scrollToIndex(list: HTMLElement | null, index: number, grid: boolean) {
  const el = scroller(list);
  const layout = layoutOf(list);
  if (!el || !layout) return;
  const k = textScale();
  const ri = layout.rowOf[index];
  const row = layout.rows[ri];
  if (!row) return;
  // Reveal a group's header along with its first row.
  const head = layout.rows[ri - 1]?.group ? layout.rows[ri - 1] : row;
  const base = (grid ? GRID_PAD_TOP : DETAILS_HEADER) * k;
  const sticky = grid ? 0 : DETAILS_HEADER * k;
  const rowTop = base + head.top * k;
  const rowBottom = base + (row.top + row.height) * k;
  const pad = grid ? GRID_PAD_TOP * k : 0;
  if (rowTop < el.scrollTop + sticky) {
    el.scrollTop = Math.max(0, rowTop - sticky - pad);
  } else if (rowBottom > el.scrollTop + el.clientHeight) {
    el.scrollTop = rowBottom - el.clientHeight + pad;
  }
}

export function useRevealRenaming(
  listRef: RefObject<HTMLElement | null>,
  entries: FileEntry[],
  renaming: string | null,
  grid: boolean
) {
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!renaming) {
      revealed.current = null;
      return;
    }
    if (revealed.current === renaming) return;
    const i = entries.findIndex((e) => e.path === renaming);
    if (i < 0) return;
    revealed.current = renaming;
    scrollToIndex(listRef.current, i, grid);
  }, [renaming, entries, listRef, grid]);
}
