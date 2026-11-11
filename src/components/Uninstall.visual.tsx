import { afterEach, beforeEach, expect, test } from "vitest";
import { FolderView } from "./FolderView";
import { reply } from "../test/tauri";
import { mount, settle } from "../test/mount";
import { useTabs } from "../stores/tabs";
import { useUI } from "../stores/ui";
import { useHistory } from "../stores/history";
import { useOptimistic } from "../stores/optimistic";
import { useDirectory } from "../hooks/useDirectory";
import { uninstallApps } from "../actions";
import type { FileEntry } from "../types";

const DIR = "/Applications";
const LOCATION = { kind: "path", path: DIR } as const;
const app = (name: string) =>
  ({
    name: `${name}.app`, path: `${DIR}/${name}.app`, isDir: true, isHidden: false, isSymlink: false, isPackage: true,
    size: 0, modifiedMs: 0, createdMs: 0, ext: "app",
  }) as FileEntry;
const APPS = Array.from({ length: 40 }, (_, i) => app(`App${String(i).padStart(2, "0")}`));

/** What the folder holds. `trash_paths` takes apps out of it, and each reload reads it. */
let disk: FileEntry[] = [];

/** The real listing path: `useDirectory` reloads when `refreshSoon` bumps the tick. */
function Listing() {
  const tick = useTabs((s) => s.refreshTick);
  const { entries, error, loading } = useDirectory(LOCATION, false, tick);
  return (
    <>
      <div data-drop="nav|trash" style={{ position: "fixed", top: 8, left: 8 }}>
        <span className="navicon" style={{ display: "block", width: 20, height: 20 }} />
      </div>
      <div className="pane" style={{ height: 300, width: 800, marginTop: 40 }}>
        <FolderView entries={entries} sortSource={entries} totalCount={entries.length} error={error} loading={loading} searchRoot={null} searchTruncated={false} />
      </div>
    </>
  );
}

const row = (path: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="row"]')].find((r) => r.textContent?.includes(path.split("/").pop()!.replace(/\.app$/, "")));
const top = (path: string) => row(path)?.getBoundingClientRect().top ?? NaN;

/** Confirms the uninstall of `path`, then records where `watch` is drawn on each frame until it rests. */
async function uninstallAndTrack(path: string, watch: string) {
  await uninstallApps([path]);
  const start = top(watch);
  useUI.getState().confirm!.onConfirm();
  await settle(0); // confirmedIds resolves first.
  const frames: number[] = [];
  const flew = !!document.querySelector("#flight-layer .flight");
  const until = performance.now() + 600;
  while (performance.now() < until) {
    frames.push(top(watch));
    await new Promise(requestAnimationFrame);
  }
  return { start, frames, flew };
}

/** Each frame moves on from the last in one direction, and no frame leaps. */
function expectGlide(start: number, frames: number[], end: number, rowH: number) {
  const dir = Math.sign(end - start);
  expect(dir).not.toBe(0);
  let last = start;
  for (const y of frames) {
    expect((y - last) * dir, `frames ${frames.map(Math.round).join(" ")}`).toBeGreaterThan(-0.5);
    expect(Math.abs(y - last), `frames ${frames.map(Math.round).join(" ")}`).toBeLessThan(rowH * 0.75);
    last = y;
  }
  expect(frames.at(-1)).toBeCloseTo(end, 0);
  // It did animate, rather than jump once.
  expect(new Set(frames.map(Math.round)).size).toBeGreaterThan(3);
}

let unmount = () => {};
beforeEach(() => {
  reply("app_leftovers", []);
  reply("item_ids", (a: { paths: string[] }) => a.paths.map(() => "id"));
  disk = APPS;
  reply("list_dir_stream", (a: { onBatch: { onmessage: (b: FileEntry[]) => void } }) => {
    a.onBatch.onmessage(disk);
    return disk.length;
  });
  reply("trash_paths", (a: { paths: string[] }) => {
    disk = disk.filter((e) => !a.paths.includes(e.path)).map((e) => ({ ...e }));
    return {
      inverse: a.paths.map((p) => ({ kind: "move", from: `/Users/me/.Trash/${p.split("/").pop()}`, to: p })),
      cancelled: false,
      errors: [],
    };
  });
  useTabs.getState().navigate(LOCATION);
});
afterEach(() => {
  unmount();
  document.getElementById("flight-layer")?.replaceChildren();
  useOptimistic.setState({ ops: {} });
  useUI.setState({ toasts: [], confirm: null });
});

test("the app flies to the Trash and the next one slides up without restarting when the listing reloads", async () => {
  ({ unmount } = await mount(<Listing />, 900));
  const [gone, next] = [APPS[2].path, APPS[3].path];
  const end = top(gone);
  const rowH = top(next) - end;
  const { start, frames, flew } = await uninstallAndTrack(gone, next);
  expect(flew).toBe(true);
  expectGlide(start, frames, end, rowH);
  expect(useHistory.getState().undo.at(-1)?.label).toBe("Uninstall");
  expect(useUI.getState().toasts.at(-1)?.message).toBe('Uninstalled "App02"');
});

test("at the bottom of the list, where scrolling is pulled back, the rows above slide down instead of jumping", async () => {
  ({ unmount } = await mount(<Listing />, 900));
  const scroller = document.querySelector<HTMLElement>(".content")!;
  scroller.scrollTop = scroller.scrollHeight;
  await settle();
  const [above, gone] = [APPS[37].path, APPS[39].path];
  const rowH = top(gone) - top(APPS[38].path);
  const end = top(above) + rowH;
  const { start, frames, flew } = await uninstallAndTrack(gone, above);
  expect(flew).toBe(true);
  expectGlide(start, frames, end, rowH);
});

test("an app the Trash refuses never flies, stays listed, and permanent deletion is asked first", async () => {
  reply("trash_paths", { inverse: [], cancelled: false, errors: ['"App01.app": You don’t have permission.'] });
  ({ unmount } = await mount(<Listing />, 900));
  const stuck = APPS[1].path;
  await uninstallApps([stuck]);
  useUI.getState().confirm!.onConfirm();
  await settle(100); // Shorter than any flight.
  expect(document.querySelector("#flight-layer .flight")).toBeNull();
  expect(row(stuck)).toBeTruthy();
  expect(useUI.getState().confirm?.title).toBe("Delete permanently?");
});
