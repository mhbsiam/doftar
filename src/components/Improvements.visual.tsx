import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { CopyRegular, CutRegular, DeleteRegular, EditRegular, FolderOpenRegular, InfoRegular } from "@fluentui/react-icons";
import { ContextMenuHost } from "./ContextMenu";
import { DialogHost } from "./Dialogs";
import { DiskDuplicates } from "./DiskDuplicates";
import { FolderTreeSlot } from "./FolderTree";
import { PaneBoundary } from "./PaneBoundary";
import { useUI } from "../stores/ui";
import { useAppData } from "../stores/appdata";
import { reply } from "../test/tauri";
import { mount, settle, SPLIT, WIDE } from "../test/mount";

let unmount = () => {};
afterEach(() => {
  unmount();
  const ui = useUI.getState();
  ui.closeContextMenu();
  ui.closeSendTo();
  ui.setSelectPatternOpen(false);
  ui.closeFolderTree();
});

test("the item menu shows shortcuts and sets Delete apart", async () => {
  ({ unmount } = await mount(<ContextMenuHost />, WIDE));
  useUI.getState().openContextMenu(
    40,
    40,
    [
      { key: "open", label: "Open", icon: <FolderOpenRegular />, keys: "⌘↓" },
      { key: "copy-as", label: "Copy as", icon: <CopyRegular />, dividerBefore: true, items: [{ key: "p", label: "Path", keys: "⌥⌘C" }] },
      { key: "props", label: "Properties", icon: <InfoRegular />, keys: "⌘I" },
    ],
    [
      { key: "cut", label: "Cut", icon: <CutRegular /> },
      { key: "copy", label: "Copy", icon: <CopyRegular /> },
      { key: "rename", label: "Rename", icon: <EditRegular /> },
      { key: "delete", label: "Move to Trash", icon: <DeleteRegular />, danger: true },
    ]
  );
  await settle(700);
  const menu = document.querySelector<HTMLElement>(".ctx-menu [role=menu]")!;
  // Typing a letter moves to the item that starts with it.
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true }));
  expect(document.activeElement?.textContent).toContain("Properties");
  await expect.element(page.elementLocator(document.querySelector(".ctx-menu")!)).toMatchScreenshot("menu-hints");
});

test("select by pattern counts as you type", async () => {
  ({ unmount } = await mount(<DialogHost />, WIDE));
  useUI.getState().setSelectPatternOpen(true);
  await settle();
  await expect.element(page.getByRole("dialog")).toMatchScreenshot("select-pattern");
});

test("move to lists favorites and frequent folders", async () => {
  useAppData.setState({
    home: "/Users/me",
    favorites: [{ path: "/Users/me/Projects", name: "Projects", dirName: "/Users/me", modifiedMs: 0, isDir: true }],
    recentFolders: [
      { path: "/Users/me/Documents/Taxes 2026", name: "Taxes 2026", dirName: "/Users/me/Documents", ts: Date.now(), visits: 9 },
      { path: "/Volumes/Backup/Photos", name: "Photos", dirName: "/Volumes/Backup", ts: Date.now(), visits: 2 },
    ],
  });
  ({ unmount } = await mount(<DialogHost />, WIDE));
  useUI.getState().openSendTo(["/Users/me/Downloads/a.pdf", "/Users/me/Downloads/b.pdf"], "move");
  await settle();
  await expect.element(page.getByText("Taxes 2026")).toBeVisible();
  await expect.element(page.getByRole("dialog")).toMatchScreenshot("send-to");
});

test("an archive lists what it holds", async () => {
  reply("archive_list", {
    truncated: false,
    entries: [
      { path: "site/index.html", size: 4_200, isDir: false },
      { path: "site/img/hero.png", size: 1_800_000, isDir: false },
      { path: "site/img/logo.svg", size: 9_100, isDir: false },
      { path: "site/css/main.css", size: 31_000, isDir: false },
    ],
  });
  ({ unmount } = await mount(<FolderTreeSlot pane={0} />, SPLIT));
  useUI.getState().openFolderTree("/Users/me/Downloads/site.zip", 0, true);
  await settle(700);
  await expect.element(page.getByText("index.html")).toBeVisible();
  await expect.element(page.elementLocator(document.querySelector(".ftree")!)).toMatchScreenshot("archive-contents");
});

test("duplicate files come in sets, and one copy always stays", async () => {
  useAppData.setState({ home: "/Users/me" });
  reply("find_duplicates", {
    cancelled: false,
    truncated: false,
    wasted: 2_400_000_000,
    groups: [
      { size: 1_200_000_000, paths: ["/Users/me/Movies/trip.mov", "/Users/me/Desktop/trip copy.mov", "/Users/me/Downloads/trip.mov"] },
      { size: 48_000_000, paths: ["/Users/me/Documents/deck.key", "/Users/me/Downloads/deck.key"] },
    ],
  });
  ({ unmount } = await mount(<DiskDuplicates title={<h2 className="disk-card-title">Duplicate files</h2>} open />, WIDE));
  await page.getByRole("button", { name: "Find duplicates" }).click();
  await settle();
  await page.getByRole("button", { name: "Select all but one of each" }).click();
  await settle();
  expect(document.querySelectorAll("input:checked").length).toBe(3);
  await expect.element(page.elementLocator(document.querySelector(".disk-card")!)).toMatchScreenshot("duplicates");
});

test("a part that fails to draw is replaced, not the whole window", async () => {
  const Broken = (): never => {
    throw new Error("Cannot read properties of undefined (reading 'name')");
  };
  ({ unmount } = await mount(
    <PaneBoundary what="this tab">
      <Broken />
    </PaneBoundary>,
    SPLIT
  ));
  await expect.element(page.getByRole("alert")).toMatchScreenshot("pane-fault");
});
