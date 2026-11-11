import { describe, expect, it } from "vitest";
import { columnStats, isNumeric, sortOrder } from "./dataTable";
import type { DataTable } from "../types";

const rows = (vals: (string | null)[]) => vals.map((v) => [v]);
const table = (vals: (string | null)[], ty?: string): DataTable => ({
  columns: [{ name: "x", ty }],
  rows: rows(vals),
  totalRows: vals.length,
  more: false,
  facts: [],
});

describe("sortOrder", () => {
  it("sorts numbers as numbers, missing values last either way", () => {
    const r = rows(["10", "", "2", null, "-1"]);
    expect(sortOrder(r, 0, false, true)).toEqual([4, 2, 0, 1, 3]);
    expect(sortOrder(r, 0, true, true)).toEqual([0, 2, 4, 1, 3]);
  });

  it("sorts inf as a number", () => {
    expect(sortOrder(rows(["inf", "1", "-inf", "inf"]), 0, false, true)).toEqual([2, 1, 0, 3]);
  });

  it("sorts text naturally and keeps ties in file order", () => {
    const r = rows(["item 10", "Item 2", "item 2", "apple"]);
    expect(sortOrder(r, 0, false, false)).toEqual([3, 1, 2, 0]);
  });
});

describe("columnStats", () => {
  it("finds min and max of numbers and counts missing ones", () => {
    expect(columnStats(rows(["3", "", "-2.5", "1e3", null]), 0, true)).toEqual({
      min: "-2.5",
      max: "1e3",
      missing: 2,
    });
  });

  it("takes inf as a number", () => {
    expect(columnStats(rows(["inf", "inf"]), 0, true)).toEqual({ min: "inf", max: "inf", missing: 0 });
    expect(columnStats(rows(["-inf", "2", "INF"]), 0, true)).toEqual({ min: "-inf", max: "INF", missing: 0 });
  });

  it("counts distinct text values", () => {
    expect(columnStats(rows(["a", "b", "a", ""]), 0, false)).toEqual({ missing: 1, distinct: 2, distinctMore: false });
  });
});

describe("isNumeric", () => {
  it("goes by the type when there is one, and by the values when not", () => {
    expect(isNumeric(table(["x"], "int64"), 0)).toBe(true);
    expect(isNumeric(table(["1"], "string"), 0)).toBe(false);
    expect(isNumeric(table(["1", "", "2.5"]), 0)).toBe(true);
    expect(isNumeric(table(["1", "two"]), 0)).toBe(false);
    // A spreadsheet column letter is not a type.
    expect(isNumeric(table(["4", "5"], "B"), 0)).toBe(true);
  });
});
