import type { Rect } from "../types";

/**
 * Lays `sizes` (largest first) out in `box` as a squarified treemap (Bruls,
 * Huizing and van Wijk): rows of blocks along the box's shorter side, each
 * row as long as keeps its blocks closest to square. Returns one rect per
 * size, in the same order; their areas are in proportion to the sizes and
 * together fill the box.
 */
export function squarify(sizes: number[], box: Rect): Rect[] {
  const out: Rect[] = sizes.map(() => ({ x: box.x, y: box.y, w: 0, h: 0 }));
  const total = sizes.reduce((n, s) => n + Math.max(0, s), 0);
  if (total <= 0 || box.w <= 0 || box.h <= 0) return out;
  const scale = (box.w * box.h) / total;
  const areas = sizes.map((s) => Math.max(0, s) * scale);

  let free = { ...box };
  let start = 0;
  while (start < areas.length) {
    const side = Math.min(free.w, free.h);
    // Grow the row while that makes its worst block no less square.
    let end = start + 1;
    let sum = areas[start];
    let worst = worstRatio(areas, start, end, sum, side);
    while (end < areas.length) {
      const next = worstRatio(areas, start, end + 1, sum + areas[end], side);
      if (next > worst) break;
      sum += areas[end];
      worst = next;
      end++;
    }
    // Lay the row along the shorter side, as thick as its area needs.
    const thick = side > 0 ? sum / side : 0;
    let along = 0;
    for (let i = start; i < end; i++) {
      const len = thick > 0 ? areas[i] / thick : 0;
      out[i] =
        free.w >= free.h
          ? { x: free.x, y: free.y + along, w: thick, h: len }
          : { x: free.x + along, y: free.y, w: len, h: thick };
      along += len;
    }
    free =
      free.w >= free.h
        ? { x: free.x + thick, y: free.y, w: Math.max(0, free.w - thick), h: free.h }
        : { x: free.x, y: free.y + thick, w: free.w, h: Math.max(0, free.h - thick) };
    start = end;
  }
  return out;
}

/** The most elongated block's aspect ratio for a row of `areas[start..end)` along `side`. */
function worstRatio(areas: number[], start: number, end: number, sum: number, side: number): number {
  if (sum <= 0 || side <= 0) return Infinity;
  let max = 0;
  let min = Infinity;
  for (let i = start; i < end; i++) {
    max = Math.max(max, areas[i]);
    min = Math.min(min, areas[i]);
  }
  if (min <= 0) return Infinity;
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}
