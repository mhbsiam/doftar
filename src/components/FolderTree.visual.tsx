import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { FolderTreeSlot } from "./FolderTree";
import { reply } from "../test/tauri";
import { mount, settle, SPLIT, WIDE } from "../test/mount";
import { useUI } from "../stores/ui";
import type { FileEntry } from "../types";

const GB = 1024 ** 3;
const t = (iso: string) => Date.parse(iso);
const item = (path: string, isDir: boolean, size = 0, modified = "2025-03-04T10:00:00Z") =>
  ({
    name: path.split("/").pop()!, path, isDir, isHidden: false, isSymlink: false, isPackage: false,
    size, modifiedMs: t(modified), createdMs: 0, ext: isDir ? "" : path.split(".").pop()!,
  }) as FileEntry;

const LAB = "/Users/me/Documents/Lab";
const listings: Record<string, FileEntry[]> = {
  [LAB]: [
    item(`${LAB}/experiments`, true),
    item(`${LAB}/microscopy`, true),
    item(`${LAB}/papers`, true),
    item(`${LAB}/README.md`, false, 2_100, "2024-11-20T09:00:00Z"),
  ],
  [`${LAB}/experiments`]: [
    item(`${LAB}/experiments/2025-fall`, true),
    item(`${LAB}/experiments/results.csv`, false, 6.1 * GB, "2025-09-12T15:30:00Z"),
    item(`${LAB}/experiments/notes.md`, false, 14_000, "2025-10-02T08:00:00Z"),
  ],
  [`${LAB}/experiments/2025-fall`]: [],
};
const sizes: Record<string, number> = {
  [`${LAB}/experiments`]: 24.1 * GB,
  [`${LAB}/experiments/2025-fall`]: 18 * GB,
  [`${LAB}/microscopy`]: 6.2 * GB,
  [`${LAB}/papers`]: 0.4 * GB,
};
reply("list_dir", ({ path }: { path: string }) => listings[path] ?? []);

let unmount = () => {};
afterEach(() => {
  unmount();
  useUI.getState().closeFolderTree();
});

const tree = (width: number) => (
  <div style={{ display: "flex", height: 520, width }}>
    <div style={{ flex: 1 }} />
    <FolderTreeSlot pane={0} />
  </div>
);

test.each([
  ["wide", WIDE],
  ["split", SPLIT],
])("folder tree shows sizes, bars and dates when %s", async (name, width) => {
  reply("folder_size", ({ paths }: { paths: string[] }) => ({
    bytes: sizes[paths[0]] ?? 0, onDisk: 0, files: 40, folders: 3, done: true,
    cancelled: false, denied: false, unreadable: 0,
  }));
  useUI.getState().openFolderTree(LAB, 0);
  ({ unmount } = await mount(tree(width), width));
  document.querySelector<HTMLElement>(`[title="${LAB}/experiments"]`)!.click();
  await settle(900);
  const rows = [...document.querySelectorAll<HTMLElement>(".ftree-row[role=treeitem]")];
  expect(rows.map((r) => r.querySelector(".ftree-label")!.textContent)).toEqual([
    "experiments", "2025-fall", "results.csv", "notes.md", "microscopy", "papers", "README.md",
  ]);
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    for (const cell of row.children) expect(cell.getBoundingClientRect().bottom).toBeLessThanOrEqual(box.bottom + 0.5);
  }
  await expect.element(page.elementLocator(document.querySelector(".ftree")!)).toMatchScreenshot(`tree-${name}`);
});

test("folders still being sized show a wave, and closing unmounts the panel", async () => {
  reply("folder_size", () => new Promise(() => {}));
  useUI.getState().openFolderTree(LAB, 0);
  ({ unmount } = await mount(tree(WIDE), WIDE));
  expect(document.querySelectorAll(".ftree-pend").length).toBe(3);
  expect(document.querySelector(".ftree-stats .shimmer-text")).not.toBeNull();
  useUI.getState().closeFolderTree();
  await settle(50);
  expect(document.querySelector(".ftree-slot")!.classList.contains("closed")).toBe(true);
  await settle(500);
  expect(document.querySelector(".ftree")).toBeNull();
});
