import { openUrl } from "@tauri-apps/plugin-opener";
import { isTabClosing } from "./util/tabClose";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./ipc";
import {
  useTabs,
  baseName,
  findTab,
  joinName,
  openPanes,
  paneStore,
  parentOf,
  portableTab,
  type TabState,
} from "./stores/tabs";
import { uncut, useClipboard } from "./stores/clipboard";
import { topOf, useHistory, type HistoryEntry } from "./stores/history";
import { runJob } from "./jobs";
import { useSettings, type ThemePref } from "./stores/settings";
import { flushAppData, useAppData } from "./stores/appdata";
import { newEntry, renamedEntry, useOptimistic } from "./stores/optimistic";
import { clearPrefetch } from "./stores/prefetch";
import { useUI } from "./stores/ui";
import { currentTags, useTags, withTagAdded } from "./stores/tags";
import { appName, currentTerminals, type TerminalApp } from "./stores/terminals";
import type { AppInfo, FileEntry, Location, OpResult, Progress, Resolutions, ShareAnchor, Step, Tag } from "./types";
import { extOf, isFolder, isMarkdown, isPlainText, isViewerImage } from "./util/kinds";
import { formatSize } from "./util/format";
import { validateName } from "./util/names";
import { openImageFromListing, openPdfFromListing, openReaderFromListing } from "./viewerFlight";
import { capture, flyIn, flyTo, markFlying, shownIn, type Launch, type Place } from "./flight";

// What each pane lists, in display order; commands read the focused pane's.
const paneEntries: FileEntry[][] = [[], []];
export function setViewEntries(pane: number, entries: FileEntry[]) {
  paneEntries[pane] = entries;
}
export function getViewEntries(): FileEntry[] {
  return paneEntries[useTabs.getState().pane];
}
/** What `pane` lists, focused or not. */
export function getPaneEntries(pane: number): FileEntry[] {
  return paneEntries[pane] ?? [];
}

/**
 * Refresh asked for by hand (F5, the menu): also calls a pending cut off,
 * as Explorer does, so what was cut comes back to full.
 */
export function refreshByUser() {
  uncut();
  refreshSoon();
}

let bumpTimer: ReturnType<typeof setTimeout> | null = null;
export function refreshSoon() {
  if (bumpTimer) clearTimeout(bumpTimer);
  // Both halves of a split may show the folder that changed.
  bumpTimer = setTimeout(() => openPanes().forEach((p) => p.bumpRefresh()), 120);
}

function activeTab(): TabState | undefined {
  const s = useTabs.getState();
  return s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0];
}

export function showError(err: unknown) {
  console.error(err);
  useUI.getState().pushToast(String(err), undefined, "error");
}

function labelForCount(paths: string[]): string {
  if (paths.length === 1) {
    const name = baseName(paths[0]);
    return `"${name}"`;
  }
  return `these ${paths.length} items`;
}

function tagErrors(errors: string[]) {
  if (errors.length > 0) showError(`Couldn't change tags of ${errors.join(", ")}`);
}

/** Puts `tag` on every item in `entries`, or takes it off all of them. */
export function setTag(entries: FileEntry[], tag: Tag, on: boolean) {
  if (entries.length === 0) return;
  const key = tag.name.toLowerCase();
  const before: [string, Tag[]][] = entries.map((e) => [e.path, currentTags(e)]);
  useTags.getState().beginEdit();
  // Shown at once; the backend's answer then replaces it.
  useTags.getState().put(
    before.map(([path, tags]) => [
      path,
      on ? withTagAdded(tags, tag) : tags.filter((t) => t.name.toLowerCase() !== key),
    ])
  );
  api
    .editTags(
      entries.map((e) => e.path),
      on ? tag : null,
      on ? null : tag.name
    )
    .then((res) => {
      useTags.getState().put(Object.entries(res.tags));
      tagErrors(res.errors);
    })
    .catch((err) => {
      useTags.getState().put(before);
      showError(err);
    })
    .finally(() => useTags.getState().noteEdit());
}

/** Takes every tag off each item in `entries`. */
export async function clearTags(entries: FileEntry[]) {
  const before: [string, Tag[]][] = entries.map((e) => [e.path, currentTags(e)]);
  const names = [...new Set(before.flatMap(([, tags]) => tags.map((t) => t.name)))];
  if (names.length === 0) return;
  useTags.getState().beginEdit();
  useTags.getState().put(before.map(([path]) => [path, []]));
  const paths = entries.map((e) => e.path);
  try {
    const errors = new Set<string>();
    let last: Record<string, Tag[]> = {};
    for (const name of names) {
      const res = await api.editTags(paths, null, name);
      res.errors.forEach((e) => errors.add(e));
      last = res.tags;
    }
    // Each answer has the tags left after that one removal; the last is final.
    useTags.getState().put(Object.entries(last));
    tagErrors([...errors]);
  } catch (err) {
    useTags.getState().put(before);
    showError(err);
  } finally {
    useTags.getState().noteEdit();
  }
}

export function navigateTo(loc: Location) {
  useTabs.getState().navigate(loc);
}

export async function appsFor(path: string): Promise<AppInfo[]> {
  const timeout = new Promise<AppInfo[]>((r) => setTimeout(() => r([]), 250));
  return Promise.race([api.openWithApps(path).catch(() => []), timeout]);
}

