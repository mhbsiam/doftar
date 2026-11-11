import type { AnnData, AnnSection, DataTable } from "../types";
import { cellKey } from "./dataTable";

type Row = (string | null)[];

/** A row only one file has, or a row both have whose shared cells differ. */
export type RowDiff =
  | { kind: "add" | "del"; row: Row }
  | { kind: "change"; left: Row; right: Row; cells: number[] };

export interface TableDiff {
  /** Columns only the right file has, only the left file has, and both have, by name. */
  added: string[];
  removed: string[];
  shared: string[];
  /** Shared columns with a different stored type. */
  retyped: { name: string; from: string; to: string }[];
  /** Shared columns with a distinct value in every row of both files. Rows can match by them. */
  keys: string[];
  /** The column used to match rows. Null if rows match by whole content. */
  key: string | null;
  /** Rows that differ over the shared columns: removed and changed rows in left file order, then added rows. */
  rows: RowDiff[];
  same: number;
}

/** Each column's first index by name. A repeated name keeps its first column. */
function indexOf(t: DataTable): Map<string, number> {
  const m = new Map<string, number>();
  t.columns.forEach((c, i) => m.has(c.name) || m.set(c.name, i));
  return m;
}

function unique(rows: Row[], c: number): boolean {
  const seen = new Set<string>();
  for (const r of rows) {
    const k = cellKey(r[c]);
    if (k === "" || seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

/**
 * `b` against `a` over the loaded rows of each. Rows match by `key`. The default is the first column that can be one.
 * A changed row then shows which cells changed. If rows match by whole content, rows can only be added or removed.
 */
export function diffTables(a: DataTable, b: DataTable, key?: string | null): TableDiff {
  const ia = indexOf(a);
  const ib = indexOf(b);
  const shared = [...ia.keys()].filter((n) => ib.has(n));
  const ca = shared.map((n) => ia.get(n)!);
  const cb = shared.map((n) => ib.get(n)!);
  const retyped = shared.flatMap((name, i) => {
    const from = a.columns[ca[i]].ty;
    const to = b.columns[cb[i]].ty;
    return from && to && from !== to ? [{ name, from, to }] : [];
  });
  const keys = shared.filter((_, i) => unique(a.rows, ca[i]) && unique(b.rows, cb[i]));
  const k = key === undefined ? (keys[0] ?? null) : key !== null && keys.includes(key) ? key : null;
  const pick = (r: Row, cols: number[]) => cols.map((c) => r[c] ?? null);
  const rows: RowDiff[] = [];
  let same = 0;

  if (k !== null) {
    const ka = ca[shared.indexOf(k)];
    const kb = cb[shared.indexOf(k)];
    const right = new Map(b.rows.map((r) => [cellKey(r[kb]), r]));
    for (const r of a.rows) {
      const id = cellKey(r[ka]);
      const other = right.get(id);
      if (!other) {
        rows.push({ kind: "del", row: pick(r, ca) });
        continue;
      }
      right.delete(id);
      const left = pick(r, ca);
      const now = pick(other, cb);
      const cells = left.flatMap((v, i) => (cellKey(v) === cellKey(now[i]) ? [] : [i]));
      if (cells.length) rows.push({ kind: "change", left, right: now, cells });
      else same += 1;
    }
    for (const r of right.values()) rows.push({ kind: "add", row: pick(r, cb) });
  } else {
    // A multiset of the rows of the right file, so repeated rows are counted, not merged.
    const text = (r: Row) => JSON.stringify(r.map(cellKey));
    const right = new Map<string, Row[]>();
    for (const r of b.rows) {
      const row = pick(r, cb);
      const t = text(row);
      (right.get(t) ?? right.set(t, []).get(t)!).push(row);
    }
    for (const r of a.rows) {
      const row = pick(r, ca);
      const left = right.get(text(row));
      if (left?.length) {
        left.pop();
        same += 1;
      } else rows.push({ kind: "del", row });
    }
    for (const left of right.values()) for (const row of left) rows.push({ kind: "add", row });
  }

  return {
    added: [...ib.keys()].filter((n) => !ia.has(n)),
    removed: [...ia.keys()].filter((n) => !ib.has(n)),
    shared,
    retyped,
    keys,
    key: k,
    rows,
    same,
  };
}

/** One key of an AnnData section in either file, and its value in each. */
export interface KeyDiff {
  section: string;
  name: string;
  left: string | null;
  right: string | null;
}

export function annSections(a: AnnData): AnnSection[] {
  return a.raw ? [...a.sections, ...a.raw[2].map((s) => ({ ...s, name: `raw.${s.name}` }))] : a.sections;
}

/** Every section's keys in both files, in the order of the left file. */
export function diffAnnData(a: AnnData, b: AnnData): KeyDiff[] {
  const bySection = (x: AnnData) => new Map(annSections(x).map((s) => [s.name, new Map(s.keys.map((k) => [k.name, k.detail]))]));
  const left = bySection(a);
  const right = bySection(b);
  return [...new Set([...left.keys(), ...right.keys()])].flatMap((section) => {
    const l = left.get(section) ?? new Map<string, string>();
    const r = right.get(section) ?? new Map<string, string>();
    return [...new Set([...l.keys(), ...r.keys()])].map((name) => ({
      section,
      name,
      left: l.get(name) ?? null,
      right: r.get(name) ?? null,
    }));
  });
}
