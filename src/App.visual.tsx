import { afterEach, expect, test } from "vitest";
import App from "./App";
import { mount, settle } from "./test/mount";
import { togglePreview } from "./actions";
import { paneStore, usePanes } from "./stores/tabs";
import { useSettings } from "./stores/settings";

const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
const listing = (pane: number) => rect(`.pane[data-pane="${pane}"] .content-frame`).width;
const rightNav = () => rect('.pane[data-pane="1"] .navpane-slot').width;

let unmount = () => {};
afterEach(() => {
  unmount();
  paneStore(1).getState().setPreviewOpen(false);
  usePanes.setState({ split: false, focused: 0 });
});

test("in split view both halves lay out alike, one preview hides the right navigation pane, and the listings share the width", async () => {
  usePanes.setState({ split: true, focused: 0 });
  ({ unmount } = await mount(<App />, 1200));
  await settle(700);
  const navWidth = rightNav();
  expect(navWidth).toBeGreaterThan(0);
  expect(listing(0)).toBeCloseTo(listing(1), 0);
  // Each half has its navigation pane on its left.
  for (const pane of [0, 1]) {
    expect(rect(`.pane[data-pane="${pane}"] .navpane-slot`).left).toBeCloseTo(rect(`.pane[data-pane="${pane}"]`).left, 0);
  }

  // Opened from the left half, it still docks at the window's right edge.
  togglePreview();
  await settle(700);
  const preview = rect('.pane[data-pane="1"] .preview-slot');
  expect(preview.width).toBeGreaterThan(0);
  expect(preview.right).toBeCloseTo(rect(".app").right, 0);
  expect(rightNav()).toBe(0);
  expect(rect('.pane[data-pane="0"] .preview-slot').width).toBe(0);
  expect(listing(0)).toBeCloseTo(listing(1), 0);
  expect(usePanes.getState().focused).toBe(0);

  // A wider preview still leaves two listings of the same width.
  useSettings.getState().set({ previewWidth: 30 });
  await settle(700);
  expect(listing(0)).toBeCloseTo(listing(1), 0);
  useSettings.getState().set({ previewWidth: 24 });

  // Closing it shows the navigation pane again.
  togglePreview();
  await settle(700);
  expect(rightNav()).toBeCloseTo(navWidth, 0);
  expect(listing(0)).toBeCloseTo(listing(1), 0);
});