/** The Rust side's answer when opening would run a program it wasn't told the user had confirmed. */
const NEEDS_RUN_CONFIRMATION = "needs-run-confirmation";

/**
 * Opens `paths` in `app`. Handing files to a terminal or a code launcher runs
 * them, so the Rust side refuses that until the user has confirmed it here.
 */
async function openWithConfirmed(paths: string[], app: string) {
  try {
    await api.openWith(paths, app);
  } catch (err) {
    if (String(err) !== NEEDS_RUN_CONFIRMATION) throw err;
    const what = paths.length === 1 ? paths[0] : `${paths.length} items`;
    if (await confirmRun(what)) await api.openWith(paths, app, true);
  }
}

export function openWith(paths: string[], app: string) {
  openWithConfirmed(paths, app).catch(showError);
}

export async function openWithOther(paths: string[]) {
  try {
    const app = await api.pickApplication();
    if (app) await openWithConfirmed(paths, app);
  } catch (err) {
    showError(err);
  }
}

export function openEntry(entry: FileEntry) {
  if (entry.isAlias) {
    void openAlias(entry);
    return;
  }
  if (isFolder(entry)) {
    useTabs.getState().navigate({ kind: "path", path: entry.path });
    return;
  }
  openFile(entry.path);
}

/** The listing's images in `path`'s folder, in the order shown, when `path` is one of them. */
function viewerOrder(path: string): string[] | null {
  const dir = parentOf(path);
  const order = getViewEntries()
    .filter((e) => !e.isDir && isViewerImage(e.ext) && parentOf(e.path) === dir)
    .map((e) => e.path);
  return order.includes(path) ? order : null;
}

/** Asks before opening a file that runs as a program. Resolves true to go ahead. */
function confirmRun(path: string): Promise<boolean> {
  return new Promise((resolve) =>
    useUI.getState().openConfirm({
      title: `Run "${baseName(path)}"?`,
      message:
        "Opening this file runs it as a program, with access to your files. Only run it if you trust where it came from.",
      confirmLabel: "Run",
      danger: true,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    })
  );
}

/**
 * Images open in Doftar's viewer; Markdown, text and code in its reader;
 * PDFs in its PDF viewer; archives extract in place; anything else in its
 * default app, after asking when that would run it. Resolves whether the
 * file was opened in a way worth remembering in Recent.
 */
async function launch(path: string): Promise<boolean> {
  if (extractsOnOpen(path)) {
    await extractArchive(path);
    return false;
  }
  if (isViewerImage(extOf(path))) {
    await openImageFromListing(path, viewerOrder(path));
    return true;
  }
  const ext = extOf(path);
  if (ext === "pdf") {
    await openPdfFromListing(path);
    return true;
  }
  // A text extension can belong to a binary format too (.ts video).
  if (
    isMarkdown(ext) ||
    (isPlainText(ext) && (await api.isTextFile(path).catch(() => false)))
  ) {
    await openReaderFromListing(path);
    return true;
  }
  // The Rust side makes the same check and refuses without `allowRun`, so a
  // request that skips this prompt still can't start a program.
  const runs = await api.runsAsProgram(path).catch(() => false);
  if (runs && !(await confirmRun(path))) return false;
  await api.openPath(path, runs);
  return true;
}

/** Opens a file (not a folder) and remembers it in Recent. */
export function openFile(path: string) {
  api
    .pathExists(path)
    .catch(() => true)
    .then(async (exists) => {
      if (!exists) return missingFile(path);
      if (await launch(path)) useAppData.getState().addRecent(path);
    })
    .catch(showError);
}

/** Explains a file that is gone (moved or deleted since it was listed or opened). */
function missingFile(path: string) {
  const inRecent = useAppData.getState().recents.some((r) => r.path === path);
  useUI.getState().pushToast(
    `Couldn't find "${baseName(path)}". It may have been moved or deleted.`,
    inRecent
      ? { label: "Remove from Recent", onClick: () => useAppData.getState().removeRecent(path) }
      : undefined,
    "error"
  );
}

/** Follows an alias: a folder opens here, anything else in its app. */
async function openAlias(entry: FileEntry) {
  try {
    const target = await api.resolveAlias(entry.path);
    if (target.isDir) {
      useTabs.getState().navigate({ kind: "path", path: target.path });
      return;
    }
    if (await launch(target.path)) useAppData.getState().addRecent(entry.path);
  } catch (err) {
    showError(err);
  }
}

function reportErrors(errors: string[], prefix = "") {
  if (errors.length === 0) return;
  const shown = errors.slice(0, 3).join("; ");
  showError(
    prefix + (errors.length > 3 ? `${shown}; and ${errors.length - 3} more` : shown)
  );
}

export function cutSelection() {
  const tab = activeTab();
  if (!tab || tab.selection.length === 0) return;
  useClipboard.getState().cut([...tab.selection]).catch(showError);
}

export function copySelection() {
  const tab = activeTab();
  if (!tab || tab.selection.length === 0) return;
  useClipboard.getState().copy([...tab.selection]).catch(showError);
}

/** Every path a list of steps touches. */
function stepPaths(steps: Step[]): string[] {
  return steps.flatMap((s) => (s.kind === "trash" ? [s.path] : [s.from, s.to]));
}

/**
 * Shows what an operation did in the listings right away: it looks at the
 * paths involved, adds or updates the rows that now exist and removes the
 * ones that don't. The next reload confirms it. Looking at the result rather
 * than predicting it keeps this right for replacements, partial runs and undo.
 */
