import { describe, expect, it } from "vitest";
import { diffAnnData, diffTables } from "./diffTable";
import type { AnnData, DataTable } from "../types";

const table = (names: string[], rows: (string | null)[][], tys?: string[]): DataTable => ({
  columns: names.map((name, i) => ({ name, ty: tys?.[i] })),
  rows,
  totalRows: rows.length,
  more: false,
  facts: [],
});

describe("diffTables", () => {
  it("matches rows by the first unique column and marks the cells that changed", () => {
    const a = table(["id", "x", "gone"], [["1", "a", "q"], ["2", "b", "q"], ["3", "c", "q"]], ["int64", "utf8", "utf8"]);
    const b = table(["id", "x", "new"], [["3", "c", "z"], ["1", "A", "z"], ["4", "d", "z"]], ["float64", "utf8", "utf8"]);
    const d = diffTables(a, b);
    expect(d.added).toEqual(["new"]);
    expect(d.removed).toEqual(["gone"]);
    expect(d.retyped).toEqual([{ name: "id", from: "int64", to: "float64" }]);
    expect(d.key).toBe("id");
    expect(d.same).toBe(1);
    expect(d.rows).toEqual([
      { kind: "change", left: ["1", "a"], right: ["1", "A"], cells: [1] },
      { kind: "del", row: ["2", "b"] },
      { kind: "add", row: ["4", "d"] },
    ]);
  });

  it("reads numbers by value and empty as missing, so a CSV matches its Parquet", () => {
    const a = table(["id", "v"], [["1", "1.0"], ["2", ""]]);
    const b = table(["id", "v"], [["1.0", "1"], ["2", null]]);
    expect(diffTables(a, b).rows).toEqual([]);
  });

  it("keeps integers too big for a float exact, so int64 IDs one apart differ", () => {
    const a = table(["id", "v"], [["9007199254740993", "x"], ["9007199254740992", "y"]]);
    const b = table(["id", "v"], [["9007199254740993", "z"], ["9007199254740992", "y"]]);
    const d = diffTables(a, b);
    expect(d.key).toBe("id");
    expect(d.rows).toEqual([{ kind: "change", left: ["9007199254740993", "x"], right: ["9007199254740993", "z"], cells: [1] }]);
  });

  it("matched by whole row, counts repeated rows instead of merging them", () => {
    const a = table(["x"], [["a"], ["a"], ["b"]]);
    const b = table(["x"], [["a"], ["c"]]);
    const d = diffTables(a, b);
    expect(d.keys).toEqual([]);
    expect(d.key).toBeNull();
    expect(d.same).toBe(1);
    expect(d.rows).toEqual([
      { kind: "del", row: ["a"] },
      { kind: "del", row: ["b"] },
      { kind: "add", row: ["c"] },
    ]);
  });

  it("matches by whole row when asked, even with a key available", () => {
    const a = table(["id", "x"], [["1", "a"]]);
    const b = table(["id", "x"], [["1", "b"]]);
    expect(diffTables(a, b, null).rows.map((r) => r.kind)).toEqual(["del", "add"]);
  });
});

describe("diffAnnData", () => {
  const ann = (sections: AnnData["sections"]): AnnData => ({
    nObs: 1,
    nVars: 1,
    x: null,
    sections,
    raw: null,
    obs: null,
    var: null,
  });

  it("lists every key of each section once, with what each file holds", () => {
    const a = ann([{ name: "obs", keys: [{ name: "a", detail: "int" }, { name: "b", detail: "str" }] }]);
    const b = ann([
      { name: "obs", keys: [{ name: "b", detail: "category" }, { name: "c", detail: "int" }] },
      { name: "layers", keys: [{ name: "counts", detail: "3 × 3" }] },
    ]);
    expect(diffAnnData(a, b)).toEqual([
      { section: "obs", name: "a", left: "int", right: null },
      { section: "obs", name: "b", left: "str", right: "category" },
      { section: "obs", name: "c", left: null, right: "int" },
      { section: "layers", name: "counts", left: null, right: "3 × 3" },
    ]);
  });
});
