import { describe, expect, it } from "vitest";
import { archiveTree, flattenTree, matchTree } from "./folderTree";
import type { FileEntry } from "../types";

const e = (path: string, isDir = false, size = 0, modifiedMs = 1) =>
  ({ name: path.split("/").pop(), path, isDir, isPackage: false, size, modifiedMs }) as FileEntry;
const names = (rows: ReturnType<typeof flattenTree>) =>
  rows.map((r) => (r.kind === "entry" ? `${r.depth}:${r.entry.name}` : `${r.depth}:${r.kind}`));

describe("flattenTree", () => {
  const children = {
    "/lab": [e("/lab/b.txt", false, 5), e("/lab/a", true), e("/lab/c", true)],
    "/lab/a": [e("/lab/a/x.csv", false, 1)],
  };

  it("lists folders first by name until every folder is sized, then biggest first", () => {
    const open = new Set(["/lab/a", "/lab/c"]);
    expect(names(flattenTree("/lab", { children, open, sizes: { "/lab/a": 1 } }))).toEqual([
      "0:a", "1:x.csv", "0:c", "1:loading", "0:b.txt",
    ]);
    expect(names(flattenTree("/lab", { children, open: new Set(), sizes: { "/lab/a": 1, "/lab/c": 9 } }))).toEqual([
      "0:c", "0:b.txt", "0:a",
    ]);
  });
});

describe("matchTree", () => {
  it("puts each match under the folders leading to it", () => {
    const folder = (p: string) => e(p, true, 0, 0);
    const rows = matchTree("/lab", [e("/lab/a/b/run.h5"), e("/lab/run.md"), e("/elsewhere/run")], folder, {});
    expect(names(rows)).toEqual(["0:a", "1:b", "2:run.h5", "0:run.md"]);
  });
});

describe("archiveTree", () => {
  it("adds the folders an archive does not list and sizes each by what it holds", () => {
    const t = archiveTree("/x/a.zip", [
      { path: "src/sub/b.txt", size: 3, isDir: false },
      { path: "src/a.txt", size: 5, isDir: false },
      { path: "empty", size: 0, isDir: true },
    ]);
    expect(t.children["/x/a.zip"].map((c) => c.name)).toEqual(["src", "empty"]);
    expect(t.children["/x/a.zip/src"].map((c) => [c.name, c.isDir])).toEqual([["sub", true], ["a.txt", false]]);
    expect(t.sizes).toMatchObject({ "/x/a.zip": 8, "/x/a.zip/src": 8, "/x/a.zip/src/sub": 3, "/x/a.zip/empty": 0 });
    expect(t.files.map((f) => f.ext)).toEqual(["txt", "txt"]);
  });
});
