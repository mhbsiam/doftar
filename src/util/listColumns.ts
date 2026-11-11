import type { SortKey } from "../types";

/** Columns of the list view, in display order. Name is always shown. */
export type ColumnKey = "name" | "modified" | "created" | "type" | "size" | "tags";
export type ColumnWidths = Partial<Record<ColumnKey, number>>;

export const COLUMNS: { key: ColumnKey; label: string; width: number; sort?: SortKey }[] = [
  { key: "name", label: "Name", width: 17.143, sort: "name" },
  { key: "modified", label: "Date modified", width: 13.571, sort: "modified" },
  { key: "created", label: "Date created", width: 13.571, sort: "created" },
  { key: "type", label: "Type", width: 12.143, sort: "type" },
  { key: "size", label: "Size", width: 7.857, sort: "size" },
  { key: "tags", label: "Tags", width: 10 },
];

export const DEFAULT_LIST_COLUMNS: ColumnKey[] = ["modified", "type", "size"];
/** Narrowest a dragged column can get, in rem. */
export const MIN_WIDTH = 4;

export function shownColumns(optional: readonly string[]): ColumnKey[] {
  return COLUMNS.filter((c) => c.key === "name" || optional.includes(c.key)).map((c) => c.key);
}

const widthOf = (key: ColumnKey, widths: ColumnWidths) =>
  Math.max(MIN_WIDTH, widths[key] ?? COLUMNS.find((c) => c.key === key)!.width);

/**
 * Name fills the row until it is sized by hand. Then the last column takes the slack, as in Finder.
 */
export function gridTemplate(cols: ColumnKey[], widths: ColumnWidths): string {
  const fixedName = widths.name !== undefined;
  return cols
    .map((key, i) => {
      const w = `${widthOf(key, widths)}rem`;
      if (key === "name" && !fixedName) return `minmax(${w}, 1fr)`;
      if (fixedName && i === cols.length - 1 && cols.length > 1) return `minmax(${w}, 1fr)`;
      return w;
    })
    .join(" ");
}

/** A narrow pane keeps Name, Date modified and Size. */
export const NARROW_KEEP: ColumnKey[] = ["name", "modified", "size"];

export function narrowTemplate(cols: ColumnKey[]): string {
  const widths: Record<string, string> = { name: "minmax(10rem, 1fr)", modified: "11.429rem", size: "6.429rem" };
  return cols.filter((c) => NARROW_KEEP.includes(c)).map((c) => widths[c]).join(" ");
}
