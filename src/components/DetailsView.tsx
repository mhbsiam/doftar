import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDownRegular } from "@fluentui/react-icons";
import { EntryIcon } from "./FileIcon";
import { TagDots } from "./TagDots";
import { useAppData } from "../stores/appdata";
import { formatSize, formatDate } from "../util/format";
import { isFolder, typeLabel } from "../util/kinds";
import { useFolderView } from "../hooks/useFolderView";
import { parentOf, usePane, useTabs } from "../stores/tabs";
import { useDropHover, useDropSpring } from "../stores/drag";
import { useIsCut } from "../stores/clipboard";
import { commitRename } from "../actions";
import { itemDomId, useRefocusAfterRename } from "../hooks/useListNav";
import { renameDraft, setRenameDraft } from "../util/renameDraft";
import { RenameError } from "./RenameError";
import {
  DETAILS_HEADER,
  useRevealRenaming,
  useVirtualWindow,
} from "../hooks/useVirtual";
import { useRowMotion } from "../hooks/useRowMotion";
import { useVisibleFileWatch } from "../hooks/useVisibleFileWatch";
import { rem } from "../util/textScale";
import type { Group } from "../util/layout";
import type { FileEntry, SortKey } from "../types";

interface Props {
  entries: FileEntry[];
  groups: Group[] | null;
  searchRoot?: string | null;
  scope: string;
  selected: ReadonlySet<string>;
  cursor: string | null;
  kbd: boolean;
  activeIndex: number;
  renaming: string | null;
  showChecks: boolean;
  onCheck: (entry: FileEntry) => void;
  onCheckAll: () => void;
  onRowClick: (e: React.MouseEvent, entry: FileEntry, index: number) => void;
  onRowDoubleClick: (entry: FileEntry) => void;
  onRowContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onRowMouseDown: (e: React.MouseEvent, entry: FileEntry) => void;
  onHeaderClick: (key: SortKey) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onPointerDown: () => void;
}

const COLUMNS: [SortKey, string][] = [
  ["name", "Name"],
  ["modified", "Date modified"],
  ["type", "Type"],
  ["size", "Size"],
];

