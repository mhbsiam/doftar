import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AppsRegular,
  ArchiveRegular,
  ArrowClockwiseRegular,
  ArrowSwapRegular,
  ArrowUndoRegular,
  ClipboardPasteRegular,
  CopyRegular,
  CutRegular,
  DeleteRegular,
  TextBulletListTreeRegular,
  DocumentRegular,
  EditRegular,
  FolderOpenRegular,
  FolderAddRegular,
  FolderArrowRightRegular,
  FolderZipRegular,
  FolderRegular,
  InfoRegular,
  ShareIosRegular,
  HeartFilled,
  HeartRegular,
  TableRegular,
  ZoomInRegular,
  DocumentCopyRegular,
  TextTRegular,
  WindowNewRegular,
} from "@fluentui/react-icons";
import { DetailsView } from "./DetailsView";
import { GridView } from "./GridView";
import { ColumnView } from "./ColumnView";
import { terminalMenuItems } from "./terminalMenu";
import { keysOf } from "../util/palette";
import { tagMenuItems } from "./tagMenu";
import { tagFilterActive } from "../util/tags";
import { useSettings } from "../stores/settings";
import { useActiveTab, usePaneStore, usePanes, useTabs, parentOf } from "../stores/tabs";
import { useUI, type CommandSpec, type MenuItemSpec } from "../stores/ui";
import { useAppData } from "../stores/appdata";
import {
  appsFor,
  compressItems,
  copyAsPath,
  copyName,
  duplicateSelection,
  revealInFinder,
  copySelection,
  copyText,
  compareSplitFolders,
  cutSelection,
  deleteSelection,
  emptyTrash,
  extractArchive,
  folderEntryForPath,
  showFolderTree,
  getViewEntries,
  isExtractable,
  isInstalledApp,
  isInTrash,
  isTrashDir,
  newFile,
  newFolder,
  newFolderWithSelection,
  showArchiveContents,
  activateEntry,
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
import { isFolder, isSheet } from "../util/kinds";
import { openReaderFromListing } from "../viewerFlight";
import { useListNav } from "../hooks/useListNav";
import { useMarquee } from "../hooks/useMarquee";
import { beginPress } from "../drag";
import { groupEntries, sortEntries } from "../util/grouping";
import { setFolderView, useFolderView } from "../hooks/useFolderView";

interface Props {
  entries: FileEntry[];
  /** The listing that `entries` was filtered from. Its sort is reused. */
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

  // A search inside a folder lists flat. The Screenshots and tag pages group like folders.
  const resultsPage = tab.location.kind === "screenshots" || tab.location.kind === "tags";
  const groupBy = searchRoot && !resultsPage ? "none" : view.groupBy;
  // Sort the full listing once. A search filters the sorted list and does not re-sort on each keystroke.
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
    // With no filter, the filter chain passes the listing itself.
    setViewEntries(pane, display, entries === sortSource && !loading);
    paneTabs.getState().setListingCount(display.length);
  }, [display, pane, paneTabs, entries, sortSource, loading]);

  useEffect(() => {
    let bytes = 0;
    const dirs: string[] = [];
    for (const e of display) {
      if (!selectedSet.has(e.path)) continue;
      // A folder lists as 0 bytes. The status bar measures it.
      if (e.isDir) dirs.push(e.path);
      else bytes += e.size;
    }
    paneTabs.getState().setSelectionBytes(bytes, dirs);
  }, [display, selectedSet, paneTabs]);

  const displayRef = useRef(display);
  displayRef.current = display;
  const contentRef = useRef<HTMLDivElement>(null);
  const scopeKey = `${tab.id}:${tab.location.kind === "path" ? tab.location.path : ""}`;
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [scopeKey]);
  // On return (Back, Forward, or this tab), restore the scroll position.
  // Rows may still stream in. Wait until they are tall enough, or loading ends.
  const restore = tab.restoreScroll;
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (restore === null || !el || view.pending) return;
    if (el.scrollHeight - el.clientHeight >= restore || !loading) {
      el.scrollTop = restore;
      paneTabs.getState().clearRestoreScroll();
    }
  });
  const marquee = useMarquee(contentRef, displayRef, view.viewMode === "grid");
  // Searches and result pages list flat, in any view.
  const columnsIn = view.viewMode === "columns" && tab.location.kind === "path" && !searchRoot ? tab.location.path : null;

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
    grid: view.viewMode === "grid",
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

  // Wait for the own view of the folder. Then the default view does not flash.
  // Columns belong to the tab, not the folder, so they need not wait.
  if (view.pending && columnsIn === null) return <div className="content" ref={contentRef} />;

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
            keys: keysOf("new_folder"),
            onSelect: () => newFolder(),
          },
          {
            key: "nt",
            label: "Text Document",
            icon: <DocumentRegular />,
            keys: keysOf("new_file"),
            onSelect: () => newFile(),
          },
        ],
      },
      {
        key: "paste",
        label: "Paste",
        icon: <ClipboardPasteRegular />,
        keys: "⌘V",
        onSelect: () => paste(),
      },
      { key: "d1", dividerBefore: true },
      {
        key: "refresh",
        label: "Refresh",
        icon: <ArrowClockwiseRegular />,
        keys: keysOf("refresh"),
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
      {
        key: "tree",
        label: "Show folder tree",
        icon: <TextBulletListTreeRegular />,
        disabled: !dir,
        onSelect: () => dir && showFolderTree(dir),
      },
      ...(usePanes.getState().split
        ? [{ key: "compare", label: "Compare folders", icon: <ArrowSwapRegular />, onSelect: compareSplitFolders }]
        : []),
      ...terminalMenuItems(dir),
    ];
    ui.openContextMenu(e.clientX, e.clientY, items);
  };

  return (
    <div
      ref={contentRef}
      className={`content${dragOver ? " drop-target" : ""}${tab.location.kind === "screenshots" ? " shots" : ""}${columnsIn !== null ? " cols" : ""}`}
      onMouseDown={columnsIn !== null ? undefined : marquee.onMouseDown}
      onClickCapture={marquee.onClickCapture}
      onClick={(e) => {
        const el = e.target as HTMLElement;
        if (!el.closest(".drow, .gtile, .crow, .dhead, button, input")) {
          useTabs.getState().setSelection([], null);
          e.currentTarget
            .querySelector<HTMLElement>("[role=grid], [role=listbox]")
            ?.focus({ preventScroll: true });
        }
      }}
      onContextMenu={(e) => {
        if (
          e.target === e.currentTarget ||
          !(e.target as HTMLElement).closest(".drow, .gtile, .crow")
        ) {
          blankContextMenu(e);
        }
      }}
    >
      {columnsIn !== null ? (
        <ColumnView
          dir={columnsIn}
          entries={display}
          listing={sortSource ?? entries}
          selected={selectedSet}
          kbd={kbd}
          cursor={cursor}
          activeIndex={activeIndex}
          renaming={tab.renaming}
          onRowClick={onRowClick}
          onRowContextMenu={rowContextMenu}
          onRowMouseDown={onRowMouseDown}
          onKeyDown={onListKeyDown}
          onPointerDown={onPointerDown}
        />
      ) : display.length === 0 ? (
        <div className="empty-state">
          {totalCount > 0 ? (
            <p>No items match your search or filter.</p>
          ) : loading && tab.location.kind === "screenshots" ? (
            <ShotsLoading icon={<ZoomInRegular />} label="Searching your folders for screenshots" />
          ) : loading ? (
            <p className="loading">{searchRoot ? "Searching…" : "Loading…"}</p>
          ) : tab.location.kind === "tags" ? (
            <p>No items are tagged “{tab.location.tag}”.</p>
          ) : tab.location.kind === "screenshots" ? (
            <>
              <p>No images named “Screenshot…” were found.</p>
              <RescanButton busy={false} />
            </>
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
          onRowDoubleClick={activateEntry}
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
          onTileDoubleClick={activateEntry}
          onTileContextMenu={rowContextMenu}
          onTileMouseDown={onRowMouseDown}
          onKeyDown={onListKeyDown}
          onPointerDown={onPointerDown}
          iconSize={view.iconSize}
        />
      )}
      {searchRoot && (loading || searchTruncated) && (
        <div className="search-note" role="status">
          {loading
            ? tab.location.kind === "tags"
              ? "Finding tagged items…"
              : tab.location.kind === "screenshots"
                ? "Finding screenshots…"
              : "Searching subfolders…"
            : "Showing the first 5,000 matches. Refine your search to narrow it."}
        </div>
      )}
      {tab.location.kind === "screenshots" && !loading && display.length > 0 && (
        <div className="tags-note">
          <RescanButton busy={false} /> Searches your home folder for images named “Screenshot…”.
        </div>
      )}
      {marquee.active && <div className="marquee" aria-hidden ref={marquee.ref} />}
    </div>
  );
}

export function RescanButton({ busy }: { busy: boolean }) {
  return (
    <button className="btn ghost rescan" disabled={busy} onClick={() => refreshByUser()}>
      <ArrowClockwiseRegular /> {busy ? "Rescanning…" : "Rescan"}
    </button>
  );
}

export function ShotsLoading({ icon, label }: { icon: React.ReactElement; label: string }) {
  return (
    <div className="shots-loading" role="status">
      <div className="shots-status">
        {icon}
        <span className="shimmer-text">{label}</span>
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="skel-row" aria-hidden>
          <span className="sk-thumb" />
          <span className="sk-lines">
            <span />
            <span />
          </span>
          <span className="sk-meta" />
        </div>
      ))}
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
    // The lookup above can take time. Act on the selection as it is now.
    const tabs = useTabs.getState();
    const cur = tabs.tabs.find((t) => t.id === tabs.activeId);
    if (!cur) return;
    const appdata = useAppData.getState();
    const ui = useUI.getState();
    const isFavorite = appdata.favorites.some((f) => f.path === entry.path);
    const multi = cur.selection.length > 1 && cur.selection.includes(entry.path);
    const targets = multi ? [...cur.selection] : [entry.path];
    const commands: CommandSpec[] = [
      { key: "cut", label: "Cut (⌘X)", icon: <CutRegular />, onSelect: () => cutSelection() },
      { key: "copy", label: "Copy (⌘C)", icon: <CopyRegular />, onSelect: () => copySelection() },
      { key: "rename", label: multi ? "Rename… (F2)" : "Rename (F2)", icon: <EditRegular />, onSelect: () => startRename() },
      { key: "share", label: "Share", icon: <ShareIosRegular />, onSelect: () => shareItems(targets, pointAt(x, y)) },
      { key: "delete", label: "Move to Trash (⌘⌫)", icon: <DeleteRegular />, danger: true, onSelect: () => deleteSelection(false) },
    ];
    const inTrash = isTrashDir(parentOf(entry.path));
    const inResults =
      (tabs.deepSearch !== null &&
        cur.location.kind === "path" &&
        tabs.deepSearch === cur.location.path &&
        tabs.search.trim() !== "") ||
      cur.location.kind === "tags" ||
      cur.location.kind === "screenshots" ||
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
        keys: keysOf("open"),
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
      // Spreadsheets open in their own app. Doftar can still show their sheets.
      ...(!isFolder(entry) && isSheet(entry.ext)
        ? [
            {
              key: "preview-doftar",
              label: "Preview in Doftar",
              icon: <TableRegular />,
              onSelect: () => void openReaderFromListing(entry.path),
            },
          ]
        : []),
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
      ...(!multi && isFolder(entry)
        ? [
            {
              key: "tree",
              label: "Show folder tree",
              icon: <TextBulletListTreeRegular />,
              keys: keysOf("folder_tree"),
              onSelect: () => showFolderTree(entry.path),
            },
          ]
        : []),
      {
        key: "finder",
        label: "Reveal in Finder",
        icon: <WindowNewRegular />,
        keys: keysOf("reveal_in_finder"),
        onSelect: () => revealInFinder(targets),
      },
      { key: "d1", dividerBefore: true },
      ...(inTrash
        ? []
        : [
            {
              key: "duplicate",
              label: "Duplicate",
              icon: <DocumentCopyRegular />,
              keys: keysOf("duplicate"),
              onSelect: () => void duplicateSelection(targets),
            },
          ]),
      ...(inTrash
        ? []
        : [
            { key: "move-to", label: "Move to…", icon: <FolderArrowRightRegular />, onSelect: () => ui.openSendTo(targets, "move") },
            { key: "copy-to", label: "Copy to…", icon: <FolderAddRegular />, onSelect: () => ui.openSendTo(targets, "copy") },
            ...(multi
              ? [
                  {
                    key: "folder-with",
                    label: "New Folder with Selection",
                    icon: <FolderRegular />,
                    keys: keysOf("new_folder_selection"),
                    onSelect: () => void newFolderWithSelection(),
                  },
                ]
              : []),
          ]),
      {
        key: "compress",
        label: "Compress to ZIP",
        icon: <ArchiveRegular />,
        onSelect: () => void compressItems(targets),
      },
      ...(!multi && isExtractable(entry)
        ? [
            {
              key: "archive-contents",
              label: "Show contents",
              icon: <TextBulletListTreeRegular />,
              onSelect: () => showArchiveContents(entry.path),
            },
            {
              key: "extract",
              label: "Extract here",
              icon: <FolderZipRegular />,
              onSelect: () => void extractArchive(entry.path),
            },
          ]
        : []),
      {
        key: "copy-as",
        label: "Copy as",
        icon: <CopyRegular />,
        dividerBefore: true,
        items: [
          { key: "copy-path", label: "Path", icon: <CopyRegular />, keys: "⌥⌘C", onSelect: () => copyAsPath(targets) },
          { key: "copy-name", label: multi ? "Names" : "Name", icon: <TextTRegular />, onSelect: () => copyName(targets) },
        ],
      },
      {
        key: "fav",
        label: isFavorite ? "Remove from Favorites" : "Add to Favorites",
        icon: isFavorite ? <HeartFilled /> : <HeartRegular />,
        dividerBefore: true,
        onSelect: () => toggleFavoriteEntry(entry),
      },
      ...tagMenuItems(shown.length > 0 ? shown : [entry], false),
      ...terminalMenuItems(isFolder(entry) ? entry.path : parentOf(entry.path) ?? entry.path, true),
      {
        key: "props",
        label: "Properties",
        icon: <InfoRegular />,
        keys: keysOf("get_info"),
        onSelect: () => ui.openProperties(multi ? shown : entry),
      },
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
