import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { isTabClosing } from "./util/tabClose";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./ipc";
import {
  useTabs,
  baseName,
  findTab,
  isSplitAnimating,
  joinName,
  openPanes,
  paneStore,
  parentOf,
  portableTab,
  previewStore,
  usePanes,
  type TabState,
} from "./stores/tabs";
import { isPendingCut, uncut, useClipboard, type ClipEntry } from "./stores/clipboard";
import { staleSteps, stepEnds, topOf, undoQuestion, useHistory, type HistoryEntry } from "./stores/history";
import { runJob } from "./jobs";
import { nameMatcher } from "./util/itemFilter";
import { DEFAULT_PREVIEW_REM, sameSearch, useSettings, type SavedSearch, type ThemePref } from "./stores/settings";
import { resolveTheme } from "./hooks/useResolvedTheme";
import { runReveal } from "./util/transition";
import { markRenamed } from "./hooks/useRowMotion";
import type { FolderColorId } from "./util/folderColors";
import { flushAppData, inCloudDrive, originOf, useAppData } from "./stores/appdata";
import { newEntry, renamedEntry, useOptimistic } from "./stores/optimistic";
import { clearPrefetch } from "./stores/prefetch";
import { useUI } from "./stores/ui";
import { currentTags, useTags, withTagAdded } from "./stores/tags";
import { appName, currentEditors, currentTerminals, appCommand, type TerminalApp } from "./stores/terminals";
import type { AppInfo, FileEntry, Location, OpResult, Progress, Resolutions, ShareAnchor, Step, Tag, TrashStep } from "./types";
import { extOf, isDataFile, isFolder, isMarkdown, isPlainText, isPlayableAudio, isPlayableVideo, isViewerImage } from "./util/kinds";
import { formatSize, normalizePath } from "./util/format";
import { shotListCsv } from "./util/shotList";
import { isMedia } from "./stores/media";
import { validateName } from "./util/names";
import { runRenames } from "./util/batchRename";
import { missingOrNewer } from "./util/compareFolders";
import {
  openImageFromListing,
  openPdfFromListing,
  openReaderFromListing,
  openVideoFromListing,
} from "./viewerFlight";
import { capture, flyIn, flyTo, markFlying, shownIn, type Launch, type Place } from "./flight";

// Commands read the focused pane's entries.
const paneEntries: FileEntry[][] = [[], []];
// True when a pane lists its whole folder: loaded and not filtered.
const paneWhole = [false, false];
export function setViewEntries(pane: number, entries: FileEntry[], whole = false) {
  paneEntries[pane] = entries;
  paneWhole[pane] = whole;
  if (whole) syncPreview(pane, entries);
}

function syncPreview(pane: number, entries: FileEntry[]) {
  const s = paneStore(pane).getState();
  const { preview: shown, setPreview } = previewStore().getState();
  const tab = s.tabs.find((t) => t.id === s.activeId);
  if (!shown || tab?.location.kind !== "path" || tab.location.path !== parentOf(shown.path)) return;
  const now = entries.find((e) => e.path === shown.path) ?? null;
  if (now?.modifiedMs !== shown.modifiedMs || now.size !== shown.size) setPreview(now);
}
export function getViewEntries(): FileEntry[] {
  return paneEntries[useTabs.getState().pane];
}
export function getPaneEntries(pane: number): FileEntry[] {
  return paneEntries[pane] ?? [];
}

/** Also cancels a pending cut, as Explorer does. */
export function refreshByUser() {
  uncut();
  refreshSoon();
}

