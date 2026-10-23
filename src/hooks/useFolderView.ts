import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSettings, type ViewPrefs } from "../stores/settings";
import { useFileIds } from "../stores/fileIds";
import { useActiveTab, useTabs } from "../stores/tabs";

const pathOf = (location: { kind: string; path?: string }) =>
  location.kind === "path" ? (location.path ?? null) : null;

/** Tag pages share one saved view, kept like a folder's under this id. */
const TAGS_VIEW = "tags";
const pseudoIdOf = (location: { kind: string }) => (location.kind === "tags" ? TAGS_VIEW : null);

const pick = (s: ViewPrefs): ViewPrefs => ({
  viewMode: s.viewMode,
  sortKey: s.sortKey,
  sortAsc: s.sortAsc,
  groupBy: s.groupBy,
});

/** The Apps page is always listed by name, ascending, and never grouped. */
const APPS_PAGE = "/Applications";

export interface FolderView extends ViewPrefs {
  /** The folder's id is still being looked up; its own view isn't known yet. */
  pending: boolean;
  hasOverride: boolean;
  /** Sorting and grouping are fixed for this folder. */
  locked: boolean;
}

/** The active folder's view: its own saved choices over the defaults. */
export function useFolderView(): FolderView {
  const location = useActiveTab().location;
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
  return {
    ...defaults,
    ...own,
    ...(path === APPS_PAGE
      ? { sortKey: "name" as const, sortAsc: true, groupBy: "none" as const }
      : undefined),
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

/** Saves a view choice for the active folder, or as the default where there is none. */
export function setFolderView(patch: Partial<ViewPrefs>) {
  if (activeFolderPath() === APPS_PAGE) {
    const { sortKey, sortAsc, groupBy, ...rest } = patch;
    if (Object.keys(rest).length === 0) return;
    patch = rest;
  }
  const id = activeFolderId();
  const s = useSettings.getState();
  if (id) s.setFolderView(id, patch);
  // A folder whose id isn't known (lookup failed) must not rewrite the
  // defaults for every folder; only places without a folder (Home, Disk) do.
  else if (activeFolderPath() === null) s.set(patch);
}

export function resetFolderView() {
  const id = activeFolderId();
  if (id) useSettings.getState().clearFolderView(id);
}

/** Makes the active folder's current view the default everywhere. */
export function applyViewToAll() {
  const id = activeFolderId();
  const s = useSettings.getState();
  s.applyViewToAll({ ...pick(s), ...(id ? s.folderViews[id] : undefined) });
}
