import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { PreviewSlot } from "./PreviewPane";
import { reply } from "../test/tauri";
import { mount, settle } from "../test/mount";
import { useTabs } from "../stores/tabs";
import { useUI } from "../stores/ui";
import { DEFAULT_PREVIEW_REM, useSettings } from "../stores/settings";
import { activateEntry, showFolderTree, togglePreview } from "../actions";
import type { FileEntry } from "../types";

const item = (path: string, isDir: boolean, size = 0) =>
  ({
    name: path.split("/").pop()!, path, isDir, isHidden: false, isSymlink: false, isPackage: false,
    size, modifiedMs: Date.parse("2025-10-02T08:00:00Z"), createdMs: 0, ext: isDir ? "" : path.split(".").pop()!,
  }) as FileEntry;

const DOCS = "/Users/me/Documents";
const notes = item(`${DOCS}/notes.txt`, false, 1_200);

let unmount = () => {};
afterEach(() => {
  unmount();
  useTabs.getState().setPreviewOpen(false);
  useTabs.getState().setPreview(null);
  useUI.setState({ toasts: [], folderTree: null });
  useSettings.getState().set({ previewInfoHeight: 0, previewWidth: DEFAULT_PREVIEW_REM });
});

const bar = () => (
  <div style={{ display: "flex", height: 520, width: 900 }}>
    <div style={{ flex: 1 }} />
    <PreviewSlot />
  </div>
);

test("double-click shows a file in the open preview bar, and opens it once the bar is shut", async () => {
  reply("is_text_file", true);
  reply("read_document", { kind: "text", text: "Lab notes\n\nCentrifuge at 4 °C.", modified: 0 });
  reply("path_exists", false);
  ({ unmount } = await mount(bar(), 900));

  togglePreview();
  activateEntry(notes);
  await settle(700);
  expect(useTabs.getState().preview?.path).toBe(notes.path);
  await expect.element(page.getByText("Centrifuge at 4 °C.", { exact: false })).toBeVisible();
  await expect.element(page.elementLocator(document.querySelector(".preview")!)).toMatchScreenshot("preview-text");

  // When shut, a double-click opens the file. Here the file is missing, so a toast says so.
  togglePreview();
  activateEntry(item(`${DOCS}/other.txt`, false));
  await settle();
  expect(useTabs.getState().preview?.path).toBe(notes.path);
  expect(useUI.getState().toasts.map((t) => t.message).join()).toContain("other.txt");
});

const button = (label: string) => document.querySelector<HTMLButtonElement>(`.pv-zoom [aria-label^="${label}"]`)!;

test("text zooms with the buttons and ⌘-scroll, within limits, and resets", async () => {
  reply("is_text_file", true);
  reply("read_document", { kind: "text", text: "Lab notes\n".repeat(200), modified: 0 });
  ({ unmount } = await mount(bar(), 900));
  togglePreview();
  activateEntry(notes);
  await settle(700);
  const article = document.querySelector<HTMLElement>(".pv-stage article")!;
  const px = () => parseFloat(getComputedStyle(article).fontSize);
  const base = px();

  button("Zoom in").click();
  await settle(50);
  expect(px()).toBeCloseTo(base * 1.25, 1);
  await expect.element(page.elementLocator(document.querySelector(".preview")!)).toMatchScreenshot("preview-zoomed");

  const stage = document.querySelector<HTMLElement>(".pv-stage")!;
  const wheel = (deltaY: number, metaKey = true) =>
    stage.dispatchEvent(new WheelEvent("wheel", { deltaY, metaKey, bubbles: true, cancelable: true }));
  wheel(-100);
  await settle(50);
  expect(px()).toBeCloseTo(base * 1.25 * 1.25, 1);
  // A plain scroll scrolls.
  expect(wheel(-100, false)).toBe(true);

  for (let i = 0; i < 10; i++) button("Zoom in").click();
  await settle(50);
  expect(px()).toBeCloseTo(base * 3, 1);
  expect(button("Zoom in").disabled).toBe(true);

  button("Reset").click();
  await settle(50);
  expect(px()).toBeCloseTo(base, 1);
});

