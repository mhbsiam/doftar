import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { DialogHost } from "./Dialogs";
import { useUI } from "../stores/ui";
import { mount, settle, WIDE } from "../test/mount";

let unmount = () => {};
afterEach(() => unmount());

test.each(["Mac", "Windows"])("keyboard shortcut sheet, %s keys", async (keys) => {
  ({ unmount } = await mount(<DialogHost />, WIDE));
  useUI.getState().setShortcutsOpen(true);
  await settle();
  await page.getByRole("radio", { name: keys }).click();
  await expect.element(page.getByRole("dialog")).toMatchScreenshot(`shortcuts-${keys.toLowerCase()}`);
});
