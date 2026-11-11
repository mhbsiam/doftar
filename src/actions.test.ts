import { beforeEach, describe, expect, it, vi } from "vitest";

// actions.ts pulls in modules that read browser globals on import.
vi.hoisted(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.CSS = { supports: () => false, escape: (s: string) => s };
  g.window = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    addEventListener: () => {},
  };
  g.document = {
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: { style: { setProperty: () => {} }, classList: { toggle: () => {} }, dataset: {} },
  };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("./ipc", () => ({
  api: {
    renameTaken: vi.fn(() => Promise.resolve(false)),
    renamePath: vi.fn(() => Promise.resolve({ kind: "move", from: "/d/a.txt", to: "/d/b.txt" })),
    createDir: vi.fn(() => Promise.resolve({ kind: "trash", path: "/d/New folder" })),
    movePaths: vi.fn(),
    statEntries: vi.fn(() => Promise.resolve([])),
    takeOpened: vi.fn(),
    isFolder: vi.fn((path: string) => Promise.resolve(!path.includes("."))),
  },
}));

import { activateEntry, commitRename, newFolderWithSelection, openHanded, setViewEntries, togglePreview } from "./actions";
import { topOf, useHistory } from "./stores/history";
import { api } from "./ipc";
import { closeSplit, hasClosedTab, openSplit, paneStore, usePanes } from "./stores/tabs";
import { snapshotSession } from "./session";
import type { FileEntry } from "./types";

const FROM = "/d/a.txt";
const renamingIn = (pane: number) => {
  const s = paneStore(pane).getState();
  return s.tabs.find((t) => t.id === s.activeId)?.renaming ?? null;
};

describe("the preview in split view", () => {
  const file = { name: "a.txt", path: FROM, isDir: false, modifiedMs: 1, size: 1 } as FileEntry;
  const left = () => paneStore(0).getState();
  const right = () => paneStore(1).getState();

  beforeEach(() => {
    usePanes.setState({ split: false, focused: 0 });
    for (const p of [left(), right()]) {
      p.setPreviewOpen(false);
      p.setPreview(null);
    }
  });

  const split = async () => {
    openSplit();
    await vi.waitFor(() => expect(usePanes.getState().split).toBe(true));
    // openSplit stays busy until its promise chain ends.
    await new Promise((r) => setTimeout(r));
  };

  it("saves a session in split view as one pane, right tabs after left, the left open tab open", async () => {
    await split();
    const ids = [...left().tabs, ...right().tabs].map((t) => t.id);
    const saved = snapshotSession();
    expect(saved.panes).toHaveLength(1);
    expect(saved.panes[0]).toHaveLength(ids.length);
    expect(saved.active[0]).toBe(ids.indexOf(left().activeId));
    closeSplit();
  });

  it("moves an open preview to the right half, and back when split view closes", async () => {
    togglePreview();
    activateEntry(file);
    await split();
    expect(right().previewOpen).toBe(true);
    expect(right().preview?.path).toBe(FROM);
    expect(left().previewOpen).toBe(false);

    closeSplit();
    expect(usePanes.getState().split).toBe(false);
    expect(left().previewOpen).toBe(true);
    expect(left().preview?.path).toBe(FROM);
  });

  it("opens and fills the one preview from the left half", async () => {
    await split();
    usePanes.setState({ focused: 0 });
    togglePreview();
    activateEntry(file);
    expect(right().previewOpen).toBe(true);
    expect(right().preview?.path).toBe(FROM);
    expect(left().previewOpen).toBe(false);
    closeSplit();
  });

  it("shows the right navigation pane when its toggle is used under the preview", async () => {
    await split();
    togglePreview();
    right().toggleNavPane();
    expect(right().previewOpen).toBe(false);
    expect(right().navPaneHidden).toBe(false);

    // Without a preview, the toggle hides the pane as usual.
    right().toggleNavPane();
    expect(right().navPaneHidden).toBe(true);
    right().toggleNavPane();

    // The preview only takes the right navigation pane away, so the left toggle leaves it open.
    togglePreview();
    left().toggleNavPane();
    expect(left().navPaneHidden).toBe(true);
    expect(right().previewOpen).toBe(true);
    left().toggleNavPane();
    closeSplit();
  });

  it("keeps the last tab of a half, unremembered, while split view is still opening", async () => {
    await split();
    closeSplit();
    openSplit();
    // Halfway through the opening wave: the halves are showing, but still moving.
    usePanes.setState({ split: true });
    // An untouched Home tab is never remembered, so give this one a folder.
    paneStore(1).setState({ tabs: right().tabs.map((t) => ({ ...t, location: { kind: "path", path: "/d" } })) });
    const id = right().tabs[0].id;
    right().closeTab(id);
    expect(right().tabs.map((t) => t.id)).toEqual([id]);
    expect(hasClosedTab()).toBe(false);
    await new Promise((r) => setTimeout(r));
    closeSplit();
  });

  it("updates the preview when the left half's folder shows the file changed", async () => {
    await split();
    usePanes.setState({ focused: 0 });
    togglePreview();
    activateEntry(file);
    paneStore(0).setState({ tabs: left().tabs.map((t) => ({ ...t, location: { kind: "path", path: "/d" } })) });
    setViewEntries(0, [{ ...file, size: 2 }], true);
    expect(right().preview?.size).toBe(2);
    closeSplit();
  });
});

