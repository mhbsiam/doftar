import { afterEach, expect, test } from "vitest";
import { DataGrid } from "./DataView";
import { mount, settle, WIDE } from "../test/mount";

let unmount = () => {};
afterEach(() => unmount());

test("column headers line up with the cells below them", async () => {
  const names = ["cell_type", "n_genes_by_counts", "total_counts", "pct_counts_mt", "batch", "leiden"];
  const table = {
    columns: names.map((name) => ({ name, ty: "str" })),
    rows: [names.map((n) => `${n}-value`)],
    totalRows: 1,
    more: false,
    facts: [],
  };
  ({ unmount } = await mount(<DataGrid table={table} scale={1} />, WIDE));
  await settle();
  const lefts = (sel: string) => [...document.querySelectorAll(sel)].map((e) => Math.round(e.getBoundingClientRect().left));
  expect(lefts(".dv-head .dv-td")).toEqual(lefts(".dv-rows .dv-td"));
});
