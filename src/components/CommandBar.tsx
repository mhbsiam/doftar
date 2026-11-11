import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Menu,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MenuItem,
  MenuItemCheckbox,
  MenuItemRadio,
  MenuDivider,
  MenuGroup,
  MenuGroupHeader,
  Tooltip,
} from "@fluentui/react-components";
import {
  AddRegular,
  ArrowDownRegular,
  ClipboardPasteRegular,
  CopyRegular,
  CutRegular,
  DeleteRegular,
  EditRegular,
  ShareIosRegular,
  ArrowUpRegular,
  DocumentRegular,
  FilterRegular,
  FilterFilled,
  CalendarRegular,
  AppsListRegular,
  FolderRegular,
  GridRegular,
  ColumnTripleRegular,
  ColumnDoubleCompareRegular,
  TextBulletListRegular,
  PanelLeftRegular,
  PanelRightContractRegular,
  PanelRightExpandRegular,
  LayoutColumnTwoRegular,
  KeyCommandRegular,
  ClipboardClockRegular,
  ArrowUndoRegular,
  DeleteDismissRegular,
  DismissRegular,
  TagRegular,
} from "@fluentui/react-icons";
import { baseName, parentOf, toggleSplit, useActiveTab, usePanes, usePreviewOpen, useTabs } from "../stores/tabs";
import { useUI } from "../stores/ui";
import { TagDot, TagDots } from "./TagDots";
import { tagDots, tagFilterActive, tagKey } from "../util/tags";
import { DATE_RANGES, KIND_GROUPS, itemFilterActive, type ItemFilter } from "../util/itemFilter";
import { copiedAgo, entryLabel, useClipboard, type ClipEntry } from "../stores/clipboard";
import { placeName, summarize, useHistory, type HistoryEntry } from "../stores/history";
import { useAppData } from "../stores/appdata";
import type { Step } from "../types";
import { useSettings } from "../stores/settings";
import { useRovingFocus } from "../hooks/useRovingFocus";
import { ICON_SIZES } from "../hooks/useVirtual";
import {
  applyViewToAll,
  resetFolderView,
  setFolderView,
  useFolderView,
} from "../hooks/useFolderView";
import {
  comparablePair,
  compareSelectedFiles,
  copySelection,
  cutSelection,
  deleteSelection,
  newFile,
  newFolder,
  paste,
  pasteFromHistory,
  staleByEntry,
  undoFromLog,
  shareItems,
  startRename,
  togglePreview,
} from "../actions";
import type { GroupBy, SortKey, ViewMode } from "../types";

function CmdDivider() {
  return <span className="cmdiv" />;
}

