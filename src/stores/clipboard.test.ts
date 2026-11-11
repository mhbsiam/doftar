import { describe, expect, it } from "vitest";
import { copiedAgo, entryLabel, withEntry, type ClipEntry } from "./clipboard";

const entry = (paths: string[], at = 0): ClipEntry => ({ op: "copy", paths, at });

describe("withEntry", () => {
  it("moves the same files back to the top rather than repeating them", () => {
    const h = withEntry(withEntry([], entry(["/a"])), entry(["/b"]));
    expect(withEntry(h, entry(["/a"], 9)).map((e) => e.paths[0])).toEqual(["/a", "/b"]);
  });

  it("keeps the newest 20", () => {
    let h: ClipEntry[] = [];
    for (let i = 0; i < 25; i++) h = withEntry(h, entry([`/f${i}`]));
    expect(h).toHaveLength(20);
    expect(h[0].paths[0]).toBe("/f24");
  });
});

describe("labels", () => {
  it("names the first file and counts the rest", () => {
    expect(entryLabel(entry(["/x/report.pdf"]))).toBe("report.pdf");
    expect(entryLabel(entry(["/x/report.pdf", "/x/a", "/x/b"]))).toBe("report.pdf and 2 more");
  });

  it("says how long ago", () => {
    expect(copiedAgo(0, 30_000)).toBe("just now");
    expect(copiedAgo(0, 5 * 60_000)).toBe("5 min ago");
    expect(copiedAgo(0, 125 * 60_000)).toBe("2 h ago");
    expect(copiedAgo(0, 7 * 24 * 60 * 60_000)).toBe("7 d ago");
  });
});