let bumpTimer: ReturnType<typeof setTimeout> | null = null;
export function refreshSoon() {
  if (bumpTimer) clearTimeout(bumpTimer);
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

/** Shows at most six names, then a count of the rest. */
function bulleted(names: string[]): string {
  const shown = names.slice(0, 6).map((n) => `\u2022 ${n}`).join("\n");
  return names.length > 6 ? `${shown}\nand ${names.length - 6} more` : shown;
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

export function setTag(entries: FileEntry[], tag: Tag, on: boolean) {
  if (entries.length === 0) return;
  const key = tag.name.toLowerCase();
  const before: [string, Tag[]][] = entries.map((e) => [e.path, currentTags(e)]);
  useTags.getState().beginEdit();
  // Show at once. The backend answer replaces it.
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

export async function clearTags(entries: FileEntry[]) {
  const before: [string, Tag[]][] = entries.map((e) => [e.path, currentTags(e)]);
  const names = [...new Set(before.flatMap(([, tags]) => tags.map((t) => t.name)))];
  if (names.length === 0) return;
  useTags.getState().beginEdit();
  useTags.getState().put(before.map(([path]) => [path, []]));
  const paths = entries.map((e) => e.path);
  let last: Record<string, Tag[]> | null = null;
  try {
    const errors = new Set<string>();
    for (const name of names) {
      const res = await api.editTags(paths, null, name);
      res.errors.forEach((e) => errors.add(e));
      last = res.tags;
    }
    // Each answer has the tags left after that removal. The last answer is final.
    useTags.getState().put(Object.entries(last ?? {}));
    tagErrors([...errors]);
  } catch (err) {
    // Removals that went through stay done.
    useTags.getState().put(last ? Object.entries(last) : before);
    showError(err);
  } finally {
    useTags.getState().noteEdit();
  }
}

export function navigateTo(loc: Location) {
  useTabs.getState().navigate(loc);
}

export function runSavedSearch(s: SavedSearch) {
  useSettings.getState().set({ searchContents: s.contents });
  useTabs.getState().searchIn(s.root, s.query);
}

export function toggleSavedSearch(s: SavedSearch) {
  const list = useSettings.getState().savedSearches;
  const has = list.some((x) => sameSearch(x, s));
  useSettings.getState().set({ savedSearches: has ? list.filter((x) => !sameSearch(x, s)) : [...list, s] });
  if (!has) useUI.getState().pushToast("Search saved in the sidebar");
}

export async function appsFor(path: string): Promise<AppInfo[]> {
  const timeout = new Promise<AppInfo[]>((r) => setTimeout(() => r([]), 250));
  return Promise.race([api.openWithApps(path).catch(() => []), timeout]);
}

/** Rust refuses to run a program until the user confirms. */
const NEEDS_RUN_CONFIRMATION = "needs-run-confirmation";

/** Terminals and code launchers run the files. Rust refuses until the user confirms here. */
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

const fetching = new Set<string>();

/** Downloads an online-only cloud file first. The viewers cannot show it otherwise. */
async function afterDownload(entry: FileEntry, next: () => void) {
  if (!entry.isDataless) return next();
  if (fetching.has(entry.path)) return;
  fetching.add(entry.path);
  const drive = inCloudDrive([entry.path], useAppData.getState().cloudDrives)?.drive.name;
  useUI.getState().pushToast(`Downloading "${entry.name}"${drive ? ` from ${drive}` : ""}…`);
  try {
    await api.downloadFile(entry.path);
    next();
  } catch (err) {
    showError(err);
  } finally {
    fetching.delete(entry.path);
  }
}

export function openEntry(entry: FileEntry) {
  if (entry.isDataless) return void afterDownload(entry, () => openEntry({ ...entry, isDataless: false }));
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

/** With the preview bar open, a file shows there. Folders and all other cases open as `openEntry` does. */
export function activateEntry(entry: FileEntry) {
  const { previewOpen, setPreview } = previewStore().getState();
  if (!previewOpen || isFolder(entry)) return openEntry(entry);
  if (entry.isAlias) return void previewAlias(entry, paneStore(usePanes.getState().focused));
  if (entry.isDataless) {
    return void afterDownload(entry, () => previewStore().getState().setPreview({ ...entry, isDataless: false }));
  }
  setPreview(entry);
}

async function previewAlias(entry: FileEntry, store: ReturnType<typeof paneStore>) {
  try {
    const target = await api.resolveAlias(entry.path);
    if (target.isDir) {
      store.getState().navigate({ kind: "path", path: target.path });
      return;
    }
    const [resolved] = await api.statEntries([target.path]);
    previewStore().getState().setPreview(resolved ?? entry);
  } catch (err) {
    showError(err);
  }
}

export function togglePreview() {
  const { previewOpen, setPreviewOpen } = previewStore().getState();
  if (!previewOpen) {
    useUI.getState().closeFolderTree();
    // A dragged width lasts until the bar closes. It always opens at the default.
    useSettings.getState().set({ previewWidth: DEFAULT_PREVIEW_REM });
  }
  setPreviewOpen(!previewOpen);
}

/** The files beside `path` in the view, in view order, that `fits` takes. */
function viewerOrder(path: string, fits: (e: FileEntry) => boolean = (e) => isViewerImage(e.ext)): string[] | null {
  const dir = parentOf(path);
  const order = getViewEntries()
    .filter((e) => !e.isDir && fits(e) && parentOf(e.path) === dir)
    .map((e) => e.path);
  return order.includes(path) ? order : null;
}

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

/** Resolves true if the file opened in a way that Recent should remember. */
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
  if (isPlayableVideo(ext)) {
    await openVideoFromListing(path);
    return true;
  }
  // Cloud-only tracks stay out of the playlist. The player reads them without the backend's check.
  if (isPlayableAudio(ext)) {
    await openVideoFromListing(path, viewerOrder(path, (e) => isPlayableAudio(e.ext) && !e.isDataless));
    return true;
  }
  // A text extension can be a binary format too (.ts video).
  if (
    isMarkdown(ext) ||
    isDataFile(ext) ||
    (isPlainText(ext) && (await api.isTextFile(path).catch(() => false)))
  ) {
    await openReaderFromListing(path);
    return true;
  }
  // Rust makes the same check and refuses without `allowRun`.
  const runs = await api.runsAsProgram(path).catch(() => false);
  if (runs && !(await confirmRun(path))) return false;
  await api.openPath(path, runs);
  return true;
}

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

/** Go to a typed absolute or `~` path: a folder opens, a file is shown in its folder. */
/** A typed path as an absolute one: `~` is the home folder, and a relative path starts at `cwd`. */
export function typedPath(raw: string, cwd?: string): string {
  const home = useAppData.getState().home;
  const text = raw.trim();
  const full =
    text === "~" ? home : text.startsWith("~/") ? joinName(home, text.slice(2)) : cwd && !text.startsWith("/") ? joinName(cwd, text) : text;
  return normalizePath(full);
}

/** Opens what `open -a Doftar`, the Dock icon or the Finder service handed over: a folder in a new tab, anything else shown in its folder. */
export function openHanded() {
  api
    .takeOpened()
    .then(async (items) => {
      for (const { path, reveal } of items ?? []) {
        // The disk root has no folder to be shown in.
        const folder = parentOf(path) === null || (!reveal && (await api.isFolder(path)));
        useTabs.getState().newTab(folder ? { kind: "path", path } : undefined);
        if (!folder) useTabs.getState().reveal(path);
      }
    })
    .catch(showError);
}

export function goToTypedPath(raw: string) {
  const target = typedPath(raw);
  Promise.all([api.isFolder(target), api.pathExists(target)])
    .then(([folder, exists]) => {
      if (folder) useTabs.getState().navigate({ kind: "path", path: target });
      else if (exists) useTabs.getState().reveal(target);
      else showError(`Can't find “${target}”. Check the spelling and try again.`);
    })
    .catch(showError);
}

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

function stepPaths(steps: Step[]): string[] {
  return steps.flatMap((s) => (s.kind === "trash" ? [s.path] : [s.from, s.to]));
}

/** Reads the real paths, not a prediction. This stays right for replacements, partial runs and undo. */
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
  // Pasted items appear with no motion. A drop ghost shrinks by itself (see `absorb`).
  // Use only names known now. A duplicate arrives renamed.
  const sameName = paths.filter(
    (p) => parentOf(p) !== dest && (resolutions[p] ?? "replace") === "replace"
  );
  if (kind !== "drop") markFlying(sameName.map((p) => joinName(dest, baseName(p))));
  const verify = useSettings.getState().verifyCopies;
  try {
    const res = await runJob(title, (id, on) =>
      kind === "copy"
        ? api.copyPaths(paths, dest, resolutions, verify, id, on)
        : kind === "move"
          ? api.movePaths(paths, dest, resolutions, verify, id, on)
          : api.transferPaths(paths, dest, forceCopy, resolutions, verify, id, on),
      true,
      dest
    );
    reportErrors(res.errors);
    if (kind !== "drop") markFlying(arrived(res.inverse, dest));
    void reflectPaths(stepPaths(res.inverse));
    const label = mixed ? "Transfer" : moves ? "Move" : "Copy";
    // A replace adds a second inverse step that restores the old item.
    // Count only the steps that undo an arrival in `dest`.
    const done = res.inverse.filter(
      (s) => s.kind === "trash" || (s.kind === "move" && parentOf(s.from) === dest)
    ).length;
    // If some never arrived, the steps alone show which did.
    const entry = res.inverse.length
      ? useHistory.getState().record(label, res.inverse, done === paths.length ? paths : undefined)
      : undefined;
    if (res.cancelled) {
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
  if (board.paths.length === 0) {
    // No files: an image or text on the clipboard becomes a file here.
    const d = new Date();
    const two = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} at ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;
    await api
      .clipboardPasteData(dest, stamp)
      .then((undo) => undo && created("Paste", undo, false))
      .catch(showError);
    return;
  }
  const clip = useClipboard.getState();
  const cut = asMove || (clip.cutAt !== null && clip.cutAt === board.changeCount);
  if (cut && board.paths.every((p) => parentOf(p) === dest)) {
    // Nothing moves, so keep the cut for pasting elsewhere.
    useUI.getState().pushToast(
      board.paths.length === 1 ? "It's already in this folder" : "They're already in this folder"
    );
    return;
  }
  const res = await transfer(cut ? "move" : "copy", board.paths, dest);
  // Keep the cut while any original stayed put: skipped, failed or cancelled.
  const movedFrom = res?.inverse.flatMap((st) => (st.kind === "move" ? [st.to] : [])) ?? [];
  if (cut && res && board.paths.every((p) => movedFrom.includes(p) || parentOf(p) === dest)) {
    const now = await api.clipboardChangeCount().catch(() => -1);
    if (now === board.changeCount) await api.clipboardClear().catch(() => {});
    // These paths are gone, so the history cannot paste them.
    useClipboard.getState().forget(board.paths);
    void useClipboard.getState().sync();
  }
}

/** A copy, or a move if the clip is still the pending cut. */
export async function pasteFromHistory(entry: ClipEntry) {
  if (isPendingCut(entry)) return paste();
  const dest = openFolder();
  if (dest) await transfer("copy", entry.paths, dest);
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
    confirmTrash(paths, () => void trashNow(paths));
    return;
  }
  const label = labelForCount(paths);
  const listed = paths.length > 1 ? `\n\n${bulleted(paths.map(baseName))}` : "";
  const cloud = inCloudDrive(paths, useAppData.getState().cloudDrives);
  const synced = cloud
    ? ` It's also deleted from ${cloud.drive.name} on all your devices, though ${cloud.drive.name}'s own trash on the web may keep it for a while.`
    : "";
  const ids = confirmedIds(paths);
  useUI.getState().openConfirm({
    title: "Delete permanently?",
    message: `Are you sure you want to permanently delete ${label}? This can't be undone.${synced}${listed}`,
    confirmLabel: "Delete",
    danger: true,
    onConfirm: () => void ids.then((ids) => deleteChecked(paths, ids)),
  });
}

// shortcut: counts only the selected items, not folder contents. Walk them if a big folder slips through.
const MANY_TO_TRASH = 100;

/** Asks first for paths in a cloud drive, where trashing deletes on every synced device, or for very many paths. */
export function confirmTrash(paths: string[], go: () => void) {
  const cloud = inCloudDrive(paths, useAppData.getState().cloudDrives);
  if (cloud) {
    const name = cloud.drive.name;
    const where = paths.length === 1 ? `"${baseName(paths[0])}" is` : `Some of these ${paths.length} items are`;
    useUI.getState().openConfirm({
      title: `Delete from ${name}?`,
      message: `${where} in ${name}, so moving them to the Trash also deletes them from ${name} on all your devices. ${name} keeps deleted items in its own trash on the web for a limited time.`,
      confirmLabel: "Move to Trash",
      danger: true,
      onConfirm: go,
    });
    return;
  }
  if (paths.length < MANY_TO_TRASH) return go();
  useUI.getState().openConfirm({
    title: `Move ${paths.length} items to the Trash?`,
    message: bulleted(paths.map(baseName)),
    confirmLabel: "Move to Trash",
    danger: true,
    onConfirm: go,
  });
}

/** Reads the items at `paths` now. The delete skips any item that another item replaced meanwhile. */
export function confirmedIds(paths: string[]): Promise<(string | null)[] | undefined> {
  return api.itemIds(paths).catch(() => undefined);
}

/** Asks once more if a path is a Git repository or its `.git` folder. The history goes with it. */
async function deleteChecked(paths: string[], ids?: (string | null)[]) {
  const isRepo = await Promise.all(
    paths.map((p) =>
      baseName(p) === ".git" || api.pathExists(joinName(p, ".git")).catch(() => false)
    )
  );
  // shortcut: finds only a repository at the top of a selected folder. Add a walk if nested ones matter.
  const repos = paths.filter((_, i) => isRepo[i]);
  if (repos.length === 0) return deleteNow(paths, ids);
  const one = repos.length === 1;
  useUI.getState().openConfirm({
    title: one ? "Delete a Git repository?" : "Delete Git repositories?",
    message: `${labelForCount(repos)} ${one ? "is a Git repository" : "are Git repositories"}. The commit history is deleted with it and can't be recovered.`,
    confirmLabel: "Delete anyway",
    danger: true,
    onConfirm: () => void deleteNow(paths, ids),
  });
}

/** True for app bundles in an Applications folder, including subfolders. */
export function isInstalledApp(entry: FileEntry): boolean {
  return (
    entry.isDir &&
    entry.ext === "app" &&
    /(^|\/)Applications(\/|$)/.test(parentOf(entry.path) ?? "")
  );
}

const DENIED = /permission|not permitted|denied|operation not permitted|read-only/i;

/**
 * Offers the related Library files too.
 */
export async function uninstallApps(paths: string[]) {
  const what = appLabel(paths);
  const found = await Promise.all(paths.map((p) => api.appLeftovers(p).catch(() => [])));
  const leftovers = [...new Map(found.flat().map((l) => [l.path, l])).values()];
  const leftoverBytes = leftovers.reduce((n, l) => n + l.bytes, 0);
  const base = `Are you sure you want to uninstall ${what}? ${paths.length === 1 ? "The app moves" : "The apps move"} to the Trash.`;
  const listed = bulleted(leftovers.map((l) => l.path.replace(/^.*\/Library\//, "~/Library/")));
  const asked = [...paths, ...leftovers.map((l) => l.path)];
  const ids = confirmedIds(asked).then((ids) => ids && new Map(asked.map((p, i) => [p, ids[i]])));
  useUI.getState().openConfirm({
    title: "Uninstall?",
    message:
      leftovers.length > 0
        ? `${base}\n\nIt also left ${leftovers.length} related item${leftovers.length === 1 ? "" : "s"} in your Library (${formatSize(leftoverBytes)}), which can go to the Trash too:\n${listed}`
        : base,
    confirmLabel: leftovers.length > 0 ? "Uninstall and remove leftovers" : "Uninstall",
    danger: true,
    alt:
      leftovers.length > 0
        ? { label: "Uninstall app only", onSelect: () => void ids.then((ids) => uninstallNow(paths, [], ids)) }
        : undefined,
    onConfirm: () =>
      void ids.then((ids) => uninstallNow(paths, found.map((ls) => ls.map((l) => l.path)), ids)),
  });
}

const appLabel = (apps: string[]) =>
  apps.length === 1 ? `"${baseName(apps[0]).replace(/\.app$/, "")}"` : `${apps.length} apps`;

/** The leftovers to remove once `remaining` stayed. No installed app may still claim one. */
function leftoversToRemove(apps: string[], leftovers: string[][], remaining: string[]): string[] {
  const kept = new Set(apps.flatMap((p, i) => (remaining.includes(p) ? (leftovers[i] ?? []) : [])));
  return [...new Set(leftovers.flat())].filter((l) => !kept.has(l));
}

/**
 * Moves the apps to the Trash and their leftovers after them. Only an app the Trash took flies there.
 * Permanent deletion is offered for one it refused. `leftovers[i]` belong to `apps[i]`. `ids` come from `confirmedIds`.
 */
async function uninstallNow(apps: string[], leftovers: string[][], ids?: Map<string, string | null>) {
  try {
    const res = await api.trashPaths(apps);
    const gone = trashedFrom(apps, res);
    const remaining = apps.filter((p) => !gone.includes(p));
    if (gone.length > 0) flyTo(gone, { kind: "trash" });
    dropGone(gone);
    const away = leftoversToRemove(apps, leftovers, remaining);
    // shortcut: a leftover on a volume with no Trash stays where it is. Offer deletion if home folders on shares matter.
    const left = away.length > 0 ? await api.trashPaths(away) : null;
    if (left) reportErrors(left.errors, "Some leftovers couldn't be removed: ");
    if (gone.length > 0) {
      const steps = [...res.inverse, ...(left?.inverse ?? [])];
      useAppData.getState().recordTrashOrigins(
        steps.flatMap((s) => (s.kind === "move" ? [{ trashed: s.from, origin: s.to, id: s.id }] : []))
      );
      const entry = useHistory.getState().record("Uninstall", steps);
      useUI.getState().pushToast(`Uninstalled ${appLabel(gone)}`, {
        label: "Undo",
        onClick: () => undoEntry(entry),
      });
    }
    if (remaining.length > 0 && (res.noTrash?.length || res.errors.some((e) => DENIED.test(e)))) {
      useUI.getState().openConfirm({
        title: "Delete permanently?",
        message: `${appLabel(remaining)} can't be moved to the Trash. Delete permanently instead? macOS may ask for your password. This can't be undone.`,
        confirmLabel: "Delete",
        danger: true,
        onConfirm: () =>
          void deleteAppsNow(remaining, remaining.map((p) => leftovers[apps.indexOf(p)] ?? []), ids),
      });
    } else {
      reportErrors(res.errors);
    }
  } catch (err) {
    showError(err);
  } finally {
    refreshSoon();
  }
}

/** For apps the Trash refused. One that needs administrator rights is removed after macOS asks the user to authenticate. */
async function deleteAppsNow(apps: string[], leftovers: string[][], ids?: Map<string, string | null>) {
  const idsOf = (paths: string[]) => ids && paths.map((p) => ids.get(p) ?? null);
  const what = appLabel(apps);
  try {
    const res = await runJob(`Uninstalling ${what}`, (id, on) => api.deletePermanently(apps, id, on, idsOf(apps)));
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
    if (removed.length > 0) useHistory.getState().logOnly("Uninstall", removed);
    dropGone(removed);
    void reflectPaths(removed);
    const gone = leftoversToRemove(apps, leftovers, remaining);
    if (gone.length > 0) {
      const left = await runJob("Removing leftover files", (id, on) =>
        api.deletePermanently(gone, id, on, idsOf(gone))
      );
      reportErrors(left.errors, "Some leftovers couldn't be removed: ");
    }
    if (removed.length > 0) {
      useUI.getState().pushToast(`Uninstalled ${appLabel(removed)}`);
    }
  } catch (err) {
    showError(err);
  } finally {
    refreshSoon();
  }
}

// Formats macOS tools open. See TAR_SUFFIXES in archive.rs.
const EXTRACTABLE = /\.(zip|tar|tgz|tbz2|txz|tar\.(gz|bz2|xz)|7z|rar|iso|cab|xar|cpio|lzh|lha)$/i;

export function isExtractable(entry: FileEntry): boolean {
  return !entry.isDir && EXTRACTABLE.test(entry.name);
}

/** Opening these extracts in place, like Extract Here, not in Archive Utility. Disk images still open in macOS, which mounts them. */
function extractsOnOpen(path: string): boolean {
  return EXTRACTABLE.test(path) && !/\.iso$/i.test(path);
}

function describe(paths: string[]): string {
  return paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} items`;
}

async function archiveJob(
  title: string,
  historyLabel: string,
  sources: string[],
  run: (id: number, on: (p: Progress) => void) => Promise<OpResult>
) {
  try {
    const res = await runJob(title, run);
    reportErrors(res.errors);
    const created = res.inverse.flatMap((s) => (s.kind === "trash" ? [s.path] : []));
    void reflectPaths(created);
    if (created.length > 0) {
      // After an error, not all sources may be in it. The created item is enough.
      const entry = useHistory.getState().record(historyLabel, res.inverse, res.errors.length ? undefined : sources);
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

export function compressItems(paths: string[]) {
  if (paths.length === 0) return Promise.resolve();
  return archiveJob(`Compressing ${describe(paths)}`, "Compress", paths, (id, on) =>
    api.compressPaths(paths, id, on)
  );
}

export function extractArchive(path: string) {
  return archiveJob(`Extracting ${describe([path])}`, "Extract", [path], (id, on) =>
    api.extractArchive(path, id, on)
  );
}

export function compressSelection() {
  const tab = activeTab();
  if (tab && tab.selection.length > 0) void compressItems([...tab.selection]);
}

/** Uses the whole folder when nothing is selected. */
export async function exportShotList() {
  const tab = activeTab();
  if (!tab || tab.location.kind !== "path") return;
  const chosen = new Set(tab.selection);
  const entries = getViewEntries().filter((e) => isMedia(e) && (chosen.size === 0 || chosen.has(e.path)));
  if (entries.length === 0) {
    showError("No clips, photos or sounds to list here.");
    return;
  }
  try {
    const media = await api.mediaInfo(entries.map((e) => e.path));
    const path = await api.createTextFile(tab.location.path, "Shot list", ".csv", shotListCsv(entries, media));
    useTabs.getState().reveal(path);
  } catch (e) {
    showError(`Couldn't write the shot list: ${e}`);
  }
}

export function extractSelection() {
  const tab = activeTab();
  if (!tab) return;
  const chosen = new Set(tab.selection);
  getViewEntries()
    .filter((e) => chosen.has(e.path) && isExtractable(e))
    .forEach((e) => void extractArchive(e.path));
}

/** `ids` come from `confirmedIds`. An item replaced since the confirm is kept. */
export async function deleteNow(paths: string[], ids?: (string | null)[]) {
  const what = paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} items`;
  try {
    const res = await runJob(`Deleting ${what}`, (id, on) =>
      api.deletePermanently(paths, id, on, ids)
    );
    reportErrors(res.errors);
    // A cancelled or failed delete leaves paths in place.
    // Forget favorites and recents only for paths that are gone.
    const exists = await Promise.all(paths.map((p) => api.pathExists(p).catch(() => true)));
    const removed = paths.filter((_, i) => !exists[i]);
    if (removed.length > 0) useHistory.getState().logOnly("Delete Immediately", removed);
    dropGone(removed);
    if (res.cancelled) {
      useUI.getState().pushToast("Delete cancelled");
    }
  } catch (err) {
    showError(err);
  } finally {
    refreshSoon();
  }
}

/** Hides `paths` until a reload confirms they are gone. */
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

/** Hides `gone` from listings, forgets it in favorites and recents, and clears the selection. */
function dropGone(gone: string[]) {
  hidePaths(gone);
  useAppData.getState().removePaths(gone);
  useTabs.getState().setSelection([]);
}

/** The `paths` that left for the Trash. After an error or a refusal, only those that really moved. */
function trashedFrom(paths: string[], res: OpResult): string[] {
  return res.errors.length || res.noTrash?.length
    ? res.inverse.flatMap((s) => (s.kind === "move" ? [s.to] : []))
    : paths;
}

/** Set `fly` to false for a drop on the Trash. The drag ghost flies there. */
export function trashNow(paths: string[], { fly = true } = {}): Promise<void> {
  if (fly) flyTo(paths, { kind: "trash" });
  const hidden = hidePaths(paths);
  return api
    .trashPaths(paths)
    .then((res) => {
      const noTrash = res.noTrash ?? [];
      const gone = trashedFrom(paths, res);
      // Reset the early hide, then hide only the gone paths. A reload during the trash may have dropped the early hide.
      // Items that stayed after an error come back.
      useOptimistic.getState().revert(hidden);
      dropGone(gone);
      refreshSoon();
      reportErrors(res.errors);
      // Like Finder on a share: offer to delete what cannot go to the Trash.
      if (noTrash.length > 0) {
        const noTrashIds = confirmedIds(noTrash);
        useUI.getState().openConfirm({
          title: "Delete immediately?",
          message: `${labelForCount(noTrash)} can't be moved to the Trash because the server doesn't have one. Delete immediately? This can't be undone.`,
          confirmLabel: "Delete",
          danger: true,
          onConfirm: () => void noTrashIds.then((ids) => deleteChecked(noTrash, ids)),
        });
      }
      if (res.inverse.length === 0) return;
      useAppData.getState().recordTrashOrigins(
        res.inverse.flatMap((s) => (s.kind === "move" ? [{ trashed: s.from, origin: s.to, id: s.id }] : []))
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
          if (n > 0) useHistory.getState().logOnly("Empty Trash", []);
          data.forgetTrashOrigins(Object.keys(data.trashOrigins));
          useUI
            .getState()
            .pushToast(n === 0 ? "The Trash is already empty" : n === 1 ? "Deleted 1 item" : `Deleted ${n} items`);
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
  const ids = await api.itemIds(paths).catch(() => null);
  const origins = paths.map((p, i) => originOf(p, ids?.[i] ?? null, appdata.trashOrigins));
  const unknown = paths.filter((_, i) => !origins[i]);
  const steps: Step[] = paths.flatMap((p, i) => {
    const to = origins[i];
    return to ? [{ kind: "move" as const, from: p, to }] : [];
  });

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
      // The inverse of a put-back moves the item from its origin to the Trash.
      // `to` is the Trash path that keys the origin map.
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
    useTabs.getState().setSelection(unknown);
    if (unknown.length > 0) {
      const what = unknown.length === 1 ? `"${baseName(unknown[0])}" came` : `${unknown.length} items came`;
      const reveal = await askConfirm({
        title: "Original location unknown",
        message: `Doftar doesn't know where ${what} from. Finder's Put Back may still be able to restore ${unknown.length === 1 ? "it" : "them"}.`,
        confirmLabel: "Reveal in Finder",
      });
      if (reveal) revealInFinder(unknown);
    }
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
  // The toast names what it undoes, so no confirm is needed.
  if (topOf(useHistory.getState().undo)?.id === entry.id) void travel("undo");
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
 * Starts the icons that leave flying. Returns the items that arrive in a visible listing,
 * with where each flies from: its icon, else the Trash or source folder.
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

/** `pick` selects another entry. `only` limits the run to some of its steps. */
async function travel(dir: "undo" | "redo", pick?: HistoryEntry, only?: Step[]) {
  const history = useHistory.getState();
  if (history.busy) return;
  const entry = pick ?? topOf(dir === "undo" ? history.undo : history.redo);
  if (!entry) return;
  const steps = only ?? entry.steps;
  if (steps.length === 0) return;
  history.setBusy(getCurrentWindow().label);
  try {
    const arriving = launchSteps(steps);
    const res = await runJob(
      `${dir === "undo" ? "Undoing" : "Redoing"} ${entry.label}`,
      (id, on) => api.applySteps(steps, id, on)
    );
    reportErrors(res.errors, `Couldn't ${dir} ${entry.label}: `);
    flyIn(arriving);
    // A failed step stays for a retry, unless its target changed and it can never run.
    const failed = res.failed ?? [];
    const dead = failed.length ? await staleOf(failed) : [];
    const keep = failed.filter((s) => !dead.includes(s));
    useHistory.getState().settle(dir, entry, res.inverse, [...keep, ...(res.left ?? [])]);
    void reflectPaths([...stepPaths(steps), ...stepPaths(res.inverse)]);
    reselect(steps);
  } catch (err) {
    // Unknown what ran, so keep the entry. A new run finds the finished steps stale.
    showError(err);
  } finally {
    useHistory.getState().setBusy(null);
    refreshSoon();
  }
}

/** The newest entry can belong to another window. */
export async function undoLast() {
  const top = topOf(useHistory.getState().undo);
  if (top) await undoFromLog(top.id);
}

export function redoLast() {
  return travel("redo");
}

/** Steps of each live entry that can no longer run, by entry id. Uses one file-id lookup. */
export async function staleByEntry(entries: HistoryEntry[]): Promise<Map<number, Step[]>> {
  const paths = entries.flatMap((e) => stepEnds(e.steps));
  // Steps repeat paths, so look up each path once.
  const unique = [...new Set(paths)];
  const found = await api.itemIds(unique).catch(() => null);
  const idOf = found && new Map(unique.map((p, i) => [p, found[i]]));
  const out = new Map<number, Step[]>();
  let at = 0;
  for (const e of entries) {
    const n = 3 * e.steps.length;
    out.set(e.id, idOf ? staleSteps(e.steps, paths.slice(at, at + n).map((p) => idOf.get(p) ?? null)) : []);
    at += n;
  }
  return out;
}

const staleOf = async (steps: Step[]) =>
  (await staleByEntry([{ id: 0, label: "", steps, at: 0 }])).get(0) ?? [];

/** Undoes any activity log entry. Skips steps whose items changed since. */
export async function undoFromLog(id: number) {
  const live = () => useHistory.getState().undo.find((e) => e.id === id);
  const entry = live();
  if (!entry) return;
  const stale = await staleOf(entry.steps);
  if (stale.length === entry.steps.length) {
    useUI.getState().pushToast(`Can't undo ${entry.label}: its items have changed or moved since`);
    return;
  }
  const go = await askConfirm({
    title: `Undo ${entry.label}?`,
    message: [undoQuestion(entry.steps, stale, useAppData.getState().home), await grownSince(entry, stale)]
      .filter(Boolean)
      .join(" "),
    confirmLabel: "Undo",
  });
  const now = live();
  if (!go || !now) return;
  // The entry changed while the confirm was open. Its steps are new, so check them again.
  const skip = new Set(now === entry ? stale : await staleOf(now.steps));
  if (useHistory.getState().busy) {
    useUI.getState().pushToast("Another undo is still running; try again once it's done");
    return;
  }
  await travel("undo", now, now.steps.filter((s) => !skip.has(s)));
}

/**
 * Warns when undo trashes a made folder that gained or lost items since.
 * shortcut: a folder date changes only for its own entries, not deeper ones.
 * Finder's .DS_Store also changes it, so a needless warning is possible. Walk the folder if that matters.
 */
async function grownSince(entry: HistoryEntry, stale: Step[]): Promise<string> {
  const skip = new Set(stale);
  const made = entry.steps.flatMap((s) => (s.kind === "trash" && !skip.has(s) ? [s.path] : []));
  // Entries saved before times were kept have no time (0).
  if (!entry.at || made.length === 0) return "";
  const stats = await api.statEntries(made).catch(() => []);
  const grown = stats.filter((f) => f.isDir && f.modifiedMs > entry.at);
  if (grown.length === 0) return "";
  return grown.length === 1
    ? `"${grown[0].name}" has changed inside since, and everything in it goes to the Trash too.`
    : `${grown.length} folders have changed inside since, and everything in them goes to the Trash too.`;
}

export function startRename() {
  const tab = activeTab();
  if (!tab || tab.selection.length === 0) return;
  if (tab.selection.length === 1) {
    useTabs.getState().setRenaming(tab.selection[0]);
    return;
  }
  // For several items, use the batch rename dialog in the shown order.
  const chosen = new Set(tab.selection);
  const entries = getViewEntries().filter((e) => chosen.has(e.path));
  if (entries.length > 1) useUI.getState().openBatchRename(entries);
}

/** `names` match `entries` one to one, in order. One undo step. Each failure is reported at the end. */
export async function renameMany(entries: FileEntry[], names: string[]) {
  const jobs = entries.flatMap((e, i) => {
    const parent = parentOf(e.path);
    return names[i] === e.name || parent === null ? [] : [{ name: e.name, from: e.path, to: joinName(parent, names[i]) }];
  });
  const tag = Math.random().toString(36).slice(2, 8);
  const { steps, moved, errors } = await runRenames(jobs, api.renamePath, tag);
  if (steps.length > 0) useHistory.getState().record("Rename", steps);
  const tabs = useTabs.getState();
  const tab = tabs.tabs.find((t) => t.id === tabs.activeId);
  if (tab) {
    const map = (p: string) => moved.get(p) ?? p;
    tabs.setSelection(tab.selection.map(map), tab.anchor === null ? null : map(tab.anchor));
  }
  refreshSoon();
  if (errors.length > 0) reportErrors(errors);
}

let renameChecking: string | null = null;

function renamingNow(pane: number): string | null {
  const s = paneStore(pane).getState();
  return s.tabs.find((t) => t.id === s.activeId)?.renaming ?? null;
}

/** `pane` owns the rename box. Clicking the other pane moves focus there before the box's blur fires. */
export async function commitRename(
  pane: number,
  from: string,
  newName: string,
  opts: { keepOpen?: boolean } = {}
): Promise<string | null> {
  const store = paneStore(pane);
  // Enter and Escape close the box, and its unmount fires blur: that rename is already done or cancelled.
  if (renamingNow(pane) !== from || renameChecking === from) return null;
  // Untouched: keep a name with edge spaces (or "Icon\r") as it is.
  if (newName === from.split("/").pop()) {
    store.getState().setRenaming(null);
    return null;
  }
  const trimmed = newName.trim();
  const parent = parentOf(from);
  // An empty box cancels. A box with only spaces is a name to correct.
  if ((trimmed || newName) && trimmed !== from.split("/").pop()) {
    let invalid = validateName(trimmed);
    if (!invalid && parent !== null) {
      // Ask the disk: hidden and filtered items count, and so do other Unicode spellings of the name.
      renameChecking = from;
      const taken = await api.renameTaken(from, joinName(parent, trimmed)).catch(() => false);
      renameChecking = null;
      // Escape while the check ran.
      if (renamingNow(pane) !== from) return null;
      if (taken) invalid = `An item named "${trimmed}" already exists. Type a different name.`;
    }
    if (invalid) {
      if (opts.keepOpen) return invalid;
      store.getState().setRenaming(null);
      showError(invalid);
      return invalid;
    }
  }
  store.getState().setRenaming(null);
  if (!trimmed || trimmed === from.split("/").pop()) return null;
  if (parent === null) return null;
  const to = joinName(parent, trimmed);
  // Show the new name at once. Restore the old name if the rename fails.
  const old = getPaneEntries(pane).find((e) => e.path === from);
  markRenamed(to);
  const opId = old
    ? useOptimistic.getState().push(parent, {
        kind: "rename",
        from,
        entry: renamedEntry(old, to),
      })
    : null;
  const tabs = store.getState();
  const tab = tabs.tabs.find((t) => t.id === tabs.activeId);
  const follow = tab?.selection.includes(from) ?? false;
  if (tab && follow) {
    tabs.setSelection(tab.selection.map((p) => (p === from ? to : p)), tab.anchor === from ? to : tab.anchor);
  }
  api
    .renamePath(from, to)
    .then((undo) => {
      useHistory.getState().record("Rename", [undo]);
      if (old && opId !== null) {
        // Reapply the change after the rename ends. A reload during the rename may have dropped the early change.
        useOptimistic.getState().revert([opId]);
        useOptimistic.getState().push(parent, { kind: "rename", from, entry: renamedEntry(old, to) });
      }
      refreshSoon();
    })
    .catch((err) => {
      if (opId !== null) useOptimistic.getState().revert([opId]);
      const now = store.getState();
      const t = now.tabs.find((x) => x.id === tab?.id);
      if (follow && t && t.id === now.activeId && t.selection.includes(to)) {
        now.setSelection(t.selection.map((p) => (p === to ? from : p)), t.anchor === to ? from : t.anchor);
      }
      showError(err);
    });
  return null;
}

function created(label: string, undo: TrashStep, isDir: boolean) {
  const p = undo.path;
  useHistory.getState().record(label, [undo]);
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
    .then((undo) => created("New Folder", undo, true))
    .catch(showError);
}

export function newFile() {
  const tab = activeTab();
  if (!tab || tab.location.kind !== "path") return;
  api
    .createFile(tab.location.path)
    .then((undo) => created("New Text Document", undo, false))
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

/** Selects what is shown and not selected. The filter and search decide what is shown. */
export function invertSelection() {
  const chosen = new Set(activeTab()?.selection ?? []);
  useTabs.getState().setSelection(getViewEntries().filter((e) => !chosen.has(e.path)).map((e) => e.path), null);
}

/** Selects the shown items whose names match. See `nameMatcher` for the pattern. Returns how many. */
export function selectMatching(pattern: string): number {
  const test = nameMatcher(pattern);
  const paths = test ? getViewEntries().filter((e) => test(e.name)).map((e) => e.path) : [];
  useTabs.getState().setSelection(paths, null);
  return paths.length;
}

/** Makes a folder here and moves the selection into it. One Undo puts everything back. */
export async function newFolderWithSelection() {
  const tab = activeTab();
  if (!tab || tab.location.kind !== "path" || tab.selection.length === 0) return;
  const paths = [...tab.selection];
  let made: TrashStep | null = null;
  let moved: Step[] = [];
  try {
    made = await api.createDir(tab.location.path);
    const dir = made.path;
    const what = paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} items`;
    const res = await runJob(`Moving ${what} to a new folder`, (id, on) => api.movePaths(paths, dir, {}, false, id, on), true, dir);
    moved = res.inverse;
    reportErrors(res.errors);
    void reflectPaths([...stepPaths(moved), dir]);
    useTabs.getState().setSelection([dir], dir);
    useTabs.getState().setRenaming(dir);
  } catch (err) {
    showError(err);
  } finally {
    // Record even when the move failed, so the new folder can be undone.
    // Order matters: the moves go back first, then the folder goes to the Trash, empty.
    if (made) useHistory.getState().record("New Folder with Selection", [...moved, made], paths);
    refreshSoon();
  }
}

/** Opens the Move to… or Copy to… dialog for the selection. */
export function sendSelectionTo(mode: "move" | "copy") {
  const paths = activeTab()?.selection ?? [];
  if (paths.length > 0) useUI.getState().openSendTo([...paths], mode);
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

/** `at` is in screen points. The default is a little down and right of this window. */
export async function moveTabToNewWindow(id: number, at?: { x: number; y: number }) {
  // Moving the last tab of a half closes it, and split view can't close while it moves.
  if (isSplitAnimating()) return;
  const found = findTab(id);
  if (!found) return;
  const { store, tab } = found;
  // A split half may lose its only tab. The other half stays.
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
  paneStore(store.pane).getState().closeTab(id, true);
}

/** Opens a window with one tab at `at`, a little down and right of this one. */
export async function openNewWindow(at: Location = { kind: "home" }) {
  const win = getCurrentWindow();
  const scale = await win.scaleFactor();
  const p = (await win.outerPosition()).toLogical(scale);
  await flushAppData();
  const tab = { history: [at], historyIndex: 0, selection: [], anchor: null };
  await api.openTabWindow(tab, p.x + 32, p.y + 32).catch(showError);
}

/** Copies the selection into its own folder. Each copy gets a free "name_copy_N". */
export async function duplicateSelection(paths?: string[]) {
  const list = paths ?? activeTab()?.selection ?? [];
  // Search results mix folders, so copy each group into its own parent.
  const byDir = new Map<string, string[]>();
  for (const p of list) {
    const dir = parentOf(p);
    if (dir === null || isTrashDir(dir)) continue;
    byDir.set(dir, [...(byDir.get(dir) ?? []), p]);
  }
  for (const [dir, group] of byDir) await transfer("copy", group, dir);
}

export function revealInFinder(paths?: string[]) {
  const list = paths ?? activeTab()?.selection ?? [];
  if (list.length > 0) api.revealInFinder(list).catch(showError);
}

export function copyName(paths?: string[]) {
  const list = paths ?? activeTab()?.selection ?? [];
  if (list.length === 0) return;
  void copyText(list.map(baseName).join("\n")).then((ok) => {
    if (ok) useUI.getState().pushToast(list.length === 1 ? "Copied name" : `Copied ${list.length} names`);
  });
}

const liveTabs = (tabs: { id: number }[]) => tabs.filter((t) => !isTabClosing(t.id)).length;

/**
 * Removes tab `id` after another window takes it. A window with no tabs goes away:
 * a tab window closes, and the main window hides, as with ⌘⇧W.
 */
export function releaseMovedTab(id: number) {
  const found = findTab(id);
  if (!found) return;
  const alone = openPanes().length === 1 && liveTabs(found.store.tabs) === 1;
  found.store.closeTab(id, true);
  const win = getCurrentWindow();
  if (alone && win.label === "main") void win.hide();
}

export function shareItems(paths: string[], anchor: ShareAnchor | Element) {
  if (paths.length === 0) return;
  const rect =
    anchor instanceof Element
      ? (({ x, y, width, height }) => ({ x, y, width, height }))(anchor.getBoundingClientRect())
      : anchor;
  api.sharePaths(paths, rect).catch(showError);
}

export async function copyAsPath(paths?: string[]): Promise<boolean> {
  const list = paths ?? activeTab()?.selection ?? [];
  if (list.length === 0) return false;
  const ok = await copyText(list.join("\n"));
  if (ok) {
    useUI.getState().pushToast(list.length === 1 ? "Copied path" : `Copied ${list.length} paths`);
  }
  return ok;
}

export function diagnosticsCopied() {
  void useClipboard.getState().sync();
  useUI.getState().pushToast("Copied diagnostic info");
}

export function copyDiagnostics() {
  api.copyDiagnostics().then(diagnosticsCopied).catch(showError);
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

/** Picking a terminal by name makes it the default. */
export function openInTerminal(path: string, app?: TerminalApp) {
  const chosen = app ?? currentTerminals().def;
  api
    .openTerminal(path, chosen?.path ?? null)
    .then(() => {
      if (app) useSettings.getState().set({ terminalApp: app.path });
    })
    .catch(showError);
}

/** More than one bare word: arguments, pipes, redirects, globs or expansions. */
const SHELL_LIKE = /[\s;|&<>$`*?(){}]/;

/**
 * `code .` or `warp .` opens the folder in that app directly, without the terminal and the shell start.
 * A bare word (`claude`, `code`) runs at once. Anything shell-like needs a confirm, because it is not a folder name.
 */
export function runInTerminal(dir: string, command: string) {
  const opener = appCommand(command, [...currentEditors().list, ...currentTerminals().list]);
  if (!opener) return confirmCommand(dir, command);
  const target = normalizePath(opener.arg.startsWith("/") ? opener.arg : joinName(dir, opener.arg));
  api
    .isFolder(target)
    .then((folder) => (folder ? api.openTerminal(target, opener.app.path) : confirmCommand(dir, command)))
    .catch(showError);
}

function confirmCommand(dir: string, command: string) {
  if (!SHELL_LIKE.test(command)) return runNow(dir, command);
  useUI.getState().openConfirm({
    title: "Run this command?",
    message: `“${command}” will run in ${currentTerminals().def?.name ?? "the terminal"} in “${baseName(dir) || "/"}”.`,
    confirmLabel: "Run",
    onConfirm: () => runNow(dir, command),
  });
}

// A terminal that cannot take a command (Zentty, or one added by hand) opens the folder.
// The command goes to the clipboard.
function runNow(dir: string, command: string) {
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

export async function openInOtherTerminal(path: string) {
  const app = await api.pickApplication().catch(() => null);
  if (!app) return;
  const s = useSettings.getState();
  if (!currentTerminals().list.some((t) => t.path === app)) {
    s.set({ terminalExtras: [...s.terminalExtras, app] });
  }
  openInTerminal(path, { name: appName(app), path: app });
}

/** Uses the same command as a terminal, because `open -a` takes any app bundle. */
export function openInEditor(path: string, app?: TerminalApp) {
  const chosen = app ?? currentEditors().def;
  if (!chosen) return void openInOtherEditor(path);
  api
    .openTerminal(path, chosen.path)
    .then(() => useSettings.getState().set({ editorApp: chosen.path }))
    .catch(showError);
}

export async function openInOtherEditor(path: string) {
  const app = await api.pickApplication().catch(() => null);
  if (!app) return;
  const s = useSettings.getState();
  if (!currentEditors().list.some((t) => t.path === app)) {
    s.set({ editorExtras: [...s.editorExtras, app] });
  }
  openInEditor(path, { name: appName(app), path: app });
}

/** ⌥⌘T. Uses the one selected folder, else the open folder, else home. */
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

export function showFolderTreeHere() {
  const tab = activeTab();
  if (!tab) return;
  const one = tab.selection.length === 1 ? getViewEntries().find((e) => e.path === tab.selection[0]) : undefined;
  const dir = one && isFolder(one) ? one.path : tab.location.kind === "path" ? tab.location.path : null;
  if (dir) showFolderTree(dir);
  else useUI.getState().pushToast("Open a folder to see its tree");
}

/** Closes the tree if it already shows `dir`. */
/** Lists what an archive holds in the side panel, without extracting it. */
export function showArchiveContents(path: string) {
  previewStore().getState().setPreviewOpen(false);
  useUI.getState().openFolderTree(path, usePanes.getState().focused, true);
}

export function showFolderTree(dir: string) {
  const ui = useUI.getState();
  const pane = usePanes.getState().focused;
  if (ui.folderTree?.root === dir && ui.folderTree.pane === pane) ui.closeFolderTree();
  else {
    previewStore().getState().setPreviewOpen(false);
    ui.openFolderTree(dir, pane);
  }
}

/** Selects what the other half lacks or has an older copy of. Offers to copy it across. */
export function compareSplitFolders() {
  const ui = useUI.getState();
  const [left, right] = openPanes();
  const tabOf = (s?: { tabs: TabState[]; activeId: number }) => s?.tabs.find((t) => t.id === s.activeId);
  const l = tabOf(left)?.location;
  const r = tabOf(right)?.location;
  if (!right || l?.kind !== "path" || r?.kind !== "path") {
    ui.pushToast("Open two folders in split view to compare them");
    return;
  }
  if (l.path === r.path) {
    ui.pushToast("Both sides show the same folder");
    return;
  }
  // A filtered or still-loading side would count hidden items as missing.
  if (!paneWhole[0] || !paneWhole[1]) {
    ui.pushToast("Clear searches and filters, and let both folders finish loading, to compare them");
    return;
  }
  const toRight = missingOrNewer(getPaneEntries(0), getPaneEntries(1));
  const toLeft = missingOrNewer(getPaneEntries(1), getPaneEntries(0));
  paneStore(0).getState().setSelection(toRight, toRight[0] ?? null);
  paneStore(1).getState().setSelection(toLeft, toLeft[0] ?? null);
  if (toRight.length + toLeft.length === 0) {
    ui.pushToast("Both folders have the same items");
    return;
  }
  const count = (n: number) => `${n} item${n === 1 ? "" : "s"}`;
  ui.pushToast(`Selected ${count(toRight.length)} on the left and ${count(toLeft.length)} on the right that are missing or newer`, {
    label: "Copy across",
    onClick: () =>
      void (async () => {
        if (toRight.length) await transfer("copy", toRight, r.path);
        if (toLeft.length) await transfer("copy", toLeft, l.path);
      })(),
  });
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

type Appearance = { theme?: ThemePref; folderColor?: FolderColorId; selectionColor?: FolderColorId | null };

/**
 * Changes theme or colors under a circle that spreads from `from`.
 * A change that looks the same, such as System to Dark on a dark Mac, applies at once.
 */
export function setAppearance(patch: Appearance, from?: Element | null) {
  const s = useSettings.getState();
  const next = { ...s, ...patch };
  const same =
    resolveTheme(next.theme) === resolveTheme(s.theme) &&
    next.folderColor === s.folderColor &&
    (next.selectionColor ?? next.folderColor) === (s.selectionColor ?? s.folderColor);
  const apply = () => useSettings.getState().set(patch);
  if (same) apply();
  else void runReveal(apply, from);
}

export function setTheme(theme: ThemePref, from?: Element | null) {
  setAppearance({ theme }, from);
}

/** capabilities/default.json allows opening this URL and its releases. */
const REPO_URL = "https://github.com/mhbsiam/doftar";

function openGitHub(url: string) {
  openUrl(url).catch(() => useUI.getState().pushToast(`Couldn't open ${url}`, undefined, "error"));
}

/** Doftar never checks for updates, so its own age is the only hint that a newer version may exist. */
function builtLabel(now = Date.now()): string {
  if (typeof __BUILD_MS__ === "undefined") return "";
  const built = new Date(__BUILD_MS__).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const old = now - __BUILD_MS__ > 183 * 24 * 3600 * 1000;
  return `, built ${built}${old ? ". It is over six months old: Help → Check for Updates shows newer versions" : ""}`;
}

export async function showAbout() {
  const version = await getVersion().catch(() => null);
  useUI.getState().openConfirm({
    title: "About Doftar",
    message:
      `${version ? `Version ${version}${builtLabel()}\n` : ""}Made by Hasanul Banna Siam.\n` +
      "Copyright © 2026 Hasanul Banna Siam. Licensed under the Apache License 2.0.",
    confirmLabel: "Close",
    hideCancel: true,
    onConfirm: () => {},
  });
}

export function openRepo() {
  openGitHub(REPO_URL);
}

export function checkForUpdates() {
  openGitHub(`${REPO_URL}/releases`);
}

/** Data files that open as one table, compared row by row. Keep in step with `Data` in src-tauri/src/data.rs. */
const TABLE_EXTS = new Set(["csv", "tsv", "tab", "jsonl", "ndjson", "parquet", "pq", "arrow", "arrows", "feather"]);

/** Exactly two selected files: text or Word, two tables of any format, or two AnnData files. */
export function comparablePair(selection: string[]): [string, string] | null {
  if (selection.length !== 2) return null;
  const kind = (p: string) => {
    const ext = extOf(p);
    if (isPlainText(ext) || isMarkdown(ext) || ext === "docx") return "text";
    return TABLE_EXTS.has(ext) ? "table" : ext === "h5ad" ? "ann" : null;
  };
  const k = kind(selection[0]);
  return k && k === kind(selection[1]) ? [selection[0], selection[1]] : null;
}

export function compareSelectedFiles() {
  const pair = comparablePair(useTabs.getState().tabs.find((t) => t.id === useTabs.getState().activeId)?.selection ?? []);
  if (!pair) {
    useUI.getState().pushToast("Select two text, code, Word, table or AnnData files to compare them");
    return;
  }
  navigateTo({ kind: "compare", a: pair[0], b: pair[1] });
}
