import type { DataTable } from "../types";

const NUMERIC = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$|^-?(inf|nan)$/i;
const NUMERIC_TYPE = /^(u?int|float|double|decimal|Int64|integer|real|numeric)/i;
/** Count distinct values in a text column up to this limit. Then the count says "or more". */
const MAX_DISTINCT = 10_000;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const missing = (v: string | null | undefined) => v === null || v === undefined || v === "";
/** `v` as a number. Reads "inf" as Python and Rust print it. NaN if missing. */
const toNumber = (v: string | null | undefined) =>
  missing(v) ? NaN : /^-?inf$/i.test(v!) ? (v!.startsWith("-") ? -Infinity : Infinity) : Number(v);

/**
 * `v` as compared across files: missing is "", numbers compare by value, so CSV "1.0" matches Parquet 1.
 * An integer too big to hold exactly (an int64 ID) keeps its text, so IDs one apart still differ.
 */
export function cellKey(v: string | null | undefined): string {
  if (missing(v)) return "";
  if (!NUMERIC.test(v!)) return v!;
  const n = toNumber(v);
  return Number.isInteger(n) && !Number.isSafeInteger(n) ? v! : String(n);
}

export function isNumeric(table: DataTable, c: number): boolean {
  const ty = table.columns[c].ty;
  // A spreadsheet "type" is its column letter, which says nothing.
  if (ty !== undefined && !/^[A-Z]+$/.test(ty)) return NUMERIC_TYPE.test(ty);
  let seen = 0;
  for (const row of table.rows.slice(0, 50)) {
    const v = row[c];
    if (missing(v)) continue;
    if (!NUMERIC.test(v!)) return false;
    seen += 1;
  }
  return seen > 0;
}

/**
 * The order of `rows` sorted by column `c`: numbers as numbers, text in natural order ("item 2" before "item 10").
 * Missing values go last in both directions. Ties keep file order.
 */
export function sortOrder(rows: (string | null)[][], c: number, desc: boolean, numeric: boolean): number[] {
  const nums = numeric ? rows.map((r) => toNumber(r[c])) : null;
  const gone = (i: number) => (nums ? Number.isNaN(nums[i]) : missing(rows[i][c]));
  return rows
    .map((_, i) => i)
    .sort((a, b) => {
      const ga = gone(a);
      const gb = gone(b);
      if (ga || gb) return ga === gb ? a - b : ga ? 1 : -1;
      const d = nums ? (nums[a] < nums[b] ? -1 : nums[a] > nums[b] ? 1 : 0) : collator.compare(rows[a][c]!, rows[b][c]!);
      return (desc ? -d : d) || a - b;
    });
}

export interface ShownStats {
  min?: string;
  max?: string;
  missing: number;
  distinct?: number;
  distinctMore?: boolean;
}

/** Min and max for numbers. Distinct values for text. */
export function columnStats(rows: (string | null)[][], c: number, numeric: boolean): ShownStats {
  let gone = 0;
  if (numeric) {
    let lo = Infinity;
    let hi = -Infinity;
    let min: string | undefined;
    let max: string | undefined;
    for (const r of rows) {
      const v = r[c];
      const n = toNumber(v);
      if (Number.isNaN(n)) {
        gone += 1;
        continue;
      }
      if (min === undefined || n < lo) [lo, min] = [n, v!];
      if (max === undefined || n > hi) [hi, max] = [n, v!];
    }
    return { min, max, missing: gone };
  }
  const seen = new Set<string>();
  let more = false;
  for (const r of rows) {
    const v = r[c];
    if (missing(v)) gone += 1;
    else if (seen.size < MAX_DISTINCT) seen.add(v!);
    else if (!seen.has(v!)) more = true;
  }
  return { missing: gone, distinct: seen.size, distinctMore: more };
}
