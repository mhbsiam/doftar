import { afterEach, expect, test } from "vitest";
import App from "./App";
import { mount, settle } from "./test/mount";
import { togglePreview } from "./actions";
import { isSplitAnimating, paneStore, toggleSplit, usePanes } from "./stores/tabs";
import { dur } from "./util/motion";
import { useSettings } from "./stores/settings";
import { useClipboard } from "./stores/clipboard";

const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
const listing = (pane: number) => rect(`.pane[data-pane="${pane}"] .content-frame`).width;
const rightNav = () => rect('.pane[data-pane="1"] .navpane-slot').width;

let unmount = () => {};
afterEach(() => {
  unmount();
  paneStore(1).getState().setPreviewOpen(false);
  usePanes.setState({ split: false, focused: 0 });
});

test("a two-finger swipe shows an arrow that grows, then goes back; the setting turns it off", async () => {
  ({ unmount } = await mount(<App />, 1200));
  paneStore(0).getState().navigate({ kind: "path", path: "/Users/me" });
  await settle(500);
  const frame = document.querySelector<HTMLElement>('.pane[data-pane="0"] .content-frame')!;
  const swipe = (dx: number) =>
    frame.querySelector(".content")!.dispatchEvent(new WheelEvent("wheel", { deltaX: dx, bubbles: true }));
  const cue = () => getComputedStyle(frame.querySelector(".swipe-cue")!);
  const location = () => {
    const s = paneStore(0).getState();
    return s.tabs.find((t) => t.id === s.activeId)!.location.kind;
  };

  // Forward has nowhere to go, so no arrow.
  swipe(60);
  expect(Number(frame.style.getPropertyValue("--swipe"))).toBe(0);
  await settle(300);

  swipe(-90);
  expect(frame.dataset.swipe).toBe("back");
  expect(cue().display).toBe("grid");
  expect(Number(frame.style.getPropertyValue("--swipe"))).toBeCloseTo(0.5, 2);
  expect(location()).toBe("path");
  swipe(-90);
  await settle(500);
  expect(location()).toBe("home");
  expect(Number(frame.style.getPropertyValue("--swipe"))).toBe(0);

  paneStore(0).getState().go(1);
  await settle(500);
  useSettings.getState().set({ swipeNavigation: false });
  swipe(-200);
  await settle(500);
  expect(location()).toBe("path");
  useSettings.getState().set({ swipeNavigation: true });
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

test("split view opens and closes with no pane left at a held width, and with a preview the seam does not jump at the end", async () => {
  // No room beside the window, so the one pane narrows in place.
  Object.defineProperty(window.screen, "availWidth", { value: 1200, configurable: true });
  ({ unmount } = await mount(<App />, 1200));
  togglePreview();
  await settle(700);
  const pane = (n: number) => document.querySelector<HTMLElement>(`.pane[data-pane="${n}"]`)!;

  toggleSplit();
  // The left half has narrowed. The right one is still unfolding.
  await settle(dur("long") + 100);
  expect(isSplitAnimating()).toBe(true);
  const held = rect('.pane[data-pane="0"]').width;
  await settle(dur("long"));
  expect(isSplitAnimating()).toBe(false);
  // Held at half the window, the seam would jump about 50px here. A few px remain: the right
  // navigation pane closes for the preview just after the halves are measured.
  expect(Math.abs(rect('.pane[data-pane="0"]').width - held)).toBeLessThan(4);
  expect(listing(0)).toBeCloseTo(listing(1), 0);
  // Only the styles React sets stay on the panes.
  const animated = (n: number) => ["flex", "transition", "transform-origin"].map((p) => pane(n).style.getPropertyValue(p));
  for (const n of [0, 1]) expect(animated(n)).toEqual(["", "", ""]);

  toggleSplit();
  await settle(dur("long") * 2);
  expect(isSplitAnimating()).toBe(false);
  expect(animated(0)).toEqual(["", "", ""]);
  expect(rect('.pane[data-pane="0"]').width).toBeCloseTo(rect(".app").width, 0);
  togglePreview();
  delete (window.screen as { availWidth?: number }).availWidth;
});

test("Escape cancels a pending cut first, then leaves split view keeping the focused pane", async () => {
  ({ unmount } = await mount(<App />, 1200));
  toggleSplit();
  await settle(dur("long") * 2);
  const escape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  useClipboard.setState({ op: "cut" });
  escape();
  expect(useClipboard.getState().op).toBe("copy");
  expect(usePanes.getState().split).toBe(true);

  const rightTab = paneStore(1).getState().activeId;
  usePanes.setState({ focused: 1 });
  escape();
  await settle(dur("long") * 2);
  expect(usePanes.getState().split).toBe(false);
  expect(paneStore(0).getState().activeId).toBe(rightTab);
});