export function DetailsView(props: Props) {
  const {
    searchRoot,
    entries,
    groups,
    scope,
    selected,
    cursor,
    kbd,
    activeIndex,
    renaming,
    showChecks,
    onCheck,
    onCheckAll,
    onRowClick,
    onRowDoubleClick,
    onRowContextMenu,
    onRowMouseDown,
    onHeaderClick,
    onKeyDown,
    onPointerDown,
  } = props;
  const allRef = useRef<HTMLInputElement>(null);
  // Count the visible rows that are selected: the selection may still hold
  // rows a view filter has hidden.
  const selectedShown = useMemo(
    () => entries.reduce((n, e) => n + (selected.has(e.path) ? 1 : 0), 0),
    [entries, selected]
  );
  const allSelected = entries.length > 0 && selectedShown === entries.length;
  useEffect(() => {
    if (allRef.current) {
      allRef.current.indeterminate = selectedShown > 0 && !allSelected;
    }
  }, [selectedShown, allSelected, showChecks]);
  const { sortKey, sortAsc } = useFolderView();
  const pane = usePane();
  const listRef = useRef<HTMLDivElement>(null);
  useRefocusAfterRename(listRef, renaming);
  const win = useVirtualWindow(listRef, entries.length, false, groups);
  useRevealRenaming(listRef, entries, renaming, false);
  useVisibleFileWatch(entries, win.first, win.last);
  const ghostRef = useRef<HTMLDivElement>(null);
  useRowMotion({ listRef, ghostRef, entries, win, scope, grid: false });

  const gliderIndex = useMemo(
    () =>
      selected.size === 1 ? entries.findIndex((e) => selected.has(e.path)) : -1,
    [entries, selected],
  );
  const glided = useRef(false);
  const glideInstant = gliderIndex >= 0 && !glided.current;
  useEffect(() => {
    glided.current = gliderIndex >= 0;
  }, [gliderIndex]);

  const { rows } = win.layout;
  const gliderRow = gliderIndex >= 0 ? rows[win.layout.rowOf[gliderIndex]] : undefined;
  const body: ReactNode[] = [];
  for (let r = win.firstRow; r < Math.min(win.lastRow, rows.length); r++) {
    const row = rows[r];
    if (row.group) {
      body.push(
        <GroupHeader key={`group:${row.group.key}`} group={row.group} entries={entries} rowIndex={r} />
      );
      continue;
    }
    for (let i = row.start; i < row.end; i++) {
      const entry = entries[i];
      if (!entry) continue;
      body.push(
        <DetailRow
          key={entry.path}
          entry={entry}
          index={i}
          rowIndex={r}
          selected={selected.has(entry.path)}
          cursor={cursor === entry.path}
          renaming={renaming === entry.path}
          showChecks={showChecks}
          where={searchRoot ? relativeParent(searchRoot, entry.path) : undefined}
          onCheck={onCheck}
          onRowClick={onRowClick}
          onRowDoubleClick={onRowDoubleClick}
          onRowContextMenu={onRowContextMenu}
          onRowMouseDown={onRowMouseDown}
        />
      );
    }
  }
  const lastShown = rows[Math.min(win.lastRow, rows.length) - 1];

  return (
    <div
      ref={listRef}
      className={`dtable${kbd ? " kbd" : ""}${gliderIndex >= 0 ? " has-glider" : ""}`}
      role="grid"
      aria-label="Files and folders"
      aria-multiselectable="true"
      aria-rowcount={rows.length + 1}
      aria-activedescendant={
        activeIndex >= 0 ? itemDomId(activeIndex, pane) : undefined
      }
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={onPointerDown}
    >
      <div
        className={`glider${gliderIndex >= 0 ? " on" : ""}${glideInstant ? " instant" : ""}`}
        aria-hidden
        style={{
          transform: `translateY(${rem(DETAILS_HEADER + (gliderRow?.top ?? 0))})`,
        }}
      />
      <div ref={ghostRef} className="ghosts" aria-hidden />
      <div className="dhead" role="row" aria-rowindex={1}>
        {COLUMNS.map(([key, label]) => (
          <div
            key={key}
            className="dhead-col"
            role="columnheader"
            aria-sort={
              sortKey === key ? (sortAsc ? "ascending" : "descending") : "none"
            }
          >
            {key === "name" && showChecks && (
              <span className="dhead-check">
                <input
                  ref={allRef}
                  type="checkbox"
                  className="rowcheck"
                  checked={allSelected}
                  aria-label="Select all items"
                  tabIndex={-1}
                  onChange={onCheckAll}
                />
              </span>
            )}
            <button className="dhead-cell" onClick={() => onHeaderClick(key)}>
              {sortKey === key && (
                <span className={`dhead-sort${sortAsc ? " asc" : ""}`} aria-hidden>
                  <ChevronDownRegular />
                </span>
              )}
              {label}
            </button>
          </div>
        ))}
      </div>
      <div
        className="vspacer"
        aria-hidden
        style={{ height: rem(rows[win.firstRow]?.top ?? 0) }}
      />
      {body}
      <div
        className="vspacer"
        aria-hidden
        style={{
          height: rem(
            lastShown ? Math.max(0, win.layout.total - (lastShown.top + lastShown.height)) : 0
          ),
        }}
      />
    </div>
  );
}

function GroupHeader({
  group,
  entries,
  rowIndex,
}: {
  group: Group;
  entries: FileEntry[];
  rowIndex: number;
}) {
  return (
    <div
      className="dgroup"
      role="row"
      aria-rowindex={rowIndex + 2}
      title="Select all in group"
      onClick={(e) => {
        e.stopPropagation();
        const paths = entries.slice(group.start, group.start + group.count).map((x) => x.path);
        useTabs.getState().setSelection(paths, paths[0] ?? null);
      }}
    >
      <div className="dgroup-label" role="gridcell" aria-colspan={4}>
        {group.label}
        <span className="dgroup-count">{group.count}</span>
      </div>
    </div>
  );
}

