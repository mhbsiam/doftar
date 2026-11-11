import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { TermsGate, TERMS_VERSION } from "./TermsGate";
import { useSettings } from "../stores/settings";
import { mount, settle, WIDE } from "../test/mount";

let unmount = () => {};
afterEach(() => unmount());

test("the app shows only after the terms are agreed to", async () => {
  useSettings.setState({ termsAccepted: null });
  ({ unmount } = await mount(
    <TermsGate>
      <div id="the-app" />
    </TermsGate>,
    WIDE
  ));
  expect(document.getElementById("the-app")).toBeNull();
  expect(document.querySelectorAll(".dialog-body.terms h3").length).toBeGreaterThan(5);
  await expect.element(page.getByRole("dialog")).toMatchScreenshot("terms-gate");

  const body = document.querySelector<HTMLElement>(".dialog-body.terms")!;
  await expect
    .poll(() => body.textContent, { timeout: 10000 })
    .toContain("TERMS AND CONDITIONS FOR USE");
  const agree = page.getByRole("button", { name: "I Agree" });
  await expect.element(agree).toBeEnabled();
  await agree.click();
  await settle(50);
  expect(useSettings.getState().termsAccepted).toBe(TERMS_VERSION);
  expect(document.getElementById("the-app")).not.toBeNull();
});
