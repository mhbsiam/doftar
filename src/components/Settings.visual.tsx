import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { DialogHost } from "./Dialogs";
import { useUI } from "../stores/ui";
import { useSettings } from "../stores/settings";
import { mount, settle, WIDE } from "../test/mount";

let unmount = () => {};
// Settings persist, so put the clock back: later tests draw times.
afterEach(() => {
  unmount();
  useSettings.getState().set({ clock: "12" });
});

test("settings dialog changes a preference at once", async () => {
  ({ unmount } = await mount(<DialogHost />, WIDE));
  useUI.getState().setSettingsOpen(true);
  await settle();
  await page.getByRole("radio", { name: "24-hour" }).click();
  expect(useSettings.getState().clock).toBe("24");
  await expect.element(page.getByRole("dialog")).toMatchScreenshot("settings");
});