const DetailRow = memo(function DetailRow(props: {
  entry: FileEntry;
  index: number;
  rowIndex: number;
  selected: boolean;
  cursor: boolean;
  renaming: boolean;
  showChecks: boolean;
  where?: string;
  onCheck: Props["onCheck"];
  onRowClick: Props["onRowClick"];
  onRowDoubleClick: Props["onRowDoubleClick"];
  onRowContextMenu: Props["onRowContextMenu"];
  onRowMouseDown: Props["onRowMouseDown"];
}) {
  const {
    entry,
    index,
    rowIndex,
    selected,
    cursor,
    renaming,
    showChecks,
    where,
    onCheck,
    onRowClick,
    onRowDoubleClick,
    onRowContextMenu,
    onRowMouseDown,
  } = props;
  const pane = usePane();
  const dropKey = isFolder(entry) ? `row|path:${entry.path}` : undefined;
  const dropHover = useDropHover(dropKey);
  const springMs = useDropSpring(dropKey);
  const cut = useIsCut(entry.path);
  return (
    <div
      id={itemDomId(index, pane)}
      role="row"
      aria-rowindex={rowIndex + 2}
      aria-selected={selected}
      className={`drow${selected ? " selected" : ""}${cursor && selected ? " cursor" : ""}${dropHover ? " drop-hover" : ""}${springMs ? " spring" : ""}${cut ? " cut" : ""}`}
      style={springMs ? ({ "--wf-spring": `${springMs}ms` } as CSSProperties) : undefined}
      data-drop={dropKey}
      onMouseDown={(e) => onRowMouseDown(e, entry)}
      onClick={(e) => onRowClick(e, entry, index)}
      onDoubleClick={() => onRowDoubleClick(entry)}
      onContextMenu={(e) => onRowContextMenu(e, entry)}
    >
      <div className="dcell name" role="gridcell">
        {showChecks && (
          <input
            type="checkbox"
            className="rowcheck"
            checked={selected}
            aria-label={`Select ${entry.name}`}
            tabIndex={-1}
            onChange={() => onCheck(entry)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          />
        )}
        <EntryIcon entry={entry} size={24} />
        {renaming ? (
          <RenameInput entry={entry} />
        ) : (
          <span className="name-text" title={where ? entry.path : entry.name}>
            {entry.name}
            {where && <span className="name-where"> in {where}</span>}
          </span>
        )}
        {!renaming && <TagDots tags={entry.tags} />}
      </div>
      <div className="dcell" role="gridcell">
        {formatDate(entry.modifiedMs)}
      </div>
      <div className="dcell" role="gridcell">
        {typeLabel(entry)}
      </div>
      <div className="dcell" role="gridcell">
        {entry.isDir ? "" : formatSize(entry.size)}
      </div>
    </div>
  );
});

function relativeParent(root: string, path: string): string {
  const parent = parentOf(path) ?? "";
  if (root === "/") {
    // Results from anywhere (tag pages): the whole folder, home as "~".
    const home = useAppData.getState().home;
    return home && (parent === home || parent.startsWith(home + "/"))
      ? "~" + parent.slice(home.length)
      : parent;
  }
  return parent.startsWith(root + "/") ? parent.slice(root.length + 1) : "";
}

function RenameInput({ entry }: { entry: FileEntry }) {
  const draft = renameDraft(entry.path);
  const [value, setValue] = useState(draft ?? entry.name);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (draft !== undefined) {
      // Remounted after being scrolled out of the virtual window: keep the
      // user's text and caret rather than re-selecting the name.
      el.setSelectionRange(draft.length, draft.length);
      return;
    }
    const stem = entry.name.lastIndexOf(".");
    el.setSelectionRange(
      0,
      isFolder(entry) || stem <= 0 ? entry.name.length : stem,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.name, entry.isDir, entry.isPackage]);

  return (
    <span className="rename-wrap">
      <input
        ref={ref}
        className="rename-input"
        aria-label={`Rename ${entry.name}`}
        aria-invalid={error !== null}
        aria-describedby={error ? "wf-rename-error" : undefined}
        value={value}
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value);
          setRenameDraft(entry.path, e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter")
            setError(commitRename(entry.path, value, { keepOpen: true }));
          if (e.key === "Escape") {
            e.preventDefault();
            useTabs.getState().setRenaming(null);
          }
        }}
        onBlur={() => commitRename(entry.path, value)}
      />
      <RenameError error={error} />
    </span>
  );
}
