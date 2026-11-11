import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSettings, type ViewPrefs } from "../stores/settings";
import { runViewSwitch } from "../util/transition";
import { ICON_SIZES } from "./useVirtual";
import { useFileIds } from "../stores/fileIds";
import { useAppData } from "../stores/appdata";
import { useActiveTab, useTabs } from "../stores/tabs";

const pathOf = (location: { kind: string; path?: string }) =>
  location.kind === "path" ? (location.path ?? null) : null;

/** Tag pages share one saved view under this id. */
const TAGS_VIEW = "tags";
const pseudoIdOf = (location: { kind: string }) =>
  location.kind === "tags" ? TAGS_VIEW : location.kind === "screenshots" ? "screenshots" : null;

const pick = (s: ViewPrefs): ViewPrefs => ({
  viewMode: s.viewMode,
  sortKey: s.sortKey,
  sortAsc: s.sortAsc,
  groupBy: s.groupBy,
  iconSize: s.iconSize,
});

/** The Apps page is always sorted by name, ascending, and never grouped. */
const APPS_PAGE = "/Applications";

/** These places start with their own view. The user's own choices there win. */
const DOWNLOADS_VIEW: Partial<ViewPrefs> = { groupBy: "created", sortKey: "modified", sortAsc: true };
const SCREENSHOTS_VIEW: Partial<ViewPrefs> = { groupBy: "created" };
const downloadsPath = () => `${useAppData.getState().home}/Downloads`;

function presetOf(location: { kind: string; path?: string }, downloads: string) {
  if (location.kind === "screenshots") return SCREENSHOTS_VIEW;
  return pathOf(location) === downloads ? DOWNLOADS_VIEW : undefined;
}

export interface FolderView extends ViewPrefs {
  /** The folder id lookup is not done, so its own view is not known. */
  pending: boolean;
  hasOverride: boolean;
  locked: boolean;
}

export function useFolderView(): FolderView {
  const { location, columns } = useActiveTab();
  const path = pathOf(location);
  const pseudo = pseudoIdOf(location);
  const fileId = useFileIds((s) => (path ? s.byPath[path] : undefined));
  const id = pseudo ?? fileId;
  const settled = useFileIds((s) => (path ? !!s.settled[path] : true));
  useEffect(() => {
    if (path) void useFileIds.getState().refresh([path]);
  }, [path]);
  const defaults = useSettings(useShallow(pick));
  const own = useSettings((s) => (id ? s.folderViews[id] : undefined));
  const downloads = useAppData((s) => `${s.home}/Downloads`);
  return {
    ...defaults,
    ...presetOf(location, downloads),
    ...own,
    ...(path === APPS_PAGE
      ? { sortKey: "name" as const, sortAsc: true, groupBy: "none" as const }
      : undefined),
    // Result pages (tags, Screenshots) have no folders to walk through.
    ...(columns && !pseudo ? { viewMode: "columns" as const } : undefined),
    pending: !!path && !id && !settled,
    hasOverride: !!own,
    locked: path === APPS_PAGE,
  };
}

function activeFolderPath(): string | null {
  const tabs = useTabs.getState();
  const tab = tabs.tabs.find((t) => t.id === tabs.activeId);
  return tab ? pathOf(tab.location) : null;
}

function activeFolderId(): string | undefined {
  const tabs = useTabs.getState();
  const tab = tabs.tabs.find((t) => t.id === tabs.activeId);
  const pseudo = tab ? pseudoIdOf(tab.location) : null;
  if (pseudo) return pseudo;
  const path = activeFolderPath();
  return path ? useFileIds.getState().byPath[path] : undefined;
}

export function setFolderView(patch: Partial<ViewPrefs>) {
  // Columns belong to the tab, so they stay when the tab moves between folders.
  const tabs = useTabs.getState();
  const columns = tabs.tabs.find((t) => t.id === tabs.activeId)?.columns ?? false;
  if (patch.viewMode === "columns") {
    if (!columns) runViewSwitch(() => tabs.setColumns(true));
    const { viewMode, ...rest } = patch;
    patch = rest;
    if (Object.keys(patch).length === 0) return;
  } else if (patch.viewMode !== undefined && columns) {
    // Queue it in the same transition as the folder switch below, if any.
    runViewSwitch(() => tabs.setColumns(false));
  }
  if (activeFolderPath() === APPS_PAGE) {
    const { sortKey, sortAsc, groupBy, ...rest } = patch;
    if (Object.keys(rest).length === 0) return;
    patch = rest;
  }
  const id = activeFolderId();
  const s = useSettings.getState();
  if (id) s.setFolderView(id, patch);
  // Do not rewrite the defaults for every folder when the id lookup failed.
  // Only Home and Disk, which have no folder, set defaults.
  else if (activeFolderPath() === null) s.set(patch);
}

/** Larger from another view switches to icons. Smaller works only in icons. */
export function stepIconSize(delta: 1 | -1) {
  const tabs = useTabs.getState();
  const tab = tabs.tabs.find((t) => t.id === tabs.activeId);
  const s = useSettings.getState();
  const id = activeFolderId();
  const own = id ? s.folderViews[id] : undefined;
  const grid = !tab?.columns && (own?.viewMode ?? s.viewMode) === "grid";
  if (!grid) {
    if (delta > 0) setFolderView({ viewMode: "grid" });
    return;
  }
  const sizes = ICON_SIZES.map(([n]) => n);
  const at = sizes.indexOf(own?.iconSize ?? s.iconSize);
  const next = sizes[Math.min(sizes.length - 1, Math.max(0, (at < 0 ? 1 : at) + delta))];
  if (next !== (own?.iconSize ?? s.iconSize)) setFolderView({ iconSize: next });
}

export function resetFolderView() {
  const id = activeFolderId();
  if (id) useSettings.getState().clearFolderView(id);
}

export async function applyViewToAll() {
  const id = activeFolderId();
  const tabs = useTabs.getState();
  const tab = tabs.tabs.find((t) => t.id === tabs.activeId);
  const downloads = downloadsPath();
  const s = useSettings.getState();
  const prefs: ViewPrefs = {
    ...pick(s),
    ...(tab ? presetOf(tab.location, downloads) : undefined),
    ...(id ? s.folderViews[id] : undefined),
  };
  // Apply the view to places with their own start view too. Else they keep their old view.
  await useFileIds.getState().refresh([downloads]).catch(() => {});
  const downloadsId = useFileIds.getState().byPath[downloads];
  useSettings
    .getState()
    .applyViewToAll(prefs, { screenshots: prefs, ...(downloadsId ? { [downloadsId]: prefs } : {}) });
}
