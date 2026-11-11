import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import type { ReactElement } from "react";
import { PdfViewer } from "./PdfViewer";
import { ImageViewer } from "./ImageViewer";
import { Reader } from "./Reader";
import { reply } from "../test/tauri";
import { mount } from "../test/mount";

let unmount = () => {};
afterEach(async () => {
  unmount();
  document.documentElement.removeAttribute("data-window-buttons");
  await page.viewport(1200, 800);
});

/** Widens a viewer window from its smallest width and lists where the toolbar does not fit. */
async function misfits(viewer: ReactElement, minWidth: number) {
  const found: string[] = [];
  ({ unmount } = await mount(viewer, minWidth));
  const bar = document.querySelector<HTMLElement>(".iv-bar")!;
  for (const style of ["macos", "windows"]) {
    document.documentElement.setAttribute("data-window-buttons", style);
    for (let width = minWidth; width <= 1000; width += 10) {
      await page.viewport(width, 600);
      const buttons = bar.querySelector(style === "windows" ? ".caption-windows" : ".traffic-lights")!;
      const box = buttons.getBoundingClientRect();
      if (box.width === 0 || box.left < 0 || box.right > width) found.push(`${style} ${width}: window buttons off screen`);
      // Nothing else in the bar may run under the window buttons or past the window edge.
      const from = style === "windows" ? 0 : box.right;
      const to = style === "windows" ? box.left : width;
      for (const el of bar.querySelectorAll<HTMLElement>(":scope > *")) {
        if (el === buttons || el.offsetWidth === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.left < from || r.right > to) found.push(`${style} ${width}: ${el.className} by ${Math.ceil(Math.max(from - r.left, r.right - to))}px`);
      }
      // A toolbar hides whole tools to fit. None may be cut off at the left.
      const tools = bar.querySelector(".iv-tools")!;
      const first = [...tools.children].find((el) => (el as HTMLElement).offsetWidth > 0)!;
      const cut = tools.getBoundingClientRect().left - first.getBoundingClientRect().left;
      if (cut > 0.5) found.push(`${style} ${width}: tools cut by ${Math.ceil(cut)}px`);
    }
  }
  return found;
}

test("the PDF toolbar fits beside the window buttons at every width", async () => {
  reply("pdf_state", {
    path: "/Users/me/Documents/histology request form.pdf",
    error: null,
    locked: false,
    pages: 128,
    page: 99,
    scale: 1.29,
    fit: false,
    twoUp: false,
    thumbnails: false,
    found: null,
  });
  expect((await misfits(<PdfViewer />, 480)).join("\n")).toBe("");
});

test("the image viewer toolbar fits beside the window buttons at every width", async () => {
  expect((await misfits(<ImageViewer />, 420)).join("\n")).toBe("");
});

test("the reader toolbar fits beside the window buttons at every width", async () => {
  expect((await misfits(<Reader />, 420)).join("\n")).toBe("");
});
