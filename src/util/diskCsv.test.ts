import { describe, expect, it } from "vitest";
import { diskCsv } from "./diskCsv";

describe("diskCsv", () => {
  it("lists files then developer folders, quoting awkward fields", () => {
    const csv = diskCsv({
      root: "/u",
      totalBytes: 0,
      totalFiles: 0,
      folders: [],
      categories: [],
      topFiles: [{ path: "/u/a, b.mov", name: "a, b.mov", size: 2048, modifiedMs: 0, category: "video" }],
      scannedMs: 0,
      cancelled: false,
      devFolders: [{ path: "/u/x/node_modules", label: "node_modules", bytes: 10, safe: true, note: 'say "npm i"' }],
    }).split("\n");
    expect(csv[0]).toBe("kind,path,name,size_bytes,size,category,modified,safe_to_trash,note");
    expect(csv[1]).toMatch(/^file,"\/u\/a, b\.mov","a, b\.mov",2048,/);
    expect(csv[2]).toMatch(/^developer,\/u\/x\/node_modules,node_modules,10,.*,true,"say ""npm i"""$/);
  });
});
