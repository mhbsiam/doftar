import { describe, expect, it, vi } from "vitest";
import { copiedAgo, entryLabel, useClipboard, withEntry, type ClipEntry } from "./clipboard";

const board = vi.hoisted(() => ({ changeCount: 5, cleared: 0, written: [] as string[][] }));
vi.mock("../ipc", () => ({
  api: {
    clipboardChangeCount: async () => board.changeCount,
    clipboardClear: async () => void board.cleared++,
    clipboardWriteFiles: async (paths: string[]) => (board.written.push(paths), ++board.changeCount),
  },
}));

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

describe("forget", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const start = (paths: string[], changeCount: number) => {
    Object.assign(board, { changeCount, cleared: 0, written: [] });
    useClipboard.setState({ op: "copy", paths, changeCount: 5, cutAt: null, history: [entry(paths), entry(["/c"])] });
  };

  it("leaves the system clipboard alone when it held none of the paths", async () => {
    start(["/a"], 5);
    useClipboard.getState().forget(["/z"]);
    await settle();
    expect(board).toMatchObject({ cleared: 0, written: [] });
    expect(useClipboard.getState().paths).toEqual(["/a"]);
  });

  it("puts back the rest, or clears it when nothing is left", async () => {
    start(["/a", "/b"], 5);
    useClipboard.getState().forget(["/a"]);
    await settle();
    expect(board.written).toEqual([["/b"]]);
    expect(useClipboard.getState().history.map((e) => e.paths)).toEqual([["/b"], ["/c"]]);
    start(["/a"], 5);
    useClipboard.getState().forget(["/a"]);
    await settle();
    expect(board.cleared).toBe(1);
  });

  it("keeps what another app copied since", async () => {
    start(["/a"], 9);
    useClipboard.getState().forget(["/a"]);
    await settle();
    expect(board).toMatchObject({ cleared: 0, written: [] });
    expect(useClipboard.getState().op).toBe(null);
  });
});