async function reflectPaths(paths: string[]) {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return;
  const found = await api.statEntries(unique).catch(() => null);
  if (!found) return;
  const showHidden = useSettings.getState().showHidden;
  const present = new Map(found.map((e) => [e.path, e]));
  const gone = new Map<string, string[]>();
  const optimistic = useOptimistic.getState();
  for (const p of unique) {
    const dir = parentOf(p);
    if (dir === null) continue;
    const entry = present.get(p);
    if (!entry) gone.set(dir, [...(gone.get(dir) ?? []), p]);
    else if (showHidden || !entry.isHidden) optimistic.push(dir, { kind: "put", entry });
  }
  for (const [dir, ps] of gone) optimistic.push(dir, { kind: "remove", paths: ps });
}

type Transfer = "copy" | "move" | "drop";

async function askConflicts(paths: string[], dest: string): Promise<Resolutions | null> {
  const conflicts = await api.findConflicts(paths, dest).catch(() => []);
  if (conflicts.length === 0) return {};
  return new Promise((resolve) =>
    useUI.getState().openConflicts({ conflicts, resolve })
  );
}

/** Where the pasted `paths` end up in `dest`, as far as `inverse` says. */
function arrived(inverse: Step[], dest: string): string[] {
  return inverse.flatMap((st) =>
    st.kind === "move" && parentOf(st.from) === dest
      ? [st.from]
      : st.kind === "trash" && parentOf(st.path) === dest
        ? [st.path]
        : []
  );
}

export async function transfer(
  kind: Transfer,
  paths: string[],
  dest: string,
  forceCopy = false
): Promise<OpResult | null> {
  const resolutions = await askConflicts(paths, dest);
  if (!resolutions) return null;
  let moved = 0;
  if (kind === "move") moved = paths.length;
  else if (kind === "drop" && !forceCopy) {
    const plan = await api.dropPlan(paths, dest).catch(() => []);
    moved = plan.filter(Boolean).length;
  }
  const mixed = moved > 0 && moved < paths.length;
  const moves = moved === paths.length;
  const verb = mixed ? "Transferring" : moves ? "Moving" : "Copying";
  const what = paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} items`;
  const title = `${verb} ${what} to "${baseName(dest) || "/"}"`;
  // Pasted items simply appear in their rows, with no motion; a drop's
  // ghost shrinks into its target by itself (see `absorb`).
  if (kind !== "drop") markFlying(paths.map((p) => joinName(dest, baseName(p))));
  try {
    const res = await runJob(title, (id, on) =>
      kind === "copy"
        ? api.copyPaths(paths, dest, resolutions, id, on)
        : kind === "move"
          ? api.movePaths(paths, dest, resolutions, id, on)
          : api.transferPaths(paths, dest, forceCopy, resolutions, id, on)
    );
    reportErrors(res.errors);
    if (kind !== "drop") markFlying(arrived(res.inverse, dest));
    void reflectPaths(stepPaths(res.inverse));
    const label = mixed ? "Transfer" : moves ? "Move" : "Copy";
    const entry = res.inverse.length
      ? useHistory.getState().record(label, res.inverse)
      : undefined;
    if (res.cancelled) {
      // Replacing an item adds a second inverse step that restores the old
      // one, so count only the steps that undo an arrival in `dest`.
      const done = res.inverse.filter(
        (s) => s.kind === "trash" || (s.kind === "move" && parentOf(s.from) === dest)
      ).length;
      useUI.getState().pushToast(
        `${label} cancelled${done ? ` after ${done} of ${paths.length} items` : ""}`,
        entry ? { label: "Undo", onClick: () => undoEntry(entry) } : undefined
      );
    }
    return res;
  } catch (err) {
    showError(err);
    return null;
  } finally {
    refreshSoon();
  }
}

export async function paste(asMove = false) {
  const tab = activeTab();
  if (!tab || tab.location.kind !== "path") return;
  const dest = tab.location.path;
  let board;
  try {
    board = await api.clipboardReadFiles();
  } catch (err) {
    showError(err);
    return;
  }
  if (board.paths.length === 0) return;
  const clip = useClipboard.getState();
  const cut = asMove || (clip.cutAt !== null && clip.cutAt === board.changeCount);
  if (cut && board.paths.every((p) => parentOf(p) === dest)) {
    // Nothing would move, so keep the cut for pasting somewhere else.
    useUI.getState().pushToast(
      board.paths.length === 1 ? "It's already in this folder" : "They're already in this folder"
    );
    return;
  }
  const res = await transfer(cut ? "move" : "copy", board.paths, dest);
  if (cut && res && !res.cancelled && res.errors.length === 0) {
    const now = await api.clipboardChangeCount().catch(() => -1);
    if (now === board.changeCount) await api.clipboardClear().catch(() => {});
    void useClipboard.getState().sync();
  }
}

const VOLUME_TRASH = /^\/Volumes\/[^/]+\/\.Trashes\/\d+(?:\/|$)/;

export function openFullDiskAccessSettings() {
  openUrl("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles").catch(
    showError
  );
}

export function isInTrash(path: string | null | undefined): boolean {
  if (!path) return false;
  const trash = `${useAppData.getState().home}/.Trash`;
  return path === trash || path.startsWith(trash + "/") || VOLUME_TRASH.test(path);
}

export function isTrashDir(path: string | null | undefined): boolean {
  if (!path) return false;
  if (path === `${useAppData.getState().home}/.Trash`) return true;
  const m = VOLUME_TRASH.exec(path);
  return m !== null && m[0].replace(/\/$/, "") === path;
}

function openFolder(): string | null {
  const tab = activeTab();
  return tab && tab.location.kind === "path" ? tab.location.path : null;
}

export function deleteSelection(permanent: boolean) {
  const tab = activeTab();
  if (!tab || tab.selection.length === 0) return;
  const paths = [...tab.selection];
  if (!permanent && isInTrash(openFolder())) permanent = true;
  if (!permanent) {
    trashNow(paths);
    return;
  }
  const label = labelForCount(paths);
  useUI.getState().openConfirm({
    title: "Delete permanently?",
    message: `Are you sure you want to permanently delete ${label}? This can't be undone.`,
    confirmLabel: "Delete",
    danger: true,
    onConfirm: () => void deleteNow(paths),
  });
}