// Text commands fold to icons in a narrow bar (`.commandbar` container queries).
// The label stays for assistive tech.
function CmdButton(props: {
  label: string;
  className?: string;
  icon: React.ReactNode;
  disabled?: boolean;
  pressed?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { label, icon, disabled, pressed, onClick, className } = props;
  return (
    <button
      className={`cmd horizontal foldable${className ? ` ${className}` : ""}`}
      title={label}
      disabled={disabled}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <span className="cmd-icon" aria-hidden>
        {icon}
      </span>
      <span className="lbl">{label}</span>
    </button>
  );
}

function PanelToggle() {
  return (
    <Tooltip content="Toggle navigation pane" relationship="label">
      <button
        className="cmd horizontal compact"
        title="Toggle navigation pane"
        aria-label="Toggle navigation pane"
        onClick={() => useTabs.getState().toggleNavPane()}
      >
        <PanelLeftRegular />
      </button>
    </Tooltip>
  );
}

function PreviewToggle() {
  const open = usePreviewOpen();
  const label = open ? "Hide preview" : "Show preview";
  const Icon = open ? PanelRightContractRegular : PanelRightExpandRegular;
  return (
    <Tooltip content={`${label} (⇧⌘P)`} relationship="label">
      <button
        className="cmd horizontal compact"
        aria-label="Preview"
        aria-pressed={open}
        aria-keyshortcuts="Meta+Shift+P"
        onClick={() => togglePreview()}
      >
        <Icon />
      </button>
    </Tooltip>
  );
}

function PaletteButton() {
  return (
    <Tooltip content="Command palette (⌘K)" relationship="label">
      <button
        className="cmd horizontal compact"
        aria-label="Command palette"
        aria-keyshortcuts="Meta+K"
        onClick={() => useUI.getState().setPaletteOpen(true)}
      >
        <KeyCommandRegular />
      </button>
    </Tooltip>
  );
}

const TIP_ITEMS = 20;

function ActivityItem({ e, stale }: { e: HistoryEntry; stale?: Step[] }) {
  const home = useAppData((s) => s.home);
  const live = useHistory((s) => s.undo.find((u) => u.id === e.id));
  const { items, from, to, renamed } = summarize(e);
  const first = items[0] ? baseName(items[0]) : "";
  const what = renamed
    ? `${first} → ${renamed}`
    : items.length > 1
      ? `${first} and ${items.length - 1} more`
      : first;
  const listed = items.length > TIP_ITEMS
    ? [...items.slice(0, TIP_ITEMS), `and ${items.length - TIP_ITEMS} more`]
    : items;
  const where = from && to && from !== to
    ? `${placeName(from, home)} → ${placeName(to, home)}`
    : placeName(to ?? from ?? "", home);
  const gone = live && stale && stale.length === live.steps.length;
  const status = e.steps.length === 0
    ? "Can't be undone"
    : live
      ? gone ? "Changed since" : "Undo"
      : e.undone
        ? "Undone"
        : "No longer undoable";
  const why = e.steps.length === 0
    ? "It was deleted permanently."
    : gone
      ? "Its items have changed, moved or been deleted since."
      : !live && !e.undone
        ? "It has left the undo history."
        : "";
  return (
    <MenuItem
      icon={e.steps.length === 0 ? <DeleteDismissRegular /> : <ArrowUndoRegular />}
      disabled={status !== "Undo"}
      secondaryContent={status === "Undo" ? status : undefined}
      title={[...listed, why].filter(Boolean).join("\n")}
      onClick={() => void undoFromLog(e.id)}
    >
      <span className="act-what">{what ? `${e.label}: ${what}` : e.label}</span>
      <span className="act-where">
        {/* Old entries have no time (0). */}
        {[status === "Undo" ? "" : status, where, e.at ? copiedAgo(e.at) : ""].filter(Boolean).join(" · ")}
      </span>
    </MenuItem>
  );
}

function ClipItem({ e, inFolder }: { e: ClipEntry; inFolder: boolean }) {
  return (
    <MenuItem
      icon={e.op === "cut" ? <CutRegular /> : <CopyRegular />}
      disabled={!inFolder}
      secondaryContent="Paste"
      title={e.paths.join("\n")}
      onClick={() => void pasteFromHistory(e)}
    >
      <span className="act-what">{`${e.op === "cut" ? "Cut" : "Copy"}: ${entryLabel(e)}`}</span>
      <span className="act-where">{`${baseName(parentOf(e.paths[0]) ?? "/")} · ${copiedAgo(e.at)}`}</span>
    </MenuItem>
  );
}

function ActivityButton({ inFolder }: { inFolder: boolean }) {
  const clips = useClipboard((s) => s.history);
  const log = useHistory((s) => s.log);
  const undo = useHistory((s) => s.undo);
  const busy = useHistory((s) => s.busy !== null);
  const open = useUI((s) => s.clipHistoryOpen);
  const setOpen = useUI((s) => s.setClipHistoryOpen);
  const [stale, setStale] = useState<Map<number, Step[]>>(new Map());
  const enabled = log.length > 0 || (inFolder && clips.length > 0);
  // With nothing to show, do not leave the menu set to open later.
  useEffect(() => {
    if (open && !enabled) setOpen(false);
  }, [open, enabled, setOpen]);
  // Check each time the menu opens. Files also change outside Doftar.
  useEffect(() => {
    if (!open) return;
    let current = true;
    void staleByEntry(undo).then((m) => current && setStale(m));
    return () => {
      current = false;
    };
  }, [open, undo]);
  const rows = [
    ...log.map((e) => ({ at: e.at, node: <ActivityItem key={`log:${e.id}`} e={e} stale={stale.get(e.id)} /> })),
    ...clips.map((e) => ({ at: e.at, node: <ClipItem key={`clip:${e.paths.join("\0")}`} e={e} inFolder={inFolder} /> })),
  ].sort((a, b) => b.at - a.at);
  return (
    <Menu open={open && enabled} onOpenChange={(_, d) => setOpen(d.open)}>
      <MenuTrigger disableButtonEnhancement>
        <Tooltip content="Activity (⌘⇧V)" relationship="label">
          <button
            className="cmd horizontal compact"
            aria-label="Activity"
            aria-keyshortcuts="Meta+Shift+V"
            disabled={!enabled}
          >
            <ClipboardClockRegular />
          </button>
        </Tooltip>
      </MenuTrigger>
      <MenuPopover className="clip-menu">
        <MenuList>
          <MenuGroup>
            <MenuGroupHeader>Activity</MenuGroupHeader>
            {rows.map((r) => r.node)}
          </MenuGroup>
          <MenuDivider />
          <MenuItem
            icon={<DismissRegular />}
            // A running undo still writes to the stacks that this clears.
            disabled={busy}
            onClick={() => {
              useClipboard.getState().clearHistory();
              useHistory.getState().clearLog();
            }}
          >
            Clear activity
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

function SortMenu() {
  const s = useFolderView();
  const setSort = (key: SortKey) =>
    setFolderView({
      sortKey: key,
      sortAsc: key === s.sortKey ? !s.sortAsc : true,
    });
  return (
    <Menu
      checkedValues={{
        sortKey: [s.sortKey],
        sortDir: [s.sortAsc ? "asc" : "desc"],
      }}
      onCheckedValueChange={(_, d) => {
        if (d.name === "sortKey") setSort(d.checkedItems[0] as SortKey);
        else setFolderView({ sortAsc: d.checkedItems[0] !== "desc" });
      }}
    >
      <MenuTrigger disableButtonEnhancement>
        <button
          className="cmd horizontal"
          disabled={s.locked}
          title={
            s.locked
              ? "This folder is always sorted by name"
              : `Sort options (${s.sortAsc ? "ascending" : "descending"})`
          }
        >
          <span className="lbl">Sort</span>
          {s.sortAsc ? (
            <ArrowUpRegular className="chev dir" />
          ) : (
            <ArrowDownRegular className="chev dir" />
          )}
        </button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {(
            [
              ["name", "Name"],
              ["modified", "Date modified"],
              ["created", "Date created"],
              ["type", "Type"],
              ["size", "Size"],
            ] as [SortKey, string][]
          ).map(([key, label]) => (
            <MenuItemRadio key={key} name="sortKey" value={key}>
              {label}
            </MenuItemRadio>
          ))}
          <MenuDivider />
          <MenuItemRadio name="sortDir" value="desc">
            Descending
          </MenuItemRadio>
          <MenuItemRadio name="sortDir" value="asc">
            Ascending
          </MenuItemRadio>
          <MenuDivider />
          <Menu
            checkedValues={{ groupBy: [s.groupBy] }}
            onCheckedValueChange={(_, d) => {
              const v = d.checkedItems[0] as GroupBy | undefined;
              if (v) setFolderView({ groupBy: v });
            }}
          >
            <MenuTrigger disableButtonEnhancement>
              <MenuItem secondaryContent={GROUP_BY.find(([key]) => key === s.groupBy)?.[1]}>
                Group by
              </MenuItem>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {GROUP_BY.map(([key, label]) => (
                  <MenuItemRadio key={key} name="groupBy" value={key}>
                    {label}
                  </MenuItemRadio>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

function ViewMenu() {
  const s = { ...useSettings(), ...useFolderView() };
  const options = [
    ...(s.showCheckboxes ? ["checkboxes"] : []),
    ...(s.showHidden ? ["hidden"] : []),
  ];
  const sizeLabel = ICON_SIZES.find(([px]) => px === s.iconSize)?.[1];
  return (
    <Menu
      checkedValues={{ viewMode: [s.viewMode], options }}
      onCheckedValueChange={(_, d) => {
        if (d.name === "viewMode") {
          setFolderView({ viewMode: (d.checkedItems[0] ?? "details") as ViewMode });
        } else {
          s.set({
            showCheckboxes: d.checkedItems.includes("checkboxes"),
            showHidden: d.checkedItems.includes("hidden"),
          });
        }
      }}
    >
      <MenuTrigger disableButtonEnhancement>
        <button className="cmd horizontal" title="View">
          <span className="lbl">View</span>
          {s.viewMode === "grid" ? (
            <GridRegular className="chev state" />
          ) : s.viewMode === "columns" ? (
            <ColumnTripleRegular className="chev state" />
          ) : (
            <TextBulletListRegular className="chev state" />
          )}
        </button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList hasCheckmarks>
          <MenuGroup>
            <MenuGroupHeader>Layout</MenuGroupHeader>
            <MenuItemRadio name="viewMode" value="grid">
              Icons
            </MenuItemRadio>
            <MenuItemRadio name="viewMode" value="details">
              List view
            </MenuItemRadio>
            <MenuItemRadio name="viewMode" value="columns">
              Columns
            </MenuItemRadio>
            <Menu
              checkedValues={{ iconSize: [String(s.iconSize)] }}
              onCheckedValueChange={(_, d) => {
                const v = d.checkedItems[0];
                // A size from another layout also switches to Icons.
                if (v) setFolderView({ viewMode: "grid", iconSize: Number(v) });
              }}
            >
              <MenuTrigger disableButtonEnhancement>
                <MenuItem secondaryContent={sizeLabel}>Icon size</MenuItem>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  {[...ICON_SIZES].reverse().map(([px, label]) => (
                    <MenuItemRadio key={px} name="iconSize" value={String(px)}>
                      {label}
                    </MenuItemRadio>
                  ))}
                </MenuList>
              </MenuPopover>
            </Menu>
          </MenuGroup>
          <MenuDivider />
          <MenuGroup>
            <MenuGroupHeader>Show</MenuGroupHeader>
            <MenuItemCheckbox name="options" value="checkboxes">
              Checkboxes
            </MenuItemCheckbox>
            <MenuItemCheckbox name="options" value="hidden">
              Hidden files
            </MenuItemCheckbox>
          </MenuGroup>
          <MenuDivider />
          <MenuGroup>
            <MenuGroupHeader>This folder</MenuGroupHeader>
            <MenuItem onClick={() => void applyViewToAll()}>Apply to all folders</MenuItem>
            <MenuItem disabled={!s.hasOverride} onClick={() => resetFolderView()}>
              Reset to default
            </MenuItem>
          </MenuGroup>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

const GROUP_BY: [GroupBy, string][] = [
  ["none", "None"],
  ["name", "Name"],
  ["created", "Date created"],
  ["type", "Type"],
  ["tags", "Tags"],
];

function FilterMenu() {
  const s = useSettings();
  const tab = useActiveTab();
  const folderTags = useTabs((s) => s.folderTags);
  const inFolder = tab.location.kind === "path";
  const tf = tab.tagFilter;
  const tagsOn = inFolder && tagFilterActive(tf);
  // The tags of the folder, plus picked tags that it does not have (found in subfolders).
  const offered = [...folderTags];
  for (const name of tf?.names ?? []) {
    if (!offered.some((o) => tagKey(o.tag.name) === tagKey(name))) {
      offered.push({ tag: { name, color: 0 }, count: 0 });
    }
  }
  const itf = tab.itemFilter;
  const itemOn = inFolder && itemFilterActive(itf);
  const setItem = (patch: Partial<ItemFilter>) =>
    useTabs.getState().setItemFilter({ kind: itf?.kind ?? null, modified: itf?.modified ?? null, ...patch });
  const pickedColors = tagsOn
    ? tagDots(offered.filter((o) => tf!.names.some((n) => tagKey(n) === tagKey(o.tag.name))).map((o) => o.tag))
    : [];
  return (
    <Menu
      checkedValues={{
        filter: [s.filter],
        tags: [...(tf?.any ? ["*"] : []), ...(tf?.names ?? []).map(tagKey)],
        tagOpts: tf?.deep ? ["deep"] : [],
      }}
      onCheckedValueChange={(_, d) => {
        const tabs = useTabs.getState();
        if (d.name === "filter") {
          const v = d.checkedItems[0];
          if (v === "all" || v === "folders" || v === "files") s.set({ filter: v });
        } else if (d.name === "tags") {
          const deep = tf?.deep ?? false;
          // "Any tag" and a particular tag exclude each other. The newest pick wins.
          if (d.checkedItems.includes("*") && !tf?.any) {
            tabs.setTagFilter({ names: [], any: true, deep });
            return;
          }
          const names = d.checkedItems
            .filter((k) => k !== "*")
            .map((k) => offered.find((o) => tagKey(o.tag.name) === k)?.tag.name ?? k);
          tabs.setTagFilter({ names, any: false, deep });
        } else if (d.name === "tagOpts") {
          tabs.setTagFilter({
            names: tf?.names ?? [],
            any: tf?.any ?? false,
            deep: d.checkedItems.includes("deep"),
          });
        }
      }}
    >
      <MenuTrigger disableButtonEnhancement>
        <button className="cmd horizontal" title="Filter">
          <span className="lbl">Filter</span>
          {pickedColors.length > 0 ? (
            <span className="chev state active filter-dots">
              <TagDots tags={pickedColors.map((c) => ({ name: "", color: c }))} />
            </span>
          ) : tagsOn ? (
            <TagRegular className="chev state active" />
          ) : itemOn ? (
            <FilterFilled className="chev state active" />
          ) : s.filter === "folders" ? (
            <FolderRegular className="chev state active" />
          ) : s.filter === "files" ? (
            <DocumentRegular className="chev state active" />
          ) : (
            <FilterRegular className="chev state" />
          )}
        </button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {(
            [
              ["all", "All items"],
              ["folders", "Folders only"],
              ["files", "Files only"],
            ] as const
          ).map(([key, label]) => (
            <MenuItemRadio key={key} name="filter" value={key}>
              {label}
            </MenuItemRadio>
          ))}
          {inFolder && (
            <>
              <MenuDivider />
              <Menu
                checkedValues={{ kind: [itf?.kind ?? "any"] }}
                onCheckedValueChange={(_, d) => {
                  const v = d.checkedItems[0];
                  setItem({ kind: KIND_GROUPS.find(([k]) => k === v)?.[0] ?? null });
                }}
              >
                <MenuTrigger disableButtonEnhancement>
                  <MenuItem
                    icon={<AppsListRegular />}
                    secondaryContent={KIND_GROUPS.find(([k]) => k === itf?.kind)?.[1]}
                  >
                    Kind
                  </MenuItem>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItemRadio name="kind" value="any">
                      Any kind
                    </MenuItemRadio>
                    {KIND_GROUPS.map(([key, label]) => (
                      <MenuItemRadio key={key} name="kind" value={key}>
                        {label}
                      </MenuItemRadio>
                    ))}
                  </MenuList>
                </MenuPopover>
              </Menu>
              <Menu
                checkedValues={{ modified: [itf?.modified ?? "any"] }}
                onCheckedValueChange={(_, d) => {
                  const v = d.checkedItems[0];
                  setItem({ modified: DATE_RANGES.find(([k]) => k === v)?.[0] ?? null });
                }}
              >
                <MenuTrigger disableButtonEnhancement>
                  <MenuItem
                    icon={<CalendarRegular />}
                    secondaryContent={DATE_RANGES.find(([k]) => k === itf?.modified)?.[1]}
                  >
                    Date modified
                  </MenuItem>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItemRadio name="modified" value="any">
                      Any time
                    </MenuItemRadio>
                    {DATE_RANGES.map(([key, label]) => (
                      <MenuItemRadio key={key} name="modified" value={key}>
                        {label}
                      </MenuItemRadio>
                    ))}
                  </MenuList>
                </MenuPopover>
              </Menu>
              {itemOn && (
                <MenuItem onClick={() => useTabs.getState().setItemFilter(null)}>
                  Clear kind and date
                </MenuItem>
              )}
              <MenuDivider />
              <MenuGroup>
                <MenuGroupHeader>Tags</MenuGroupHeader>
                {offered.length === 0 && (
                  <MenuItem disabled>No tags in this folder</MenuItem>
                )}
                {offered.map(({ tag, count }) => (
                  <MenuItemCheckbox
                    key={tagKey(tag.name)}
                    name="tags"
                    value={tagKey(tag.name)}
                    icon={<TagDot color={tag.color} />}
                    secondaryContent={count > 0 ? String(count) : undefined}
                  >
                    {tag.name}
                  </MenuItemCheckbox>
                ))}
                {offered.length > 0 && (
                  <MenuItemCheckbox name="tags" value="*" icon={<TagRegular />}>
                    Any tag
                  </MenuItemCheckbox>
                )}
              </MenuGroup>
              <MenuDivider />
              <MenuItemCheckbox name="tagOpts" value="deep">
                Include subfolders
              </MenuItemCheckbox>
              {tagsOn && (
                <MenuItem onClick={() => useTabs.getState().setTagFilter(null)}>
                  Clear tag filter
                </MenuItem>
              )}
            </>
          )}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

export function CommandBar() {
  const tab = useActiveTab();
  const selCount = tab.selection.length;
  const hasSelection = selCount > 0;
  const inFolder = tab.location.kind === "path";
  const split = usePanes((s) => s.split);
  const barRef = useRef<HTMLDivElement>(null);
  const roving = useRovingFocus(barRef, { selector: "button" });

  return (
    <div
      ref={barRef}
      className="commandbar"
      role="toolbar"
      aria-label="Commands"
      onFocus={roving.onFocus}
      onKeyDown={roving.onKeyDown}
    >
      <PanelToggle />
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button
            appearance="subtle"
            className="new-btn"
            icon={<AddRegular />}
            disabled={!inFolder}
          >
            <span className="lbl">New</span>
          </Button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem icon={<FolderRegular />} onClick={() => newFolder()}>
              Folder
            </MenuItem>
            <MenuItem icon={<DocumentRegular />} onClick={() => newFile()}>
              Text Document
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
      <CmdDivider />
      <CmdButton
        label="Copy"
        icon={<CopyRegular />}
        disabled={!hasSelection}
        onClick={() => copySelection()}
      />
      <CmdButton
        label="Rename"
        icon={<EditRegular />}
        disabled={!hasSelection}
        onClick={() => startRename()}
      />
      <CmdButton
        label="Cut"
        icon={<CutRegular />}
        disabled={!hasSelection}
        onClick={() => cutSelection()}
      />
      <CmdButton
        label="Paste"
        icon={<ClipboardPasteRegular />}
        // No files on the clipboard is fine: Paste then saves a copied image or text.
        disabled={!inFolder}
        onClick={() => paste()}
      />
      <CmdButton
        label="Delete"
        icon={<DeleteRegular />}
        disabled={!hasSelection}
        onClick={() => deleteSelection(false)}
      />
      <CmdDivider />
      <CmdButton
        className="fold-first"
        label="Split"
        icon={<LayoutColumnTwoRegular />}
        pressed={split}
        onClick={() => toggleSplit()}
      />
      <CmdDivider />
      <CmdButton
        label="Share"
        icon={<ShareIosRegular />}
        disabled={!hasSelection}
        onClick={(e) => shareItems(tab.selection, e.currentTarget)}
      />
      <CmdButton
        className="fold-first"
        label="Compare"
        icon={<ColumnDoubleCompareRegular />}
        disabled={!comparablePair(tab.selection)}
        onClick={() => compareSelectedFiles()}
      />
      <div className="cmd-right">
        <SortMenu />
        <ViewMenu />
        <FilterMenu />
        <CmdDivider />
        <PaletteButton />
        <ActivityButton inFolder={inFolder} />
        <PreviewToggle />
      </div>
    </div>
  );
}