test("a PDF scrolls through all its pages, drawing only those near the view, and zooms", async () => {
  const canvas = Object.assign(document.createElement("canvas"), { width: 400, height: 500 });
  const picture = canvas.toDataURL();
  const asked: { index: number; maxDim: number }[] = [];
  const cancelled: number[] = [];
  reply("pdf_page_sizes", Array.from({ length: 40 }, () => ({ w: 400, h: 500 })));
  reply("pdf_page_picture", (a: { index: number; maxDim: number }) => (asked.push(a), picture));
  reply("cancel_thumbnail", ({ requestId }: { requestId: number }) => void cancelled.push(requestId));
  ({ unmount } = await mount(bar(), 900));
  togglePreview();
  await settle(700);
  activateEntry(item(`${DOCS}/paper.pdf`, false));
  await settle(300);

  const stage = document.querySelector<HTMLElement>(".pv-stage.pdf")!;
  const sheets = [...document.querySelectorAll<HTMLElement>(".pv-sheet")];
  expect(sheets).toHaveLength(40);
  expect(stage.scrollHeight).toBeGreaterThan(stage.clientHeight * 10);
  expect(sheets[0].querySelector("img")).not.toBe(null);
  expect(sheets[39].querySelector("img")).toBe(null);
  expect(Math.max(...asked.map((a) => a.index))).toBeLessThan(10);

  stage.scrollTop = stage.scrollHeight;
  await settle(300);
  expect(sheets[39].querySelector("img")?.alt).toBe("Page 40");
  // A page far from the view lets go of its picture.
  expect(sheets[0].querySelector("img")).toBe(null);

  const narrow = sheets[39].offsetWidth;
  for (let i = 0; i < 4; i++) button("Zoom in").click();
  await settle(300);
  expect(sheets[39].offsetWidth).toBeCloseTo(narrow * 1.25 ** 4, -1);
  expect(stage.scrollWidth).toBeGreaterThan(stage.clientWidth);
  expect(Math.max(...asked.map((a) => a.maxDim))).toBeGreaterThan(Math.min(...asked.map((a) => a.maxDim)));
  await expect.element(page.getByAltText("Page 40")).toBeVisible();

  // Scrolling past a page still being drawn cancels it.
  reply("pdf_page_picture", () => new Promise(() => {}));
  stage.scrollTop = 0;
  await settle(200);
  expect(cancelled).toEqual([]);
  stage.scrollTop = stage.scrollHeight;
  await settle(200);
  expect(cancelled.length).toBeGreaterThan(0);
});

test("a PDF that can't be read page by page shows its Quick Look picture", async () => {
  const canvas = Object.assign(document.createElement("canvas"), { width: 400, height: 500 });
  reply("pdf_page_sizes", () => Promise.reject("the PDF is protected with a password"));
  reply("thumbnail", canvas.toDataURL());
  ({ unmount } = await mount(bar(), 900));
  togglePreview();
  activateEntry(item(`${DOCS}/locked.pdf`, false));
  await settle(700);
  expect(document.querySelector(".pv-stage.pdf")).toBe(null);
  expect(document.querySelector(".pv-stage img")).not.toBe(null);
});

