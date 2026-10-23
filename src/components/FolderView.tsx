import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AppsRegular,
  ArchiveRegular,
  ArrowClockwiseRegular,
  ArrowUndoRegular,
  ClipboardPasteRegular,
  CopyRegular,
  CutRegular,
  DeleteRegular,
  DocumentRegular,
  EditRegular,
  FolderOpenRegular,
  FolderZipRegular,
  FolderRegular,
  InfoRegular,
  ShareRegular,
  HeartFilled,
  HeartRegular,
} from "@fluentui/react-icons";
import { DetailsView } from "./DetailsView";
import { GridView } from "./GridView";
import { terminalMenuItems } from "./terminalMenu";
import { tagMenuItems } from "./tagMenu";
import { tagFilterActive } from "../util/tags";
import { useSettings } from "../stores/settings";
import { useActiveTab, usePaneStore, useTabs, parentOf } from "../stores/tabs";
import { useUI, type CommandSpec, type MenuItemSpec } from "../stores/ui";
import { useAppData } from "../stores/appdata";
import { useClipboard } from "../stores/clipboard";
import {
  appsFor,
  compressItems,
  copyAsPath,
  copySelection,
  copyText,
  cutSelection,
  deleteSelection,
  emptyTrash,
  extractArchive,
  folderEntryForPath,
  getViewEntries,
  isExtractable,
  isInstalledApp,
  isInTrash,
  isTrashDir,
  newFile,
  newFolder,
  openEntry,
  openFullDiskAccessSettings,
  openWith,
  openWithOther,
  shareItems,
  paste,
  putBackSelection,
  refreshByUser,
  setViewEntries,
  startRename,
  toggleFavoriteEntry,
  uninstallApps,
} from "../actions";
import type { FileEntry, SortKey } from "../types";
import { isFolder } from "../util/kinds";
import { useListNav } from "../hooks/useListNav";
import { useMarquee } from "../hooks/useMarquee";
import { beginPress } from "../drag";
import { groupEntries } from "../util/grouping";
import { setFolderView, useFolderView } from "../hooks/useFolderView";

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function sortEntries(list: FileEntry[], sortKey: SortKey, sortAsc: boolean): FileEntry[] {
  const dir = sortAsc ? 1 : -1;
  const arr = [...list];
  arr.sort((a, b) => {
    const fa = isFolder(a);
    if (fa !== isFolder(b)) return fa ? -1 : 1;
    let c = 0;
    switch (sortKey) {
      case "name":
        c = collator.compare(a.name, b.name);
        break;
      case "modified":
        c = a.modifiedMs - b.modifiedMs;
        break;
      case "size":
        c = a.size - b.size;
        break;
      case "type":
        c = collator.compare(a.ext || "", b.ext || "");
        break;
    }
    if (c === 0 && sortKey !== "name") {
      c = collator.compare(a.name, b.name);
    }
    return c * dir;
  });
  return arr;
}

interface Props {
  entries: FileEntry[];
  /** The listing `entries` was filtered from, so its sort can be reused. */
  sortSource?: FileEntry[];
  totalCount: number;
  error: string | null;
  loading: boolean;
  searchRoot: string | null;
  searchTruncated: boolean;
}