/** True for app bundles inside an Applications folder (the Apps page and its subfolders). */
export function isInstalledApp(entry: FileEntry): boolean {
  return (
    entry.isDir &&
    entry.ext === "app" &&
    /(^|\/)Applications(\/|$)/.test(parentOf(entry.path) ?? "")
  );
}

const DENIED = /permission|not permitted|denied|operation not permitted|read-only/i;

/**
 * Uninstalling deletes the app permanently. Related files the app left in the
 * user's Library are offered too, and an app that needs administrator rights
 * (installed by an installer, owned by root) is removed after macOS asks the
 * user to authenticate.
 */
export async function uninstallApps(paths: string[]) {
  const what =
    paths.length === 1 ? `"${baseName(paths[0]).replace(/\.app$/, "")}"` : `${paths.length} apps`;
  const found = await Promise.all(paths.map((p) => api.appLeftovers(p).catch(() => [])));
  const leftovers = [...new Map(found.flat().map((l) => [l.path, l])).values()];
  const leftoverBytes = leftovers.reduce((n, l) => n + l.bytes, 0);
  const base = `Are you sure you want to uninstall ${what}? The app is deleted permanently and this can't be undone.`;
  const names = leftovers.map((l) => l.path.replace(/^.*\/Library\//, "~/Library/"));
  const shown = names.slice(0, 6).map((n) => `\u2022 ${n}`).join("\n");
  const more = names.length > 6 ? `\nand ${names.length - 6} more` : "";
  useUI.getState().openConfirm({
    title: "Uninstall?",
    message:
      leftovers.length > 0
        ? `${base}\n\nIt also left ${leftovers.length} related item${leftovers.length === 1 ? "" : "s"} in your Library (${formatSize(leftoverBytes)}):\n${shown}${more}`
        : base,
    confirmLabel: leftovers.length > 0 ? "Uninstall and remove leftovers" : "Uninstall",
    danger: true,
    alt:
      leftovers.length > 0
        ? { label: "Uninstall app only", onSelect: () => void uninstallNow(paths, []) }
        : undefined,
    onConfirm: () => void uninstallNow(paths, leftovers.map((l) => l.path)),
  });
}

async function uninstallNow(apps: string[], leftovers: string[]) {
  const what = apps.length === 1 ? `"${baseName(apps[0]).replace(/\.app$/, "")}"` : `${apps.length} apps`;
  try {
    const res = await runJob(`Uninstalling ${what}`, (id, on) => api.deletePermanently(apps, id, on));
    let exists = await Promise.all(apps.map((p) => api.pathExists(p).catch(() => true)));
    let remaining = apps.filter((_, i) => exists[i]);
    if (remaining.length > 0 && !res.cancelled && res.errors.some((e) => DENIED.test(e))) {
      try {
        await api.deleteAppsWithAdmin(remaining);
      } catch (err) {
        if (String(err) !== "cancelled") showError(err);
      }
      exists = await Promise.all(remaining.map((p) => api.pathExists(p).catch(() => true)));
      remaining = remaining.filter((_, i) => exists[i]);
    } else {
      reportErrors(res.errors);
    }
    const removed = apps.filter((p) => !remaining.includes(p));
    hidePaths(removed);
    void reflectPaths(removed);
    useAppData.getState().removePaths(removed);
    useTabs.getState().setSelection([]);
    if (removed.length > 0 && leftovers.length > 0) {
      const left = await runJob("Removing leftover files", (id, on) =>
        api.deletePermanently(leftovers, id, on)
      );
      reportErrors(left.errors, "Some leftovers couldn't be removed: ");
    }
    if (removed.length > 0) {
      useUI.getState().pushToast(
        `Uninstalled ${removed.length === 1 ? `"${baseName(removed[0]).replace(/\.app$/, "")}"` : `${removed.length} apps`}`
      );
    }
  } catch (err) {
    showError(err);
  } finally {
    refreshSoon();
  }
}

// Formats macOS's own tools open (see TAR_SUFFIXES in archive.rs).
const EXTRACTABLE = /\.(zip|tar|tgz|tbz2|txz|tar\.(gz|bz2|xz)|7z|rar|iso|cab|xar|cpio|lzh|lha)$/i;

/** Archives Doftar can extract: .zip and the common tar flavours. */
export function isExtractable(entry: FileEntry): boolean {
  return !entry.isDir && EXTRACTABLE.test(entry.name);
}

/**
 * Archives that opening extracts in place, like Extract Here, instead of
 * handing them to Archive Utility (which then shows the result in Finder).
 * Disk images still open in macOS, which mounts them.
 */
function extractsOnOpen(path: string): boolean {
  return EXTRACTABLE.test(path) && !/\.iso$/i.test(path);
}

function describe(paths: string[]): string {
  return paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} items`;
}

/** Runs an archive job; the created item is selected and the action is undoable. */
async function archiveJob(
  title: string,
  historyLabel: string,
  run: (id: number, on: (p: Progress) => void) => Promise<OpResult>
) {
  try {
    const res = await runJob(title, run);
    reportErrors(res.errors);
    const created = res.inverse.flatMap((s) => (s.kind === "trash" ? [s.path] : []));
    void reflectPaths(created);
    if (created.length > 0) {
      const entry = useHistory.getState().record(historyLabel, res.inverse);
      const folder = parentOf(created[0]);
      const tab = activeTab();
      if (tab?.location.kind === "path" && tab.location.path === folder) {
        useTabs.getState().setSelection(created, created[0]);
      }
      useUI.getState().pushToast(`Created "${baseName(created[0])}"`, {
        label: "Undo",
        onClick: () => undoEntry(entry),
      });
    }
    if (res.cancelled) useUI.getState().pushToast(`${historyLabel} cancelled`);
  } catch (err) {
    showError(err);
  } finally {
    refreshSoon();
  }
}

/** Zips `paths` into `Name.zip` (or `Archive.zip`) beside the first item. */
export function compressItems(paths: string[]) {
  if (paths.length === 0) return Promise.resolve();
  return archiveJob(`Compressing ${describe(paths)}`, "Compress", (id, on) =>
    api.compressPaths(paths, id, on)
  );
}

export function extractArchive(path: string) {
  return archiveJob(`Extracting ${describe([path])}`, "Extract", (id, on) =>
    api.extractArchive(path, id, on)
  );
}

export function compressSelection() {
  const tab = activeTab();
  if (tab && tab.selection.length > 0) void compressItems([...tab.selection]);
}

export function extractSelection() {
  const tab = activeTab();
  if (!tab) return;
  const chosen = new Set(tab.selection);
  getViewEntries()
    .filter((e) => chosen.has(e.path) && isExtractable(e))
    .forEach((e) => void extractArchive(e.path));
}

export async function deleteNow(paths: string[]) {
  const what = paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} items`;
  try {
    const res = await runJob(`Deleting ${what}`, (id, on) =>
      api.deletePermanently(paths, id, on)
    );
    reportErrors(res.errors);
    // A cancelled or partly failed delete leaves some paths in place; only
    // forget favorites/recents for the ones that are really gone.
    const exists = await Promise.all(paths.map((p) => api.pathExists(p).catch(() => true)));
    const removed = paths.filter((_, i) => !exists[i]);
    hidePaths(removed);
    useAppData.getState().removePaths(removed);
    useTabs.getState().setSelection([]);
    if (res.cancelled) {
      useUI.getState().pushToast("Delete cancelled");
    }
  } catch (err) {
    showError(err);
  } finally {
    refreshSoon();
  }
}

/** Hides `paths` from their folders' listings until a reload confirms they are gone. */
function hidePaths(paths: string[]): number[] {
  const byDir = new Map<string, string[]>();
  for (const p of paths) {
    const dir = parentOf(p);
    if (dir === null) continue;
    byDir.set(dir, [...(byDir.get(dir) ?? []), p]);
  }
  return [...byDir].map(([dir, ps]) =>
    useOptimistic.getState().push(dir, { kind: "remove", paths: ps })
  );
}

/**
 * Moves `paths` to the Trash at once, their icons flying there unless
 * `fly` is false (a drop on the Trash, whose drag ghost goes there itself).
 */
export function trashNow(paths: string[], { fly = true } = {}): Promise<void> {
  if (fly) flyTo(paths, { kind: "trash" });
  const hidden = hidePaths(paths);
  return api
    .trashPaths(paths)
    .then((res) => {
      const gone = res.errors.length
        ? res.inverse.flatMap((s) => (s.kind === "move" ? [s.to] : []))
        : paths;
      // Re-assert now that it's done: a reload that started while the trash was
      // still running could have dropped the early hide. Items that stayed
      // (errors) come back.
      useOptimistic.getState().revert(hidden);
      hidePaths(gone);
      useAppData.getState().removePaths(gone);
      useTabs.getState().setSelection([]);
      refreshSoon();
      reportErrors(res.errors);
      if (res.inverse.length === 0) return;
      useAppData.getState().recordTrashOrigins(
        res.inverse.flatMap((s) => (s.kind === "move" ? [{ trashed: s.from, origin: s.to }] : []))
      );
      const entry = useHistory.getState().record("Move to Trash", res.inverse);
      useUI.getState().pushToast(`Moved ${labelForCount(gone)} to the Trash`, {
        label: "Undo",
        onClick: () => undoEntry(entry),
      });
    })
    .catch((err) => {
      useOptimistic.getState().revert(hidden);
      showError(err);
    });
}

export function emptyTrash() {
  useUI.getState().openConfirm({
    title: "Empty the Trash?",
    message: "All items in the Trash will be permanently deleted. This can't be undone.",
    confirmLabel: "Empty Trash",
    danger: true,
    onConfirm: () => {
      api
        .emptyTrash()
        .then((n) => {
          const data = useAppData.getState();
          data.forgetTrashOrigins(Object.keys(data.trashOrigins));
          useUI.getState().pushToast(n === 1 ? "Deleted 1 item" : `Deleted ${n} items`);
          useTabs.getState().setSelection([]);
        })
        .catch(showError)
        .finally(refreshSoon);
    },
  });
}

function askConfirm(spec: { title: string; message: string; confirmLabel: string }) {
  return new Promise<boolean>((resolve) =>
    useUI.getState().openConfirm({
      ...spec,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    })
  );
}

export async function putBack(paths: string[]) {
  const appdata = useAppData.getState();
  const known = paths.filter((p) => appdata.trashOrigins[p]);
  const unknown = paths.filter((p) => !appdata.trashOrigins[p]);
  const steps: Step[] = known.map((p) => ({
    kind: "move",
    from: p,
    to: appdata.trashOrigins[p],
  }));

  const missing = [
    ...new Set(
      (
        await Promise.all(
          steps.map(async (s) => {
            const dir = s.kind === "move" ? parentOf(s.to) : null;
            return dir && !(await api.pathExists(dir).catch(() => true)) ? dir : null;
          })
        )
      ).filter((d): d is string => d !== null)
    ),
  ];
  if (missing.length > 0) {
    const names = missing.map((d) => `"${baseName(d)}"`).join(", ");
    const go = await askConfirm({
      title: "Recreate original folder?",
      message: `The original ${missing.length === 1 ? "folder" : "folders"} ${names} no longer exist. Recreate and put the items back?`,
      confirmLabel: "Recreate",
    });
    if (!go) return;
    try {
      for (const d of missing) await api.ensureDir(d);
    } catch (err) {
      showError(err);
      return;
    }
  }

  try {
    if (steps.length > 0) {
      const res = await runJob("Putting back items", (id, on) => api.applySteps(steps, id, on));
      reportErrors(res.errors);
      const moved = res.inverse.flatMap((s) => (s.kind === "move" ? [s] : []));
      const restored = moved.map((s) => s.from);
      // The inverse of a put-back moves the item from its origin back into the
      // Trash, so `to` is the Trash path the origin map is keyed by.
      appdata.forgetTrashOrigins(moved.map((s) => s.to));
      void reflectPaths(stepPaths(res.inverse));
      if (res.inverse.length > 0) {
        const entry = useHistory.getState().record("Put Back", res.inverse);
        useUI.getState().pushToast(
          `Put back ${restored.length === 1 ? `"${baseName(restored[0])}"` : `${restored.length} items`}`,
          { label: "Undo", onClick: () => undoEntry(entry) }
        );
      }
    }
    if (unknown.length > 0) await api.putBackFinder(unknown);
    useTabs.getState().setSelection([]);
  } catch (err) {
    showError(err);
  } finally {
    refreshSoon();
  }
}

export function putBackSelection() {
  const tab = activeTab();
  if (tab && tab.selection.length > 0) void putBack([...tab.selection]);
}

export function ejectVolume(path: string, name: string) {
  openPanes().forEach((p) => p.leave(path));
  api
    .ejectVolume(path)
    .then(() => useUI.getState().pushToast(`Ejected "${name}"`))
    .catch((err) => showError(`Couldn't eject "${name}": ${String(err)}`));
}

function undoEntry(entry: HistoryEntry) {
  if (topOf(useHistory.getState().undo) === entry) void undoLast();
}

function reselect(steps: Step[]) {
  const tab = activeTab();
  if (!tab || tab.location.kind !== "path") return;
  const folder = tab.location.path;
  const paths = steps
    .flatMap((s) => (s.kind === "trash" ? [] : [s.to]))
    .filter((p) => parentOf(p) === folder);
  if (paths.length > 0) useTabs.getState().setSelection(paths, paths[0]);
}

/**
 * Starts what `steps` take away flying where it goes, and returns what they
 * bring into a listing on screen with where each flies in from: its icon
 * if it shows now, else the Trash or folder it comes out of.
 */
function launchSteps(steps: Step[]): { path: string; from: Launch | Place }[] {
  const shot = capture(steps.map((s) => (s.kind === "trash" ? s.path : s.from)));
  const into: { path: string; from: Launch | Place }[] = [];
  const away = new Map<string, { place: Place; leaving: boolean; paths: string[] }>();
  const send = (path: string, place: Place, leaving: boolean) => {
    const key = JSON.stringify([place, leaving]);
    const group = away.get(key) ?? { place, leaving, paths: [] };
    group.paths.push(path);
    away.set(key, group);
  };
  for (const s of steps) {
    if (s.kind === "trash") {
      send(s.path, { kind: "trash" }, true);
      continue;
    }
    const fromDir = parentOf(s.from);
    const toDir = parentOf(s.to);
    // A rename stays in its row.
    if (!fromDir || !toDir || fromDir === toDir) continue;
    const place: Place = isInTrash(s.to) ? { kind: "trash" } : { kind: "path", path: toDir };
    if (shownIn(toDir)) {
      const launch = shot.get(s.from);
      const source: Place = isInTrash(s.from) ? { kind: "trash" } : { kind: "path", path: fromDir };
      into.push({ path: s.to, from: launch ?? source });
      if (launch && s.kind === "move") markFlying([s.from]);
    } else if (shot.has(s.from)) {
      send(s.from, place, s.kind === "move");
    }
  }
  for (const g of away.values()) flyTo(g.paths, g.place, g.leaving);
  markFlying(into.map((i) => i.path));
  return into;
}

async function travel(dir: "undo" | "redo") {
  const history = useHistory.getState();
  if (history.busy) return;
  const entry = topOf(dir === "undo" ? history.undo : history.redo);
  if (!entry) return;
  history.setBusy(true);
  try {
    const arriving = launchSteps(entry.steps);
    const res = await runJob(
      `${dir === "undo" ? "Undoing" : "Redoing"} ${entry.label}`,
      (id, on) => api.applySteps(entry.steps, id, on)
    );
    reportErrors(res.errors, `Couldn't ${dir} ${entry.label}: `);
    flyIn(arriving);
    useHistory.getState().settle(dir, entry, res.inverse);
    void reflectPaths([...stepPaths(entry.steps), ...stepPaths(res.inverse)]);
    reselect(entry.steps);
  } catch (err) {
    showError(err);
    useHistory.getState().discard(dir, entry);
  } finally {
    useHistory.getState().setBusy(false);
    refreshSoon();
  }
}

export function undoLast() {
  return travel("undo");
}

export function redoLast() {
  return travel("redo");
}

export function startRename() {
  const tab = activeTab();
  if (!tab || tab.selection.length !== 1) return;
  useTabs.getState().setRenaming(tab.selection[0]);
}

export function commitRename(
  from: string,
  newName: string,
  opts: { keepOpen?: boolean } = {}
): string | null {
  const trimmed = newName.trim();
  // An emptied box cancels; one holding only spaces is a name to correct.
  if ((trimmed || newName) && trimmed !== from.split("/").pop()) {
    const invalid = validateName(trimmed);
    if (invalid) {
      if (opts.keepOpen) return invalid;
      useTabs.getState().setRenaming(null);
      showError(invalid);
      return invalid;
    }
  }
  useTabs.getState().setRenaming(null);
  if (!trimmed || trimmed === from.split("/").pop()) return null;
  const parent = parentOf(from);
  if (parent === null) return null;
  const to = joinName(parent, trimmed);
  // Show the new name at once; put the old one back if the rename fails.
  const old = getViewEntries().find((e) => e.path === from);
  const opId = old
    ? useOptimistic.getState().push(parent, {
        kind: "rename",
        from,
        entry: renamedEntry(old, to),
      })
    : null;
  const tabs = useTabs.getState();
  const tab = tabs.tabs.find((t) => t.id === tabs.activeId);
  if (tab?.selection.includes(from)) {
    tabs.setSelection(tab.selection.map((p) => (p === from ? to : p)), tab.anchor === from ? to : tab.anchor);
  }
  api
    .renamePath(from, to)
    .then(() => {
      useHistory.getState().record("Rename", [{ kind: "move", from: to, to: from }]);
      if (old && opId !== null) {
        // Re-assert now that it's done, in case a reload that started during
        // the rename dropped the early change.
        useOptimistic.getState().revert([opId]);
        useOptimistic.getState().push(parent, { kind: "rename", from, entry: renamedEntry(old, to) });
      }
      refreshSoon();
    })
    .catch((err) => {
      if (opId !== null) useOptimistic.getState().revert([opId]);
      showError(err);
    });
  return null;
}

function created(label: string, p: string, isDir: boolean) {
  useHistory.getState().record(label, [{ kind: "trash", path: p }]);
  const dir = parentOf(p);
  if (dir !== null) useOptimistic.getState().push(dir, { kind: "add", entry: newEntry(p, isDir) });
  refreshSoon();
  useTabs.getState().setRenaming(p);
}

export function newFolder() {
  const tab = activeTab();
  if (!tab || tab.location.kind !== "path") return;
  api
    .createDir(tab.location.path)
    .then((p) => created("New Folder", p, true))
    .catch(showError);
}

export function newFile() {
  const tab = activeTab();
  if (!tab || tab.location.kind !== "path") return;
  api
    .createFile(tab.location.path)
    .then((p) => created("New Text Document", p, false))
    .catch(showError);
}

export function quickLookPaths(paths: string[]) {
  if (paths.length === 0) return;
  api.quicklook(paths).catch(() => {});
}

export function quickLookSelection() {
  quickLookPaths(activeTab()?.selection ?? []);
}

export function selectAll() {
  useTabs.getState().setSelection(getViewEntries().map((e) => e.path), null);
}

export function toggleFavoriteEntry(entry: FileEntry) {
  useAppData.getState().toggleFavorite({
    path: entry.path,
    name: entry.name,
    dirName: parentOf(entry.path) ?? "/",
    modifiedMs: entry.modifiedMs,
    isDir: isFolder(entry),
  });
}

/**
 * Moves tab `id` into a window of its own with its top-left at `at` (screen
 * points), or a little down and right of this window.
 */
export async function moveTabToNewWindow(id: number, at?: { x: number; y: number }) {
  const found = findTab(id);
  if (!found) return;
  const { store, tab } = found;
  // A split half may give up its only tab; the other half stays.
  if (liveTabs(store.tabs) < 2 && openPanes().length < 2) return;
  let pos = at;
  if (!pos) {
    const win = getCurrentWindow();
    const scale = await win.scaleFactor();
    const p = (await win.outerPosition()).toLogical(scale);
    pos = { x: p.x + 32, y: p.y + 32 };
  }
  // The new window reads favorites and recents from disk.
  await flushAppData();
  try {
    await api.openTabWindow(portableTab(tab), pos.x, pos.y);
  } catch (err) {
    showError(err);
    return;
  }
  paneStore(store.pane).getState().closeTab(id);
}

/** How many of `tabs` aren't winding down a close. */
const liveTabs = (tabs: { id: number }[]) => tabs.filter((t) => !isTabClosing(t.id)).length;

/**
 * Removes tab `id` after another window has taken it. A window left with no
 * tabs goes away: tab windows close, the main window hides as it does on ⌘⇧W.
 */
export function releaseMovedTab(id: number) {
  const found = findTab(id);
  if (!found) return;
  const alone = openPanes().length === 1 && liveTabs(found.store.tabs) === 1;
  found.store.closeTab(id);
  const win = getCurrentWindow();
  if (alone && win.label === "main") void win.hide();
}

/** Shows the macOS share menu (AirDrop, Mail, Messages...) next to `anchor`. */
export function shareItems(paths: string[], anchor: ShareAnchor | Element) {
  if (paths.length === 0) return;
  const rect =
    anchor instanceof Element
      ? (({ x, y, width, height }) => ({ x, y, width, height }))(anchor.getBoundingClientRect())
      : anchor;
  api.sharePaths(paths, rect).catch(showError);
}

export function copyAsPath(paths?: string[]) {
  const list = paths ?? activeTab()?.selection ?? [];
  if (list.length === 0) return;
  void copyText(list.join("\n")).then((ok) => {
    if (ok) {
      useUI.getState().pushToast(list.length === 1 ? "Copied path" : `Copied ${list.length} paths`);
    }
  });
}

export function propertiesForSelection() {
  const tab = activeTab();
  if (!tab || tab.selection.length === 0) return;
  const chosen = new Set(tab.selection);
  const entries = getViewEntries().filter((e) => chosen.has(e.path));
  if (entries.length > 0) useUI.getState().openProperties(entries);
}

export function openEntryProperties(entry: FileEntry) {
  useUI.getState().openProperties(entry);
}

/**
 * Opens `path` in `app`, or in the default terminal. Picking a terminal by
 * name makes it the default for next time.
 */
export function openInTerminal(path: string, app?: TerminalApp) {
  const chosen = app ?? currentTerminals().def;
  api
    .openTerminal(path, chosen?.path ?? null)
    .then(() => {
      if (app) useSettings.getState().set({ terminalApp: app.path });
    })
    .catch(showError);
}

/**
 * Runs `command` in the default terminal, in `dir`: what the address bar does
 * with a word that isn't a folder. A terminal that can't be handed a command
 * (Zentty, or one added by hand) opens in the folder with the command on the
 * clipboard, ready to paste.
 */
export function runInTerminal(dir: string, command: string) {
  const chosen = currentTerminals().def;
  api
    .runInTerminal(dir, command, chosen?.path ?? null)
    .then(({ ran, reason }) => {
      if (ran) return;
      void copyText(command);
      const who = chosen?.name ?? "The terminal";
      useUI
        .getState()
        .pushToast(
          `${who} opened in the folder; “${command}” is on the clipboard, paste it to run.${
            reason ? ` (${reason})` : ""
          }`
        );
    })
    .catch(showError);
}

/** Picks any app to open `path` in, and keeps it in the terminal list. */
export async function openInOtherTerminal(path: string) {
  const app = await api.pickApplication().catch(() => null);
  if (!app) return;
  const s = useSettings.getState();
  if (!currentTerminals().list.some((t) => t.path === app)) {
    s.set({ terminalExtras: [...s.terminalExtras, app] });
  }
  openInTerminal(path, { name: appName(app), path: app });
}

/** ⌥⌘T: the one selected folder, else the open folder, else the home folder. */
export function openTerminalHere() {
  const tab = activeTab();
  if (!tab) return;
  const one = tab.selection.length === 1 ? getViewEntries().find((e) => e.path === tab.selection[0]) : undefined;
  const dir =
    one && isFolder(one)
      ? one.path
      : tab.location.kind === "path"
        ? tab.location.path
        : useAppData.getState().home;
  openInTerminal(dir);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    void useClipboard.getState().sync();
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function folderEntryForPath(path: string): FileEntry {
  const name = baseName(path);
  return {
    name,
    path,
    isDir: true,
    isHidden: false,
    isSymlink: false,
    isPackage: false,
    size: 0,
    modifiedMs: 0,
    createdMs: 0,
    ext: "",
  };
}

/** Deletes Doftar's cached thumbnails (and the in-memory caches built on them). */
export async function clearAppCache() {
  try {
    const freed = await api.clearCache();
    clearPrefetch();
    const { clearThumbnailMemory } = await import("./components/FileIcon");
    clearThumbnailMemory();
    useUI.getState().pushToast(
      freed.files === 0 ? "The cache was already empty" : `Cleared ${formatSize(freed.bytes)} of cache`
    );
  } catch (err) {
    showError(err);
  }
}

export function setTheme(theme: ThemePref) {
  useSettings.getState().set({ theme });
}