test("rewriting a PDF keeps the zoom and the place, and draws the new pages", async () => {
  const canvas = Object.assign(document.createElement("canvas"), { width: 400, height: 500 });
  const sizes = Array.from({ length: 40 }, () => ({ w: 400, h: 500 }));
  const asked: number[] = [];
  reply("pdf_page_sizes", sizes);
  reply("pdf_page_picture", ({ index }: { index: number }) => (asked.push(index), canvas.toDataURL()));
  ({ unmount } = await mount(bar(), 900));
  togglePreview();
  await settle(700);
  const paper = item(`${DOCS}/paper.pdf`, false);
  activateEntry(paper);
  await settle(300);
  button("Zoom in").click();
  await settle(100);
  const stage = document.querySelector<HTMLElement>(".pv-stage.pdf")!;
  stage.scrollTop = 3000;
  await settle(200);
  const place = stage.scrollTop;
  expect(place).toBeGreaterThan(0);

  // Halfway through a rewrite, the file can't be read.
  reply("pdf_page_sizes", () => Promise.reject("can't read this PDF"));
  useTabs.getState().setPreview({ ...paper, modifiedMs: paper.modifiedMs + 1 });
  await settle(200);
  expect(document.querySelector(".pv-stage.pdf")).toBe(stage);
  expect(stage.scrollTop).toBe(place);

  reply("pdf_page_sizes", sizes);
  asked.length = 0;
  useTabs.getState().setPreview({ ...paper, modifiedMs: paper.modifiedMs + 2 });
  await settle(200);
  expect(document.querySelector(".pv-stage.pdf")).toBe(stage);
  expect(stage.scrollTop).toBe(place);
  expect(button("Reset").textContent).toBe("125%");
  expect(asked.length).toBeGreaterThan(0);
});

test("a picture grows past the bar, scrolls, asks for a sharper copy, and fits again on reset", async () => {
  const canvas = Object.assign(document.createElement("canvas"), { width: 400, height: 300 });
  const small = canvas.toDataURL();
  const sizes: number[] = [];
  reply("thumbnail", ({ maxDim }: { maxDim: number }) => (sizes.push(maxDim), small));
  ({ unmount } = await mount(bar(), 900));
  togglePreview();
  activateEntry(item(`${DOCS}/photo.png`, false));
  await settle(700);
  const pic = () => document.querySelector<HTMLImageElement>(".pv-stage img")!;
  const stage = document.querySelector<HTMLElement>(".pv-stage")!;
  const fitted = pic().offsetWidth;
  expect(fitted).toBeGreaterThan(0);
  expect(sizes).toEqual([800]);
  expect(button("Zoom out").disabled).toBe(true);

  for (let i = 0; i < 4; i++) button("Zoom in").click();
  await settle(100);
  expect(pic().offsetWidth).toBeCloseTo(fitted * 1.25 ** 4, 0);
  expect(stage.scrollWidth).toBeGreaterThan(stage.clientWidth);
  expect(sizes).toEqual([800, 3200]);
  // The zoomed point stays in view: the stage centre, not the top-left corner.
  expect(stage.scrollLeft).toBeGreaterThan(0);

  button("Reset").click();
  await settle(100);
  expect(pic().offsetWidth).toBe(fitted);
  expect(stage.scrollWidth).toBe(stage.clientWidth);
});

test("the folder tree and the preview bar take turns on the same side", async () => {
  togglePreview();
  showFolderTree(DOCS);
  expect(useTabs.getState().previewOpen).toBe(false);
  togglePreview();
  expect(useUI.getState().folderTree).toBe(null);
  expect(useTabs.getState().previewOpen).toBe(true);
});

test("the bar's width is not remembered, between openings or launches", async () => {
  ({ unmount } = await mount(bar(), 900));
  togglePreview();
  useSettings.getState().set({ previewWidth: 40 });
  expect(localStorage.getItem("doftar-settings")).not.toContain("previewWidth");
  togglePreview();
  togglePreview();
  expect(useSettings.getState().previewWidth).toBe(DEFAULT_PREVIEW_REM);

  // A width saved by an older version is dropped.
  localStorage.setItem("doftar-settings", JSON.stringify({ state: { previewWidth: 53 }, version: 6 }));
  await useSettings.persist.rehydrate();
  expect(useSettings.getState().previewWidth).toBe(DEFAULT_PREVIEW_REM);
});

