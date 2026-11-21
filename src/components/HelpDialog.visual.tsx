import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { DialogHost } from "./Dialogs";
import { useUI } from "../stores/ui";
import { mount, settle, WIDE } from "../test/mount";

/** Moves the pointer off the nav, so a hover left by an earlier test does not show in a screenshot. */
const parkPointer = () => page.getByText("Help", { exact: true }).hover();

let unmount = () => {};
afterEach(() => {
  unmount();
  useUI.getState().setHelpOpen(false);
});

test("help page, one topic at a time", async () => {
  ({ unmount } = await mount(<DialogHost />, WIDE));
  useUI.getState().setHelpOpen(true);
  await settle();
  await parkPointer();
  await expect.element(page.getByRole("dialog")).toMatchScreenshot("help-moving");
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect.element(page.getByRole("heading", { level: 2, name: "Compare" })).toBeVisible();
  await parkPointer();
  await expect.element(page.getByRole("dialog")).toMatchScreenshot("help-compare");
});

test("help search lists matching topics from every section; Esc clears it, then closes Help", async () => {
  ({ unmount } = await mount(<DialogHost />, WIDE));
  useUI.getState().setHelpOpen(true);
  await settle();
  await page.getByRole("searchbox", { name: "Search help" }).fill("cloud drive");
  await expect.element(page.getByRole("heading", { level: 3, name: "Trash or delete" })).toBeVisible();
  await expect.element(page.getByRole("heading", { level: 3, name: "Cloud drives" })).toBeVisible();
  await parkPointer();
  await expect.element(page.getByRole("dialog")).toMatchScreenshot("help-search");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("heading", { level: 2, name: "Moving and copying" })).toBeVisible();
  expect(useUI.getState().helpOpen).toBe(true);
  await userEvent.keyboard("{Escape}");
  expect(useUI.getState().helpOpen).toBe(false);
});

test("help fits the smallest window", async () => {
  await page.viewport(760, 500);
  ({ unmount } = await mount(<DialogHost />, 760));
  useUI.getState().setHelpOpen(true);
  await settle();
  await parkPointer();
  await expect.element(page.getByRole("dialog")).toMatchScreenshot("help-small-window");
  await page.viewport(1200, 800);
});