export function FolderView({
  entries,
  sortSource,
  totalCount,
  error,
  loading,
  searchRoot,
  searchTruncated,
}: Props) {
  const tab = useActiveTab();
  const settings = useSettings();
  const view = useFolderView();
  const paneTabs = usePaneStore();
  const pane = paneTabs.getState().pane;
  const dragOver = useUI((s) => s.dragOver === pane);
  const [cursor, setCursor] = useState<string | null>(null);
  const [kbd, setKbd] = useState(false);
  const selectedSet = useMemo(() => new Set(tab.selection), [tab.selection]);

  const groupBy = searchRoot ? "none" : view.groupBy;
  // The full listing is sorted once; a search then filters that sorted list
  // instead of re-sorting what is left on every keystroke.
  const sortedSource = useMemo(
    () => (sortSource ? sortEntries(sortSource, view.sortKey, view.sortAsc) : null),
    [sortSource, view.sortKey, view.sortAsc]
  );
  const { display, groups } = useMemo(() => {
    let arr: FileEntry[];
    if (sortedSource) {
      const keep = new Set(entries);
      arr = entries.length === sortedSource.length ? sortedSource : sortedSource.filter((e) => keep.has(e));
    } else {
      arr = sortEntries(entries, view.sortKey, view.sortAsc);
    }
    const grouped = groupEntries(arr, groupBy, view.sortKey, view.sortAsc);
    return { display: grouped.entries, groups: grouped.groups };
  }, [entries, sortedSource, view.sortKey, view.sortAsc, groupBy]);

  useEffect(() => {
    setViewEntries(pane, display);
    paneTabs.getState().setListingCount(display.length);
  }, [display, pane, paneTabs]);

  useEffect(() => {
    let bytes = 0;
    for (const e of display) if (selectedSet.has(e.path)) bytes += e.size;
    paneTabs.getState().setSelectionBytes(bytes);
  }, [display, selectedSet, paneTabs]);

  const displayRef = useRef(display);
  displayRef.current = display;
  const contentRef = useRef<HTMLDivElement>(null);
  const scopeKey = `${tab.id}:${tab.location.kind === "path" ? tab.location.path : ""}`;
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [scopeKey]);
  // Coming back (Back/Forward, or to this tab): return to where the list was
  // scrolled. Rows may still be streaming in, so wait until they're tall
  // enough to reach it, or until loading ends.
  const restore = tab.restoreScroll;
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (restore === null || !el || view.pending) return;
    if (el.scrollHeight - el.clientHeight >= restore || !loading) {
      el.scrollTop = restore;
      paneTabs.getState().clearRestoreScroll();
    }
  });
  const marquee = useMarquee(contentRef, displayRef, view.viewMode !== "details");

  const onHeaderClick = useCallback(
    (key: SortKey) =>
      setFolderView({
        sortKey: key,
        sortAsc: key === view.sortKey ? !view.sortAsc : true,
      }),
    [view.sortKey, view.sortAsc]
  );

  const onRowClick = useCallback(
    (e: React.MouseEvent, entry: FileEntry, index: number) => {
      const tabs = useTabs.getState();
      const cur = tabs.tabs.find((t) => t.id === tabs.activeId);
      if (!cur) return;
      setCursor(entry.path);
      setKbd(false);
      if (e.metaKey || e.ctrlKey) {
        const next = cur.selection.includes(entry.path)
          ? cur.selection.filter((p) => p !== entry.path)
          : [...cur.selection, entry.path];
        tabs.setSelection(next, entry.path);
        return;
      }
      if (e.shiftKey && cur.anchor) {
        const list = displayRef.current;
        const anchorIdx = list.findIndex((x) => x.path === cur.anchor);
        if (anchorIdx >= 0) {
          const lo = Math.min(anchorIdx, index);
          const hi = Math.max(anchorIdx, index);
          tabs.setSelection(
            list.slice(lo, hi + 1).map((x) => x.path),
            cur.anchor
          );
          return;
        }
      }
      tabs.setSelection([entry.path], entry.path);
    },
    []
  );

  const onRowCheck = useCallback((entry: FileEntry) => {
    const tabs = useTabs.getState();
    const cur = tabs.tabs.find((t) => t.id === tabs.activeId);
    if (!cur) return;
    setCursor(entry.path);
    setKbd(false);
    const next = cur.selection.includes(entry.path)
      ? cur.selection.filter((p) => p !== entry.path)
      : [...cur.selection, entry.path];
    tabs.setSelection(next, entry.path);
  }, []);

  const onCheckAll = useCallback(() => {
    const tabs = useTabs.getState();
    const cur = tabs.tabs.find((t) => t.id === tabs.activeId);
    if (!cur) return;
    const list = displayRef.current;
    const picked = new Set(cur.selection);
    if (list.length > 0 && list.every((x) => picked.has(x.path))) {
      tabs.setSelection([], null);
    } else {
      tabs.setSelection(list.map((x) => x.path), list[0]?.path ?? null);
    }
  }, []);

  const rowContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    openRowMenu(e.clientX, e.clientY, entry);
  }, []);

  const onRowMouseDown = useCallback(
    (e: React.MouseEvent, entry: FileEntry) => beginPress(e, entry),
    []
  );

  const onPointerDown = useCallback(() => setKbd(false), []);
  const onListKeyDown = useListNav({
    entries: display,
    grid: view.viewMode !== "details",
    cursor,
    setCursor,
    setKbd,
    openMenu: openRowMenu,
  });
  const activeIndex = useMemo(() => {
    if (!cursor || !selectedSet.has(cursor)) return -1;
    return display.findIndex((x) => x.path === cursor);
  }, [display, cursor, selectedSet]);

  const scope = scopeKey;

  // Wait for the folder's own view so it doesn't flash in the default one.
  if (view.pending) return <div className="content" ref={contentRef} />;

  if (error) {
    const here = tab.location.kind === "path" ? tab.location.path : null;
    // macOS guards the Trash with Full Disk Access, not Files and Folders.
    if (isInTrash(here)) {
      return (
        <div className="content empty-state">
          <h2>Can't open the Trash</h2>
          <p>{error}</p>
          <p className="hint">
            macOS only lets apps read the Trash with Full Disk Access. Turn on
            Doftar in System Settings → Privacy &amp; Security → Full Disk
            Access, then reopen the Trash.
          </p>
          <button className="btn accent" onClick={() => openFullDiskAccessSettings()}>
            Open Privacy Settings
          </button>
        </div>
      );
    }
    return (
      <div className="content empty-state">
        <h2>Can't open this folder</h2>
        <p>{error}</p>
        <p className="hint">
          If this is a protected folder (Desktop, Documents, Downloads…),
          grant access in System Settings → Privacy &amp; Security → Files and
          Folders.
        </p>
      </div>
    );
  }

  const blankContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const ui = useUI.getState();
    const clipboard = useClipboard.getState();
    const dir = tab.location.kind === "path" ? tab.location.path : null;
    const inTrash = isInTrash(dir);
    const items: MenuItemSpec[] = [
      ...(inTrash
        ? [
            {
              key: "empty-trash",
              label: "Empty Trash",
              icon: <DeleteRegular />,
              onSelect: emptyTrash,
            },
            { key: "d0", dividerBefore: true },
          ]
        : []),
      {
        key: "new",
        label: "New",
        icon: <FolderRegular />,
        items: [
          {
            key: "nf",
            label: "Folder",
            icon: <FolderRegular />,
            onSelect: () => newFolder(),
          },
          {
            key: "nt",
            label: "Text Document",
            icon: <DocumentRegular />,
            onSelect: () => newFile(),
          },
        ],
      },
      {
        key: "paste",
        label: "Paste",
        icon: <ClipboardPasteRegular />,
        shortcut: "Ctrl+V",
        disabled: clipboard.paths.length === 0,
        onSelect: () => paste(),
      },
      { key: "d1", dividerBefore: true },
      {
        key: "refresh",
        label: "Refresh",
        icon: <ArrowClockwiseRegular />,
        shortcut: "F5",
        onSelect: () => refreshByUser(),
      },
      { key: "d2", dividerBefore: true },
      {
        key: "copypath",
        label: "Copy folder path",
        icon: <CopyRegular />,
        disabled: !dir,
        onSelect: () => dir && void copyText(dir),
      },
      {
        key: "properties",
        label: "Folder properties",
        icon: <InfoRegular />,
        disabled: !dir,
        onSelect: () =>
          dir && ui.openProperties(folderEntryForPath(dir)),
      },
      ...terminalMenuItems(dir),
      { key: "d3", dividerBefore: true },
      {
        key: "hidden",
        label: "Show hidden files",
        checked: settings.showHidden,
        onSelect: () => settings.set({ showHidden: !settings.showHidden }),
      },
    ];
    ui.openContextMenu(e.clientX, e.clientY, items);
  };

  return (
    <div
      ref={contentRef}
      className={`content${dragOver ? " drop-target" : ""}`}
      onMouseDown={marquee.onMouseDown}
      onClickCapture={marquee.onClickCapture}
      onClick={(e) => {
        const el = e.target as HTMLElement;
        if (!el.closest(".drow, .gtile, .dhead, button, input")) {
          useTabs.getState().setSelection([], null);
          e.currentTarget
            .querySelector<HTMLElement>("[role=grid], [role=listbox]")
            ?.focus({ preventScroll: true });
        }
      }}
      onContextMenu={(e) => {
        if (
          e.target === e.currentTarget ||
          !(e.target as HTMLElement).closest(".drow, .gtile")
        ) {
          blankContextMenu(e);
        }
      }}
    >
      {display.length === 0 ? (
        <div className="empty-state">
          {totalCount > 0 ? (
            <p>No items match your search or filter.</p>
          ) : loading ? (
            <p className="loading">{searchRoot ? "Searching…" : "Loading…"}</p>
          ) : tab.location.kind === "tags" ? (
            <p>No items are tagged “{tab.location.tag}”.</p>
          ) : searchRoot && tagFilterActive(tab.tagFilter) && tab.tagFilter.deep ? (
            <p>No tagged items match here or in subfolders.</p>
          ) : searchRoot ? (
            <p>No items match your search.</p>
          ) : (
            <p>This folder is empty.</p>
          )}
        </div>
      ) : view.viewMode === "details" ? (
        <DetailsView
          searchRoot={searchRoot}
          entries={display}
          groups={groups}
          scope={scope}
          selected={selectedSet}
          cursor={cursor}
          kbd={kbd}
          activeIndex={activeIndex}
          renaming={tab.renaming}
          showChecks={settings.showCheckboxes}
          onCheck={onRowCheck}
          onCheckAll={onCheckAll}
          onRowClick={onRowClick}
          onRowDoubleClick={openEntry}
          onRowContextMenu={rowContextMenu}
          onRowMouseDown={onRowMouseDown}
          onHeaderClick={onHeaderClick}
          onKeyDown={onListKeyDown}
          onPointerDown={onPointerDown}
        />
      ) : (
        <GridView
          entries={display}
          groups={groups}
          scope={scope}
          selected={selectedSet}
          cursor={cursor}
          kbd={kbd}
          activeIndex={activeIndex}
          renaming={tab.renaming}
          showChecks={settings.showCheckboxes}
          onCheck={onRowCheck}
          onTileClick={onRowClick}
          onTileDoubleClick={openEntry}
          onTileContextMenu={rowContextMenu}
          onTileMouseDown={onRowMouseDown}
          onKeyDown={onListKeyDown}
          onPointerDown={onPointerDown}
        />
      )}
      {searchRoot && (loading || searchTruncated) && (
        <div className="search-note" role="status">
          {loading
            ? tab.location.kind === "tags"
              ? "Finding tagged items…"
              : "Searching subfolders…"
            : "Showing the first 5,000 matches. Refine your search to narrow it."}
        </div>
      )}
      {marquee.active && <div className="marquee" aria-hidden ref={marquee.ref} />}
    </div>
  );
}

