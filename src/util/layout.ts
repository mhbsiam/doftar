export interface Group {
  key: string;
  label: string;
  start: number;
  count: number;
}

export interface LayoutRow {
  /** Offset from the first row, in design px (not text-scaled). */
  top: number;
  height: number;
  /** Set on group header rows; they hold no entries. */
  group?: Group;
  /** Entry range [start, end) shown on this row. Empty on header rows. */
  start: number;
  end: number;
}

export interface Layout {
  rows: LayoutRow[];
  /** Row index of each entry. */
  rowOf: Int32Array;
  /** Height of all rows, in design px. */
  total: number;
}

export interface Geometry {
  rowH: number;
  headerH: number;
  gap: number;
}

export function buildLayout(
  count: number,
  groups: Group[] | null,
  cols: number,
  g: Geometry
): Layout {
  const rows: LayoutRow[] = [];
  const rowOf = new Int32Array(count);
  let top = 0;
  const push = (height: number, start: number, end: number, group?: Group) => {
    const r = rows.length;
    for (let i = start; i < end; i++) rowOf[i] = r;
    rows.push({ top, height, group, start, end });
    top += height + g.gap;
  };
  const items = (from: number, to: number) => {
    for (let i = from; i < to; i += cols) push(g.rowH, i, Math.min(to, i + cols));
  };
  if (groups) {
    for (const grp of groups) {
      push(g.headerH, grp.start, grp.start, grp);
      items(grp.start, grp.start + grp.count);
    }
  } else {
    items(0, count);
  }
  const last = rows[rows.length - 1];
  return { rows, rowOf, total: last ? last.top + last.height : 0 };
}

/** Index of the row containing y, clamped to the first and last rows. */
export function rowAtY(layout: Layout, y: number): number {
  const { rows } = layout;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid].top <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Entry index `delta` item rows above or below `idx`, keeping the column.
 * Header rows are skipped; the result is clamped to the first and last entry.
 */
export function moveByRows(layout: Layout, idx: number, delta: number): number {
  const { rows, rowOf } = layout;
  const row = rows[rowOf[idx]];
  if (!row) return idx;
  const col = idx - row.start;
  const dir = delta < 0 ? -1 : 1;
  let r = rowOf[idx];
  let left = Math.abs(delta);
  while (left > 0) {
    let n = r + dir;
    while (n >= 0 && n < rows.length && rows[n].group) n += dir;
    if (n < 0) return 0;
    if (n >= rows.length) return rowOf.length - 1;
    r = n;
    left--;
  }
  const target = rows[r];
  return Math.min(target.end - 1, target.start + col);
}
