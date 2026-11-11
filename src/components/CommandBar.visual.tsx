import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { CommandBar } from "./CommandBar";
import { mount, settle, SPLIT, WIDE } from "../test/mount";
import { reply } from "../test/tauri";
import { useAppData } from "../stores/appdata";
import { useHistory } from "../stores/history";
import { useUI } from "../stores/ui";
import { undoFromLog } from "../actions";

let unmount = () => {};
afterEach(() => unmount());

test.each([
  ["wide", WIDE],
  ["split", SPLIT],
])("command bar fits when %s", async (name, width) => {
  ({ unmount } = await mount(<CommandBar />, width));
  const bar = document.querySelector<HTMLElement>(".commandbar")!;
  expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
  await expect.element(page.elementLocator(bar)).toMatchScreenshot(`commandbar-${name}`);
});

// The bar folds at fixed widths. Each fold point must leave room for what stays.
test("command bar fits at every width from split to wide", async () => {
  let host: HTMLElement;
  ({ host, unmount } = await mount(<CommandBar />, SPLIT));
  const bar = document.querySelector<HTMLElement>(".commandbar")!;
  const over: number[] = [];
  for (let w = SPLIT; w <= WIDE + 200; w += 4) {
    host.style.width = `${w}px`;
    await new Promise(requestAnimationFrame);
    if (bar.scrollWidth > bar.clientWidth) over.push(w);
  }
  expect(over).toEqual([]);
});

test("activity menu lists file actions and asks before undoing", async () => {
  const home = "/Users/me";
  useAppData.setState({ home });
  reply("item_ids", ({ paths }: { paths: string[] }) =>
    paths.map(
      (p) =>
        ({ [`${home}/Documents/report.pdf`]: "1", [`${home}/Documents/notes.txt`]: "2", [`${home}/Downloads`]: "d" })[p] ??
        null
    )
  );
  const ago = (min: number) => Date.now() - min * 60_000;
  const h = useHistory.getState();
  const moved = h.record("Move", [
    { kind: "move", from: `${home}/Documents/report.pdf`, to: `${home}/Downloads/report.pdf`, id: "1" },
    { kind: "move", from: `${home}/Documents/notes.txt`, to: `${home}/Downloads/notes.txt`, id: "2" },
  ]);
  const renamed = h.record("Rename", [{ kind: "move", from: `${home}/Desktop/new.txt`, to: `${home}/Desktop/old.txt` }]);
  h.settle("undo", renamed, [{ kind: "move", from: `${home}/Desktop/old.txt`, to: `${home}/Desktop/new.txt` }]);
  const copied = h.record("Copy", [{ kind: "trash", path: `${home}/Desktop/photo.jpg` }], [`${home}/Pictures/photo.jpg`]);
  h.logOnly("Delete Immediately", [`${home}/Downloads/old.zip`]);
  useHistory.setState((s) => ({
    log: s.log.map((e, i) => ({ ...e, at: ago([30, 20, 10, 2][i]) })),
  }));
  useUI.getState().setClipHistoryOpen(true);
  ({ unmount } = await mount(<CommandBar />, WIDE));
  await settle();
  const menu = document.querySelector<HTMLElement>(".clip-menu")!;
  const item = (text: string) =>
    [...document.querySelectorAll<HTMLElement>(".clip-menu [role=menuitem]")].find((m) => m.textContent?.includes(text))!;
  expect(item("Move: report.pdf and 1 more").textContent).toContain("~/Downloads → ~/Documents");
  expect(item("Rename: old.txt → new.txt").textContent).toContain("Undone");
  expect(item("Copy: photo.jpg").textContent).toContain("Changed since");
  expect(item("Delete Immediately: old.zip").textContent).toContain("Can't be undone");
  await expect.element(page.elementLocator(menu)).toMatchScreenshot("activity-menu");

  item("Move: report.pdf").click();
  await settle();
  expect(useUI.getState().confirm?.message).toBe("Move 2 items back to ~/Downloads?");
  useUI.getState().confirm?.onCancel?.();
  useUI.getState().closeConfirm();
  expect(useHistory.getState().undo.map((e) => e.id)).toEqual([moved.id, copied.id]);

  reply("apply_steps", ({ steps }: { steps: { from: string; to: string }[] }) => ({
    inverse: steps.map((s) => ({ kind: "move", from: s.to, to: s.from })),
    cancelled: false,
    errors: [],
  }));
  useUI.getState().setClipHistoryOpen(true);
  await settle();
  item("Move: report.pdf").click();
  await settle();
  expect(useUI.getState().confirm?.confirmLabel).toBe("Undo");
  useUI.getState().confirm?.onConfirm();
  await settle();
  const after = useHistory.getState();
  expect(after.undo.map((e) => e.id)).toEqual([copied.id]);
  expect(after.redo.map((e) => e.id)).toEqual([moved.id]);
  expect(after.log.find((e) => e.id === moved.id)?.undone).toBe(true);
});

// A failed step that can still run stays, to run again.
test("a failed undo step stays in the history", async () => {
  const home = "/Users/me";
  const step = { kind: "move" as const, from: `${home}/a`, to: `${home}/d/a`, id: "1" };
  reply("item_ids", ({ paths }: { paths: string[] }) =>
    paths.map((p) => ({ [`${home}/a`]: "1", [`${home}/d`]: "d" })[p] ?? null)
  );
  reply("apply_steps", () => ({ inverse: [], cancelled: false, errors: ['"a": Permission denied'], failed: [step] }));
  useHistory.setState({ undo: [], redo: [], log: [] });
  const entry = useHistory.getState().record("Move", [step]);
  const done = undoFromLog(entry.id);
  await settle();
  useUI.getState().confirm?.onConfirm();
  await done;
  expect(useHistory.getState().undo).toMatchObject([{ id: entry.id, steps: [step] }]);
  useUI.getState().closeConfirm();
});