describe("commitRename in split view", () => {
  beforeEach(() => {
    vi.mocked(api.renamePath).mockClear();
    usePanes.setState({ split: true, focused: 0 });
    paneStore(0).getState().setRenaming(null);
    paneStore(1).getState().setRenaming(null);
  });

  it("commits and closes the box in its own pane after focus moved to the other pane", async () => {
    paneStore(0).getState().setRenaming(FROM);
    // A click on the other pane moves focus before the box's blur fires.
    usePanes.setState({ focused: 1 });
    await commitRename(0, FROM, "b.txt");
    expect(api.renamePath).toHaveBeenCalledWith(FROM, "/d/b.txt");
    expect(renamingIn(0)).toBeNull();
  });

  it("leaves the other pane's box open when both panes rename the same file", async () => {
    paneStore(0).getState().setRenaming(FROM);
    paneStore(1).getState().setRenaming(FROM);
    usePanes.setState({ focused: 1 });
    await commitRename(0, FROM, "b.txt");
    expect(renamingIn(0)).toBeNull();
    expect(renamingIn(1)).toBe(FROM);
  });

  it("does nothing when its pane's box is already closed", async () => {
    await commitRename(0, FROM, "b.txt");
    expect(api.renamePath).not.toHaveBeenCalled();
  });
});

describe("new folder with selection", () => {
  const made = { kind: "trash", path: "/d/New folder" };
  const back = [
    { kind: "move", from: "/d/New folder/a.txt", to: "/d/a.txt" },
    { kind: "move", from: "/d/New folder/b.txt", to: "/d/b.txt" },
  ];
  const start = () => {
    usePanes.setState({ split: false, focused: 0 });
    paneStore(0).getState().navigate({ kind: "path", path: "/d" });
    paneStore(0).getState().setSelection(["/d/a.txt", "/d/b.txt"]);
  };

  it("is one undo that moves the items back before it trashes the folder", async () => {
    vi.mocked(api.movePaths).mockResolvedValue({ inverse: back, cancelled: false, errors: [] } as never);
    start();
    await newFolderWithSelection();
    expect(vi.mocked(api.movePaths).mock.lastCall?.slice(0, 2)).toEqual([["/d/a.txt", "/d/b.txt"], "/d/New folder"]);
    expect(topOf(useHistory.getState().undo)?.steps).toEqual([...back, made]);
  });

  it("can still undo the folder when the move fails", async () => {
    vi.mocked(api.movePaths).mockRejectedValue("disk gone");
    start();
    await newFolderWithSelection();
    expect(topOf(useHistory.getState().undo)?.steps).toEqual([made]);
  });
});

describe("items handed over from outside", () => {
  it("opens a folder in a new tab and shows anything else selected in its folder", async () => {
    vi.mocked(api.takeOpened).mockResolvedValueOnce([
      { path: "/d/sub", reveal: false },
      { path: "/d/a.txt", reveal: false },
      { path: "/d/sub", reveal: true },
      { path: "/", reveal: true },
    ]);
    const before = paneStore(0).getState().tabs.length;
    openHanded();
    await vi.waitFor(() => expect(paneStore(0).getState().tabs.length).toBe(before + 4));
    const opened = paneStore(0)
      .getState()
      .tabs.slice(before)
      .map((t) => [t.location.kind === "path" ? t.location.path : t.location.kind, t.selection]);
    expect(opened).toEqual([
      ["/d/sub", []],
      ["/d", ["/d/a.txt"]],
      ["/d", ["/d/sub"]],
      ["/", []],
    ]);
  });
});
