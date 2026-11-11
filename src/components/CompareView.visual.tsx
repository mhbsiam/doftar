import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { CompareView } from "./CompareView";
import { reply } from "../test/tauri";
import { mount, settle, SPLIT, WIDE } from "../test/mount";
import { useTabs } from "../stores/tabs";

const old = "import os\n\ndef load(path):\n    return open(path).read()\n\nprint(load('a.txt'))\n";
const fresh = "import os\nimport sys\n\ndef load(path, mode='r'):\n    return open(path, mode).read()\n\nprint(load(sys.argv[1]))\n";
reply("read_document", ({ path }: { path: string }) => ({
  path,
  kind: "code",
  lang: "python",
  text: path.endsWith("old.py") ? old : fresh,
}));

let unmount = () => {};
afterEach(() => unmount());

test.each([
  ["wide", WIDE],
  ["split", SPLIT],
])("compare page marks the lines that differ when %s", async (name, width) => {
  useTabs.getState().navigate({ kind: "compare", a: "/Users/me/old.py", b: "/Users/me/new.py" });
  ({ unmount } = await mount(<CompareView />, width));
  await settle();
  expect(document.querySelectorAll(".cmp-del").length).toBe(3);
  expect(document.querySelectorAll(".cmp-add").length).toBe(4);
  expect(document.querySelector(".cmp-count")!.textContent).toContain("4");
  await expect.element(page.elementLocator(document.querySelector(".cmp-page")!)).toMatchScreenshot(`compare-${name}`);
});
