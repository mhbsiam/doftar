import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { CompareView } from "./CompareView";
import { reply } from "../test/tauri";
import { mount, settle, WIDE } from "../test/mount";
import { useTabs } from "../stores/tabs";
import type { AnnData, DataTable } from "../types";

const table = (columns: [string, string][], rows: (string | null)[][]): DataTable => ({
  columns: columns.map(([name, ty]) => ({ name, ty })),
  rows,
  totalRows: rows.length,
  more: false,
  facts: [],
});

const before = table(
  [["sample", "utf8"], ["dose", "int64"], ["response", "double"], ["batch", "utf8"]],
  [["s1", "10", "0.41", "A"], ["s2", "20", "0.55", "A"], ["s3", "40", "0.71", "B"], ["s4", "80", "0.90", "B"]]
);
const after = table(
  [["sample", "utf8"], ["dose", "double"], ["response", "double"], ["site", "utf8"]],
  [["s1", "10.0", "0.41", "Oslo"], ["s3", "40", "0.74", "Oslo"], ["s4", "80", "0.90", "Pune"], ["s5", "160", "0.97", "Pune"]]
);

const ann = (nObs: number, obs: AnnData["sections"][number]["keys"], layers: string[]): AnnData => ({
  nObs,
  nVars: 2000,
  x: "float32 · sparse CSR",
  sections: [
    { name: "obs", keys: obs },
    { name: "layers", keys: layers.map((name) => ({ name, detail: `${nObs} × 2000 · float32` })) },
  ],
  raw: null,
  obs: table([["", "utf8"], ["cell_type", "category"]], [["AAAC", nObs === 2700 ? "B cell" : "NK cell"], ["AAAG", "T cell"]]),
  var: null,
});

reply("read_document", ({ path }: { path: string }) => {
  if (path.endsWith(".h5ad")) {
    const a = path.endsWith("raw.h5ad")
      ? ann(2700, [{ name: "n_genes", detail: "int64" }, { name: "batch", detail: "category" }], ["counts"])
      : ann(2638, [{ name: "n_genes", detail: "int32" }, { name: "leiden", detail: "category" }], ["counts", "log1p"]);
    return { kind: "hdf5", root: { name: "/", kind: "group" }, anndata: a };
  }
  return { kind: "table", ...(path.endsWith("before.csv") ? before : after) };
});

let unmount = () => {};
afterEach(() => unmount());

test("compare page shows the columns and rows two tables differ in", async () => {
  useTabs.getState().navigate({ kind: "compare", a: "/Users/me/before.csv", b: "/Users/me/after.parquet" });
  ({ unmount } = await mount(<CompareView />, WIDE));
  await settle();
  expect(document.querySelector(".dcmp-schema")!.textContent).toContain("dose: int64 → double");
  // s1: dose 10 and 10.0 are the same number. s3: response changed. s2 removed. s5 added.
  expect(document.querySelectorAll("tr.dcmp-change").length).toBe(1);
  expect(document.querySelectorAll("tr.dcmp-del").length).toBe(1);
  expect(document.querySelectorAll("tr.dcmp-add").length).toBe(1);
  await expect.element(page.elementLocator(document.querySelector(".cmp-page")!)).toMatchScreenshot("compare-tables");
});

test("compare page shows every key two AnnData files differ in", async () => {
  useTabs.getState().navigate({ kind: "compare", a: "/Users/me/raw.h5ad", b: "/Users/me/processed.h5ad" });
  ({ unmount } = await mount(<CompareView />, WIDE));
  await settle();
  expect(document.querySelectorAll(".dcmp-keys tr.dcmp-add").length).toBe(2);
  expect(document.querySelectorAll(".dcmp-keys tr.dcmp-del").length).toBe(1);
  await expect.element(page.elementLocator(document.querySelector(".cmp-page")!)).toMatchScreenshot("compare-anndata");
});

test("obs rows match by the unnamed index, and go back to it after whole row", async () => {
  useTabs.getState().navigate({ kind: "compare", a: "/Users/me/raw.h5ad", b: "/Users/me/processed.h5ad" });
  ({ unmount } = await mount(<CompareView />, WIDE));
  await settle();
  await userEvent.click(page.getByRole("tab", { name: "obs" }));
  const select = () => document.querySelector<HTMLSelectElement>(".dcmp-bar select")!;
  const shown = () => select().selectedOptions[0].textContent;
  expect(shown()).toBe("index");
  expect(document.querySelectorAll("tr.dcmp-change").length).toBe(1);
  await userEvent.selectOptions(select(), "Whole row");
  expect(shown()).toBe("Whole row");
  expect(document.querySelectorAll("tr.dcmp-change").length).toBe(0);
  await userEvent.selectOptions(select(), "index");
  expect(shown()).toBe("index");
  expect(document.querySelectorAll("tr.dcmp-change").length).toBe(1);
});

test("files with no columns in common say so instead of counting rows the same", async () => {
  reply("read_document", ({ path }: { path: string }) =>
    path.endsWith("a.csv") ? { kind: "table", ...table([["x", "utf8"]], [["1"]]) } : { kind: "table", ...table([["y", "utf8"]], [["1"], ["2"]]) }
  );
  useTabs.getState().navigate({ kind: "compare", a: "/Users/me/a.csv", b: "/Users/me/b.csv" });
  ({ unmount } = await mount(<CompareView />, WIDE));
  await settle();
  expect(document.querySelector(".dcmp-bar")).toBeNull();
  expect(document.querySelector(".dcmp .tags-note")!.textContent).toContain("share no columns");
});
