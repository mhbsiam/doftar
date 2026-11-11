import { describe, expect, it } from "vitest";
import { useDisk } from "./disk";
import type { DiskReport } from "../types";

const report = (): DiskReport => ({
  root: "/r",
  totalBytes: 1000,
  totalFiles: 10,
  folders: [
    { name: "a", path: "/r/a", bytes: 600, isDir: true },
    { name: "b", path: "/r/b", bytes: 300, isDir: true },
    { name: "Files in this folder", path: "/r", bytes: 100, isDir: false },
  ],
  categories: [{ key: "other", bytes: 1000, files: 10 }],
  topFiles: [{ path: "/r/b/big.bin", name: "big.bin", size: 200, modifiedMs: 0, category: "other" }],
  scannedMs: 1,
  cancelled: false,
  devFolders: [],
});

describe("removeFiles", () => {
  it("takes a trashed folder off the report by the size the map measured", () => {
    useDisk.setState({ report: report() });
    useDisk.getState().removeFiles(["/r/a"], [600]);
    const r = useDisk.getState().report!;
    expect(r.totalBytes).toBe(400);
    expect(r.folders.map((f) => [f.path, f.bytes])).toEqual([
      ["/r/b", 300],
      ["/r", 100],
    ]);
  });

  it("counts a top file inside a measured folder once", () => {
    useDisk.setState({ report: report() });
    useDisk.getState().removeFiles(["/r/b"], [300]);
    const r = useDisk.getState().report!;
    expect(r.totalBytes).toBe(700);
    expect(r.topFiles).toEqual([]);
  });

  it("still uses top-file sizes when the map doesn't know the item", () => {
    useDisk.setState({ report: report() });
    useDisk.getState().removeFiles(["/r/b/big.bin"]);
    const r = useDisk.getState().report!;
    expect(r.totalBytes).toBe(800);
    expect(r.folders.find((f) => f.path === "/r/b")!.bytes).toBe(100);
    expect(r.folders.find((f) => f.path === "/r")!.bytes).toBe(100);
  });
});
