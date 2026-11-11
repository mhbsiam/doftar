import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { DialogHost } from "./Dialogs";
import { useUI } from "../stores/ui";
import { mount, settle, WIDE } from "../test/mount";

let unmount = () => {};
afterEach(() => unmount());

test("help page, one topic at a time", async () => {
  ({ unmount } = await mount(<DialogHost />, WIDE));
  useUI.getState().setHelpOpen(true);
  await settle();
  await expect.element(page.getByRole("dialog")).toMatchScreenshot("help-moving");
  await page.getByRole("button", { name: "Compare" }).click();
  await expect.element(page.getByRole("heading", { level: 2, name: "Compare" })).toBeVisible();
  await expect.element(page.getByRole("dialog")).toMatchScreenshot("help-compare");
});
