import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronRightRegular } from "@fluentui/react-icons";
import { EntryIcon, newThumbId } from "./FileIcon";
import { TagDots } from "./TagDots";
import { GitBadge } from "./GitBadge";
import { CloudMark } from "./CloudMark";
import { FreshMark } from "./FreshMark";
import { RenameInput } from "./DetailsView";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../ipc";
import { activateEntry } from "../actions";
import { useAppData } from "../stores/appdata";
import { useDateFormat, useSettings } from "../stores/settings";
import { baseName, parentOf, usePane, useTabs } from "../stores/tabs";
import { useDropHover, useDropSpring } from "../stores/drag";
import { useIsCut } from "../stores/clipboard";
import { useFolderView } from "../hooks/useFolderView";
import { itemDomId, useRefocusAfterRename } from "../hooks/useListNav";
import { formatDate, formatSize } from "../util/format";
import { sortEntries } from "../util/grouping";
import { isFolder, typeLabel } from "../util/kinds";
import type { FileEntry } from "../types";

interface Props {
  dir: string;
  entries: FileEntry[];
  /** Unfiltered listing. Used when this folder becomes a left column. */
  listing: FileEntry[];
  selected: ReadonlySet<string>;
  kbd: boolean;
  cursor: string | null;
  activeIndex: number;
  renaming: string | null;
  onRowClick: (e: React.MouseEvent, entry: FileEntry, index: number) => void;
  onRowContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onRowMouseDown: (e: React.MouseEvent, entry: FileEntry) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onPointerDown: () => void;
}

