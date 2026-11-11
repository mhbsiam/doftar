import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { DialogHost } from "./Dialogs";
import { useUI } from "../stores/ui";
import { reply } from "../test/tauri";
import { mount, settle, WIDE } from "../test/mount";

let unmount = () => {};
afterEach(() => unmount());

test("properties lists a photo's metadata by source", async () => {
  reply("item_info", {
    size: 2_400_000,
    sizeOnDisk: 2_400_256,
    mode: 0o644,
    owner: "alex",
    group: "staff",
    createdMs: 1_641_608_418_000,
    modifiedMs: 1_641_608_418_000,
    accessedMs: 1_641_608_418_000,
    symlinkTarget: null,
    tags: [],
    defaultApp: "/System/Applications/Preview.app",
    quarantined: false,
    whereFroms: [],
  });
  reply("item_metadata", [
    {
      title: "Image",
      rows: [
        { label: "Pixel Height", text: "3301", dateMs: null },
        { label: "Pixel Width", text: "2536", dateMs: null },
      ],
    },
    {
      title: "Exif",
      rows: [
        { label: "Exposure Time", text: "0.04", dateMs: null },
        { label: "F Number", text: "2.3", dateMs: null },
      ],
    },
    {
      title: "Spotlight",
      rows: [
        { label: "Acquisition Model", text: "Example Phone", dateMs: null },
        { label: "Content Creation Date", text: "2022-01-08T02:20:18Z", dateMs: 1_641_608_418_000 },
      ],
    },
  ]);
  ({ unmount } = await mount(<DialogHost />, WIDE));
  useUI.getState().openProperties({
    name: "headshot.jpg",
    path: "/Users/alex/Pictures/headshot.jpg",
    isDir: false,
    isHidden: false,
    isSymlink: false,
    isPackage: false,
    size: 2_400_000,
    modifiedMs: 1_641_608_418_000,
    createdMs: 1_641_608_418_000,
    ext: "jpg",
  });
  await settle();
  await expect.element(page.getByText("Example Phone")).toBeVisible();
  await expect.element(page.getByRole("dialog")).toMatchScreenshot("properties-metadata");
});