test("dragging the bar's inner edge, or the arrow keys, sets its width; double-click resets it", async () => {
  ({ unmount } = await mount(bar(), 900));
  togglePreview();
  await settle(700);
  const handle = document.querySelector<HTMLElement>(".pv-resizer")!;
  const slot = document.querySelector<HTMLElement>(".preview-slot")!;
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const x = handle.getBoundingClientRect().left + 2;
  const at = (clientX: number) => ({ clientX, clientY: 100, pointerId: 1, button: 0, bubbles: true });

  handle.dispatchEvent(new PointerEvent("pointerdown", at(x)));
  handle.dispatchEvent(new PointerEvent("pointermove", at(x - 4 * px)));
  expect(slot.getBoundingClientRect().width).toBeCloseTo((DEFAULT_PREVIEW_REM + 4) * px, 0);
  handle.dispatchEvent(new PointerEvent("pointerup", at(x - 4 * px)));
  expect(useSettings.getState().previewWidth).toBe(DEFAULT_PREVIEW_REM + 4);

  // Limit the width to 70% of the row, so the listing is never squeezed out.
  handle.dispatchEvent(new PointerEvent("pointerdown", at(x)));
  handle.dispatchEvent(new PointerEvent("pointermove", at(x - 2000)));
  handle.dispatchEvent(new PointerEvent("pointerup", at(x - 2000)));
  expect(useSettings.getState().previewWidth * px).toBeLessThanOrEqual(900 * 0.7);

  handle.focus();
  handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  const narrowed = useSettings.getState().previewWidth;
  handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  expect(useSettings.getState().previewWidth).toBe(narrowed + 1);

  handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  expect(useSettings.getState().previewWidth).toBe(DEFAULT_PREVIEW_REM);
});

test("pulling the info's top edge up reveals more details; double-click shuts it", async () => {
  reply("is_text_file", true);
  reply("read_document", { kind: "text", text: "Lab notes", modified: 0 });
  reply("item_info", {
    size: 1_200, sizeOnDisk: 4_096, mode: 0o644, owner: "me", group: "staff",
    createdMs: Date.parse("2025-09-01T09:00:00Z"), modifiedMs: notes.modifiedMs, accessedMs: Date.parse("2025-10-05T18:30:00Z"),
    symlinkTarget: null, tags: [], defaultApp: "/System/Applications/TextEdit.app", quarantined: false,
    whereFroms: ["https://example.org/notes.txt"],
  });
  reply("item_metadata", [{ title: "Spotlight", rows: [{ label: "Words", text: "2", dateMs: null }] }]);
  ({ unmount } = await mount(bar(), 900));
  togglePreview();
  activateEntry(notes);
  await settle(700);
  const grip = document.querySelector<HTMLElement>(".pv-grip")!;
  const footer = document.querySelector<HTMLElement>(".pv-info")!;
  const closed = footer.getBoundingClientRect().height;
  const y = grip.getBoundingClientRect().top + 4;
  const at = (clientY: number) => ({ clientX: 700, clientY, pointerId: 2, button: 0, bubbles: true });

  grip.dispatchEvent(new PointerEvent("pointerdown", at(y)));
  await settle(100);
  grip.dispatchEvent(new PointerEvent("pointermove", at(y - 400)));
  grip.dispatchEvent(new PointerEvent("pointerup", at(y - 400)));
  await settle(400);
  expect(useSettings.getState().previewInfoHeight).toBeGreaterThan(0);
  await expect.element(page.getByText("TextEdit")).toBeVisible();
  await expect.element(page.getByText("Words")).toBeVisible();
  // The bar is no taller than its details, however far it is pulled.
  expect(footer.getBoundingClientRect().height).toBeLessThan(520 * 0.75);
  await expect.element(page.elementLocator(document.querySelector(".preview")!)).toMatchScreenshot("preview-details");

  grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await settle(400);
  expect(useSettings.getState().previewInfoHeight).toBe(0);
  expect(document.querySelector(".pv-more")).toBe(null);
  expect(footer.getBoundingClientRect().height).toBeCloseTo(closed, 0);
});
