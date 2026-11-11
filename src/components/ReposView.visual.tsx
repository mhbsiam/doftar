import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { ReposView } from "./ReposView";
import { reply } from "../test/tauri";
import { mount, SPLIT, WIDE } from "../test/mount";
import type { GitRepo } from "../types";

const day = 86_400;
const t0 = Date.UTC(2026, 9, 26) / 1000;
reply("git_repos", [
  { path: "/Users/me/Documents/New project", branch: "main", localOnly: true, lastCommit: null },
  { path: "/Users/me/Documents/GitHub/manuscript", branch: "master", localOnly: true, lastCommit: t0 - 3 * day },
  { path: "/Users/me/Documents/GitHub/doftar", branch: "main", localOnly: false, lastCommit: t0 },
  { path: "/Users/me/Documents/LabWork/backup/cafe_local", branch: "version-2", localOnly: false, lastCommit: t0 - 90 * day },
] satisfies GitRepo[]);

let unmount = () => {};
afterEach(() => unmount());

test.each([
  ["wide", WIDE],
  ["split", SPLIT],
])("Git page rows stay on one line when %s", async (name, width) => {
  ({ unmount } = await mount(<ReposView />, width));
  const rows = [...document.querySelectorAll<HTMLElement>(".repos-page .filerow")];
  expect(rows.length).toBe(5);
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    for (const cell of row.children) {
      const r = cell.getBoundingClientRect();
      if (r.height > 0) expect(r.bottom).toBeLessThanOrEqual(box.bottom + 0.5);
    }
  }
  await expect.element(page.elementLocator(document.querySelector(".repos-page")!)).toMatchScreenshot(`git-${name}`);
});