const pointAt = (x: number, y: number) => ({ x, y, width: 1, height: 1 });

async function openRowMenu(x: number, y: number, entry: FileEntry) {
  {
    {
      const tabs = useTabs.getState();
      const cur = tabs.tabs.find((t) => t.id === tabs.activeId);
      if (!cur) return;
      if (!cur.selection.includes(entry.path)) {
        tabs.setSelection([entry.path], entry.path);
      }
    }
    const apps = isFolder(entry) ? [] : await appsFor(entry.path);
    // The lookup above can take a moment; act on the selection as it is now.
    const tabs = useTabs.getState();
    const cur = tabs.tabs.find((t) => t.id === tabs.activeId);
    if (!cur) return;
    const appdata = useAppData.getState();
    const ui = useUI.getState();
    const isFavorite = appdata.favorites.some((f) => f.path === entry.path);
    const multi = cur.selection.length > 1 && cur.selection.includes(entry.path);
    const targets = multi ? [...cur.selection] : [entry.path];
    const commands: CommandSpec[] = [
      { key: "copy", label: "Copy", icon: <CopyRegular />, onSelect: () => copySelection() },
      { key: "rename", label: "Rename", icon: <EditRegular />, disabled: multi, onSelect: () => startRename() },
      { key: "cut", label: "Cut", icon: <CutRegular />, onSelect: () => cutSelection() },
      { key: "share", label: "Share", icon: <ShareRegular />, onSelect: () => shareItems(targets, pointAt(x, y)) },
      { key: "delete", label: "Delete", icon: <DeleteRegular />, onSelect: () => deleteSelection(false) },
    ];
    const inTrash = isTrashDir(parentOf(entry.path));
    const inResults =
      (tabs.deepSearch !== null &&
        cur.location.kind === "path" &&
        tabs.deepSearch === cur.location.path &&
        tabs.search.trim() !== "") ||
      cur.location.kind === "tags" ||
      (tagFilterActive(cur.tagFilter) && cur.tagFilter.deep);
    const chosen = new Set(targets);
    const shown = getViewEntries().filter((e) => chosen.has(e.path));
    const items: MenuItemSpec[] = [
      ...(inTrash
        ? [
            {
              key: "put-back",
              label: "Put Back",
              icon: <ArrowUndoRegular />,
              onSelect: () => putBackSelection(),
            },
          ]
        : []),
      {
        key: "open",
        label: "Open",
        icon: <FolderOpenRegular />,
        shortcut: "Enter",
        onSelect: () => openEntry(entry),
      },
      ...(isFolder(entry)
        ? []
        : [
            {
              key: "open-with",
              label: "Open with",
              icon: <AppsRegular />,
              items: [
                ...apps.map((app) => ({
                  key: `app:${app.path}`,
                  label: app.isDefault ? `${app.name} (default)` : app.name,
                  onSelect: () => openWith(targets, app.path),
                })),
                {
                  key: "app-other",
                  label: "Choose another app…",
                  dividerBefore: apps.length > 0,
                  onSelect: () => void openWithOther(targets),
                },
              ],
            },
          ]),
      ...(isFolder(entry)
        ? [
            {
              key: "open-tab",
              label: "Open in new tab",
              icon: <FolderRegular />,
              onSelect: () =>
                useTabs
                  .getState()
                  .newTab({ kind: "path" as const, path: entry.path }),
            },
          ]
        : []),
      ...(entry.isPackage
        ? [
            {
              key: "pkg-contents",
              label: "Show Package Contents",
              icon: <FolderOpenRegular />,
              onSelect: () =>
                useTabs
                  .getState()
                  .navigate({ kind: "path" as const, path: entry.path }),
            },
          ]
        : []),
      ...(inResults
        ? [
            {
              key: "reveal",
              label: "Open file location",
              icon: <FolderOpenRegular />,
              onSelect: () => useTabs.getState().reveal(entry.path),
            },
          ]
        : []),
      {
        key: "fav",
        label: isFavorite ? "Remove from Favorites" : "Add to Favorites",
        icon: isFavorite ? <HeartFilled /> : <HeartRegular />,
        onSelect: () => toggleFavoriteEntry(entry),
      },
      { key: "d1", dividerBefore: true },
      {
        key: "compress",
        label: "Compress to ZIP",
        icon: <ArchiveRegular />,
        onSelect: () => void compressItems(targets),
      },
      ...(!multi && isExtractable(entry)
        ? [
            {
              key: "extract",
              label: "Extract here",
              icon: <FolderZipRegular />,
              onSelect: () => void extractArchive(entry.path),
            },
          ]
        : []),
      {
        key: "copy-path",
        label: "Copy as path",
        icon: <CopyRegular />,
        shortcut: "⌥⌘C",
        onSelect: () => copyAsPath(targets),
      },
      {
        key: "props",
        label: "Properties",
        icon: <InfoRegular />,
        shortcut: "Alt+Enter",
        onSelect: () => ui.openProperties(multi ? shown : entry),
      },
      ...tagMenuItems(shown.length > 0 ? shown : [entry]),
      { key: "d2", dividerBefore: true },
      ...terminalMenuItems(isFolder(entry) ? entry.path : parentOf(entry.path) ?? entry.path),
      ...(isInstalledApp(entry)
        ? [
            {
              key: "uninstall",
              label: "Uninstall",
              icon: <DeleteRegular />,
              dividerBefore: true,
              onSelect: () => {
                const chosen = new Set(targets);
                const apps = getViewEntries().filter((e) => chosen.has(e.path) && isInstalledApp(e));
                uninstallApps(apps.map((a) => a.path));
              },
            },
          ]
        : []),
    ];
    ui.openContextMenu(x, y, items, commands);
  }
}