/** Finder column view. The open folder is the live column, so keys and commands work as in other views. */
export function ColumnView(props: Props) {
  const { dir, entries, listing, selected, kbd, cursor, activeIndex, renaming } = props;
  const pane = usePane();
  const home = useAppData((s) => s.home);
  const showHidden = useSettings((s) => s.showHidden);
  const tick = useTabs((s) => s.refreshTick);
  const { sortKey, sortAsc } = useFolderView();

  // Folders under home start from home. Others start from the disk root.
  const trail = useMemo(() => {
    const root = home && (dir === home || dir.startsWith(home + "/")) ? home : "/";
    const out: string[] = [];
    for (let p = parentOf(dir); p !== null && (root === "/" || p === root || p.startsWith(root + "/")); p = parentOf(p)) {
      out.unshift(p);
    }
    return out;
  }, [dir, home]);

  const single = useMemo(() => {
    if (selected.size !== 1) return null;
    return entries.find((e) => selected.has(e.path)) ?? null;
  }, [entries, selected]);
  const preview = single && isFolder(single) ? single.path : null;

  const dirs = useMemo(() => (preview ? [...trail, preview] : trail), [trail, preview]);
  const lists = useListings(dirs, dir, listing, showHidden, tick);
  const sorted = useMemo(() => {
    const out: Record<string, FileEntry[]> = {};
    for (const d of dirs) if (lists[d]) out[d] = sortEntries(lists[d], sortKey, sortAsc);
    return out;
  }, [dirs, lists, sortKey, sortAsc]);

  const viewRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useRefocusAfterRename(listRef, renaming);

  // Keep keyboard focus here when the user clicks a column to the left.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || viewRef.current?.contains(active)) {
      listRef.current?.focus({ preventScroll: true });
    }
    listRef.current?.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  }, [dir]);

  useLayoutEffect(() => {
    viewRef.current?.lastElementChild?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [dir, preview, single]);

  useEffect(() => {
    if (activeIndex >= 0) {
      document.getElementById(itemDomId(activeIndex, pane))?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, pane]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.target === e.currentTarget && !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) {
      const tabs = useTabs.getState();
      if (e.key === "ArrowLeft" && trail.length > 0) {
        e.preventDefault();
        tabs.reveal(dir);
        return;
      }
      if (e.key === "ArrowRight" && preview) {
        e.preventDefault();
        const first = sorted[preview]?.[0];
        if (first) tabs.reveal(first.path);
        else tabs.navigate({ kind: "path", path: preview });
        return;
      }
    }
    props.onKeyDown(e);
  };

  return (
    <div ref={viewRef} className="cview">
      {trail.map((d, i) => (
        <OtherColumn key={d} dir={d} entries={sorted[d]} on={trail[i + 1] ?? dir} />
      ))}
      <div
        ref={listRef}
        className={`ccol live${kbd ? " kbd" : ""}`}
        role="listbox"
        aria-label={baseName(dir)}
        aria-multiselectable="true"
        aria-activedescendant={activeIndex >= 0 ? itemDomId(activeIndex, pane) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseDown={props.onPointerDown}
      >
        {/* shortcut: no row virtualization. Add it if huge folders lag. */}
        {entries.map((entry, i) => (
          <ColumnRow
            key={entry.path}
            entry={entry}
            id={itemDomId(i, pane)}
            index={i}
            selected={selected.has(entry.path)}
            cursor={cursor === entry.path}
            renaming={renaming === entry.path}
            onClick={props.onRowClick}
            onContextMenu={props.onRowContextMenu}
            onMouseDown={props.onRowMouseDown}
          />
        ))}
      </div>
      {preview ? (
        <OtherColumn key={preview} dir={preview} entries={sorted[preview]} on={null} />
      ) : (
        single && <FileSummary key={single.path} entry={single} />
      )}
    </div>
  );
}

/** Listings of the other columns. Read when a column comes into view, then kept. */
function useListings(dirs: string[], live: string, liveRows: FileEntry[], showHidden: boolean, tick: number) {
  const [lists, setLists] = useState<Record<string, FileEntry[]>>({});
  const version = `${showHidden}|${tick}`;
  const asked = useRef({ version, dirs: new Set<string>() });

  useEffect(() => {
    setLists((m) => (m[live] === liveRows ? m : { ...m, [live]: liveRows }));
  }, [live, liveRows]);

  const key = dirs.join("\n");
  useEffect(() => {
    if (asked.current.version !== version) asked.current = { version, dirs: new Set() };
    const mine = asked.current;
    const want = new Set(dirs);
    for (const d of mine.dirs) if (!want.has(d)) mine.dirs.delete(d);
    setLists((m) => {
      const next: Record<string, FileEntry[]> = {};
      for (const d of [...want, live]) if (m[d]) next[d] = m[d];
      return next;
    });
    for (const d of dirs) {
      if (mine.dirs.has(d)) continue;
      mine.dirs.add(d);
      void api
        .listDir(d, showHidden)
        .catch(() => [] as FileEntry[])
        .then((rows) => {
          if (asked.current === mine && mine.dirs.has(d)) setLists((m) => ({ ...m, [d]: rows }));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);

  return lists;
}

function OtherColumn({ dir, entries, on }: { dir: string; entries?: FileEntry[]; on: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const loaded = entries !== undefined;
  useLayoutEffect(() => {
    ref.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [on, loaded]);
  return (
    <div ref={ref} className="ccol" role="list" aria-label={baseName(dir)}>
      {entries?.map((entry) => (
        <ColumnRow
          key={entry.path}
          entry={entry}
          on={entry.path === on}
          onClick={() => useTabs.getState().reveal(entry.path)}
          onDoubleClick={() => activateEntry(entry)}
        />
      ))}
    </div>
  );
}

const ColumnRow = memo(function ColumnRow(props: {
  entry: FileEntry;
  /** Live column only. */
  id?: string;
  index?: number;
  selected?: boolean;
  cursor?: boolean;
  renaming?: boolean;
  /** True if the row is on the path to the open folder. */
  on?: boolean;
  onClick: (e: React.MouseEvent, entry: FileEntry, index: number) => void;
  onDoubleClick?: (entry: FileEntry) => void;
  onContextMenu?: (e: React.MouseEvent, entry: FileEntry) => void;
  onMouseDown?: (e: React.MouseEvent, entry: FileEntry) => void;
}) {
  const { entry, id, index = -1, selected, cursor, renaming, on } = props;
  const folder = isFolder(entry);
  const dropKey = folder ? `row|path:${entry.path}` : undefined;
  const dropHover = useDropHover(dropKey);
  const springMs = useDropSpring(dropKey);
  const cut = useIsCut(entry.path);
  return (
    <div
      id={id}
      role={id ? "option" : "listitem"}
      aria-selected={id ? !!selected : undefined}
      aria-current={on || undefined}
      className={`crow${selected ? " selected" : ""}${on ? " on" : ""}${cursor && selected ? " cursor" : ""}${dropHover ? " drop-hover" : ""}${springMs ? " spring" : ""}${cut ? " cut" : ""}`}
      style={springMs ? ({ "--wf-spring": `${springMs}ms` } as CSSProperties) : undefined}
      data-drop={dropKey}
      onMouseDown={props.onMouseDown && ((e) => props.onMouseDown!(e, entry))}
      onClick={(e) => props.onClick(e, entry, index)}
      onDoubleClick={() => (props.onDoubleClick ?? activateEntry)(entry)}
      onContextMenu={props.onContextMenu && ((e) => props.onContextMenu!(e, entry))}
    >
      <EntryIcon entry={entry} size={20} />
      {renaming ? (
        <RenameInput entry={entry} />
      ) : (
        <span className="name-text" title={entry.name}>
          {entry.name}
        </span>
      )}
      {!renaming && <FreshMark entry={entry} />}
      {!renaming && <GitBadge entry={entry} />}
      {!renaming && <CloudMark entry={entry} />}
      {!renaming && <TagDots tags={entry.tags} />}
      {folder && !renaming && <ChevronRightRegular className="crow-chev" aria-hidden />}
    </div>
  );
});

/** Quick Look picture size for the last column. */
const SUMMARY_PX = 480;

function FileSummary({ entry }: { entry: FileEntry }) {
  useDateFormat();
  const externalThumbs = useSettings((s) => s.externalThumbnails);
  const [picture, setPicture] = useState<string | null>(null);
  useEffect(() => {
    setPicture(null);
    // A cloud file with no local data would be downloaded to draw it.
    if (entry.isDataless || (!externalThumbs && entry.path.startsWith("/Volumes/"))) return;
    let live = true;
    let replied = false;
    const id = newThumbId();
    api
      .thumbnail(entry.path, SUMMARY_PX, id)
      .then((file) => live && setPicture(convertFileSrc(file)))
      .catch(() => {})
      .finally(() => (replied = true));
    return () => {
      live = false;
      // Arrowing through files must not leave a queue of renders.
      if (!replied) void api.cancelThumbnail(id).catch(() => {});
    };
  }, [entry.path, entry.modifiedMs, entry.isDataless, externalThumbs]);
  return (
    <div className="ccol csummary">
      {picture ? (
        <img className="csummary-picture" src={picture} alt="" onError={() => setPicture(null)} />
      ) : (
        <EntryIcon entry={entry} size={96} />
      )}
      <div className="csummary-name">{entry.name}</div>
      <div className="csummary-meta">
        {typeLabel(entry)}
        {entry.isDir ? "" : ` · ${formatSize(entry.size)}`}
      </div>
      <div className="csummary-meta">Modified {formatDate(entry.modifiedMs)}</div>
    </div>
  );
}
