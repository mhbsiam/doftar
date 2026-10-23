import { memo, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { renameDraft, setRenameDraft } from "../util/renameDraft";
import { TagDots } from "./TagDots";
import { EntryIcon } from "./FileIcon";
import { useVisibleFileWatch } from "../hooks/useVisibleFileWatch";
import { commitRename } from "../actions";
import { usePane, useTabs } from "../stores/tabs";
import { useDropHover, useDropSpring } from "../stores/drag";
import { useIsCut } from "../stores/clipboard";
import { itemDomId, useRefocusAfterRename } from "../hooks/useListNav";
import { RenameError } from "./RenameError";
import {
  GRID_PAD_BOTTOM,
  GRID_PAD_TOP,
  useRevealRenaming,
  useVirtualWindow,
} from "../hooks/useVirtual";
import { useRowMotion } from "../hooks/useRowMotion";
import { useTileGlider } from "../hooks/useTileGlider";
import { rem } from "../util/textScale";
import type { Group } from "../util/layout";
import type { FileEntry } from "../types";
import { isFolder } from "../util/kinds";

interface Props {
  entries: FileEntry[];
  groups: Group[] | null;
  scope: string;
  selected: ReadonlySet<string>;
  cursor: string | null;
  kbd: boolean;
  activeIndex: number;
  renaming: string | null;
  showChecks: boolean;
  onCheck: (entry: FileEntry) => void;
  onTileClick: (e: React.MouseEvent, entry: FileEntry, index: number) => void;
  onTileDoubleClick: (entry: FileEntry) => void;
  onTileContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onTileMouseDown: (e: React.MouseEvent, entry: FileEntry) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onPointerDown: () => void;
}

export function GridView(props: Props) {
  const {
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
    onTileClick,
    onTileDoubleClick,
    onTileContextMenu,
    onTileMouseDown,
    onKeyDown,
    onPointerDown,
  } = props;
  const pane = usePane();
  const listRef = useRef<HTMLDivElement>(null);
  useRefocusAfterRename(listRef, renaming);
  const win = useVirtualWindow(listRef, entries.length, true, groups);
  useVisibleFileWatch(entries, win.first, win.last);
  useRevealRenaming(listRef, entries, renaming, true);
  const ghostRef = useRef<HTMLDivElement>(null);
  useRowMotion({ listRef, ghostRef, entries, win, scope, grid: true });
  const gliderRef = useRef<HTMLDivElement>(null);
  const gliderIndex = useMemo(
    () =>
      selected.size === 1 ? entries.findIndex((e) => selected.has(e.path)) : -1,
    [entries, selected],
  );
  useTileGlider(listRef, gliderRef, gliderIndex, win);
  const { rows, total } = win.layout;
  const shownEnd = Math.min(win.lastRow, rows.length);
  const lastShown = rows[shownEnd - 1];

  const body: ReactNode[] = [];
  for (let r = win.firstRow; r < shownEnd; r++) {
    const row = rows[r];
    if (row.group) {
      const group = row.group;
      body.push(
        <div
          key={`group:${group.key}`}
          className="ggroup"
          title="Select all in group"
          onClick={(e) => {
            e.stopPropagation();
            const paths = entries
              .slice(group.start, group.start + group.count)
              .map((x) => x.path);
            useTabs.getState().setSelection(paths, paths[0] ?? null);
          }}
        >
          {group.label}
          <span className="dgroup-count">{group.count}</span>
        </div>
      );
      continue;
    }
    for (let i = row.start; i < row.end; i++) {
      const entry = entries[i];
      if (!entry) continue;
      body.push(
        <GridTile
          key={entry.path}
          entry={entry}
          index={i}
          count={entries.length}
          selected={selected.has(entry.path)}
          cursor={cursor === entry.path}
          renaming={renaming === entry.path}
          showChecks={showChecks}
          onCheck={onCheck}
          onTileClick={onTileClick}
          onTileDoubleClick={onTileDoubleClick}
          onTileContextMenu={onTileContextMenu}
          onTileMouseDown={onTileMouseDown}
        />
      );
    }
  }

  return (
    <div
      ref={listRef}
      className={`gview${kbd ? " kbd" : ""}${gliderIndex >= 0 ? " has-glider" : ""}`}
      role="listbox"
      aria-label="Files and folders"
      aria-multiselectable="true"
      aria-activedescendant={
        activeIndex >= 0 ? itemDomId(activeIndex, pane) : undefined
      }
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={onPointerDown}
      style={{
        paddingTop: rem(GRID_PAD_TOP + (rows[win.firstRow]?.top ?? 0)),
        paddingBottom: rem(
          GRID_PAD_BOTTOM +
            (lastShown ? Math.max(0, total - (lastShown.top + lastShown.height)) : 0),
        ),
      }}
    >
      <div ref={gliderRef} className="glider" aria-hidden />
      <div ref={ghostRef} className="ghosts" aria-hidden />
      {body}
    </div>
  );
}

const GridTile = memo(function GridTile(props: {
  entry: FileEntry;
  index: number;
  count: number;
  selected: boolean;
  cursor: boolean;
  renaming: boolean;
  showChecks: boolean;
  onCheck: Props["onCheck"];
  onTileClick: Props["onTileClick"];
  onTileDoubleClick: Props["onTileDoubleClick"];
  onTileContextMenu: Props["onTileContextMenu"];
  onTileMouseDown: Props["onTileMouseDown"];
}) {
  const {
    entry,
    index,
    count,
    selected,
    cursor,
    renaming,
    showChecks,
    onCheck,
    onTileClick,
    onTileDoubleClick,
    onTileContextMenu,
    onTileMouseDown,
  } = props;
  const pane = usePane();
  const dropKey = isFolder(entry) ? `row|path:${entry.path}` : undefined;
  const dropHover = useDropHover(dropKey);
  const springMs = useDropSpring(dropKey);
  const cut = useIsCut(entry.path);
  return (
    <div
      id={itemDomId(index, pane)}
      role="option"
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={count}
      className={`gtile${selected ? " selected" : ""}${cursor && selected ? " cursor" : ""}${dropHover ? " drop-hover" : ""}${springMs ? " spring" : ""}${cut ? " cut" : ""}`}
      style={springMs ? ({ "--wf-spring": `${springMs}ms` } as CSSProperties) : undefined}
      data-drop={dropKey}
      onMouseDown={(e) => onTileMouseDown(e, entry)}
      onClick={(e) => onTileClick(e, entry, index)}
      onDoubleClick={() => onTileDoubleClick(entry)}
      onContextMenu={(e) => onTileContextMenu(e, entry)}
      title={entry.name}
    >
      {showChecks && (
        <input
          type="checkbox"
          className="rowcheck tilecheck"
          checked={selected}
          aria-label={`Select ${entry.name}`}
          tabIndex={-1}
          onChange={() => onCheck(entry)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      )}
      <EntryIcon entry={entry} size={72} />
      {renaming ? (
        <GridRenameInput entry={entry} />
      ) : (
        <span className="gname">
          <TagDots tags={entry.tags} />
          {entry.name}
        </span>
      )}
    </div>
  );
});

function GridRenameInput({ entry }: { entry: FileEntry }) {
  const [error, setError] = useState<string | null>(null);
  const draft = renameDraft(entry.path);
  return (
    <span className="rename-wrap">
      <input
        className="rename-input grid"
        aria-label={`Rename ${entry.name}`}
        aria-invalid={error !== null}
        aria-describedby={error ? "wf-rename-error" : undefined}
        onChange={(e) => {
          setRenameDraft(entry.path, e.target.value);
          setError(null);
        }}
        defaultValue={draft ?? entry.name}
        autoFocus
        spellCheck={false}
        onFocus={(e) => {
          if (draft !== undefined) {
            e.target.setSelectionRange(draft.length, draft.length);
            return;
          }
          const stem = entry.name.lastIndexOf(".");
          e.target.setSelectionRange(
            0,
            isFolder(entry) || stem <= 0 ? entry.name.length : stem,
          );
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            setError(
              commitRename(entry.path, e.currentTarget.value, {
                keepOpen: true,
              }),
            );
          }
          if (e.key === "Escape") {
            e.preventDefault();
            useTabs.getState().setRenaming(null);
          }
        }}
        onBlur={(e) => commitRename(entry.path, e.currentTarget.value)}
      />
      <RenameError error={error} />
    </span>
  );
}
