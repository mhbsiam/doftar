import type React from "react";
import { useRef } from "react";
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
  RenameRegular,
  ShareIosRegular,
  ArrowUpRegular,
  DocumentRegular,
  FilterRegular,
  FolderRegular,
  GridRegular,
  GroupListRegular,
  TextBulletListRegular,
  PanelLeftRegular,
  PanelRightRegular,
  SplitVerticalRegular,
  TagRegular,
} from "@fluentui/react-icons";
import { toggleSplit, useActiveTab, usePane, usePanes, useTabs } from "../stores/tabs";
import { TagDot, TagDots } from "./TagDots";
import { tagDots, tagFilterActive, tagKey } from "../util/tags";
import { useClipboard } from "../stores/clipboard";
import { useSettings } from "../stores/settings";
import { useRovingFocus } from "../hooks/useRovingFocus";
import {
  applyViewToAll,
  resetFolderView,
  setFolderView,
  useFolderView,
} from "../hooks/useFolderView";
import {
  copySelection,
  cutSelection,
  deleteSelection,
  newFile,
  newFolder,
  paste,
  shareItems,
  startRename,
} from "../actions";
import type { GroupBy, SortKey } from "../types";

function CmdDivider() {
  return <span className="cmdiv" />;
}

// Text commands; when the bar runs out of room they fold to icons (see
// `.commandbar` container queries), keeping the label for assistive tech.
function CmdButton(props: {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { label, icon, disabled, onClick } = props;
  return (
    <button
      className="cmd horizontal foldable"
      title={label}
      disabled={disabled}
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
  // The right half of a split keeps its navigation pane on the right.
  const mirrored = usePane() === 1;
  return (
    <Tooltip content="Toggle navigation pane" relationship="label">
      <button
        className="cmd horizontal compact"
        title="Toggle navigation pane"
        aria-label="Toggle navigation pane"
        onClick={() => useTabs.getState().toggleNavPane()}
      >
        {mirrored ? <PanelRightRegular /> : <PanelLeftRegular />}
      </button>
    </Tooltip>
  );
}

function SplitToggle() {
  const split = usePanes((s) => s.split);
  const label = split ? "Close split view" : "Split view";
  return (
    <Tooltip content={`${label} (⌘\\)`} relationship="label">
      <button
        className={`cmd horizontal compact${split ? " active" : ""}`}
        aria-label={label}
        aria-pressed={split}
        onClick={() => toggleSplit()}
      >
        <SplitVerticalRegular />
      </button>
    </Tooltip>
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
  return (
    <Menu
      checkedValues={{ viewMode: [s.viewMode], options }}
      onCheckedValueChange={(_, d) => {
        if (d.name === "viewMode") {
          setFolderView({
            viewMode: d.checkedItems[0] === "grid" ? "grid" : "details",
          });
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
          ) : (
            <TextBulletListRegular className="chev state" />
          )}
        </button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItemRadio name="viewMode" value="grid">
            Large icons
          </MenuItemRadio>
          <MenuItemRadio name="viewMode" value="details">
            Details
          </MenuItemRadio>
          <MenuDivider />
          <MenuItemCheckbox name="options" value="checkboxes">
            Item check boxes
          </MenuItemCheckbox>
          <MenuItemCheckbox name="options" value="hidden">
            Show hidden files
          </MenuItemCheckbox>
          <MenuDivider />
          <Menu
            checkedValues={{ groupBy: [s.groupBy] }}
            onCheckedValueChange={(_, d) => {
              const v = d.checkedItems[0] as GroupBy | undefined;
              if (v) setFolderView({ groupBy: v });
            }}
          >
            <MenuTrigger disableButtonEnhancement>
              <MenuItem icon={<GroupListRegular />} disabled={s.locked}>
                Group by
              </MenuItem>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {(
                  [
                    ["none", "None"],
                    ["name", "Name"],
                    ["created", "Date created"],
                    ["type", "Type"],
                    ["tags", "Tags"],
                  ] as [GroupBy, string][]
                ).map(([key, label]) => (
                  <MenuItemRadio key={key} name="groupBy" value={key}>
                    {label}
                  </MenuItemRadio>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
          <MenuDivider />
          <MenuItem onClick={() => applyViewToAll()}>Use this view for all folders</MenuItem>
          <MenuItem disabled={!s.hasOverride} onClick={() => resetFolderView()}>
            Reset this folder's view
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

function FilterMenu() {
  const s = useSettings();
  const tab = useActiveTab();
  const folderTags = useTabs((s) => s.folderTags);
  const inFolder = tab.location.kind === "path";
  const tf = tab.tagFilter;
  const tagsOn = inFolder && tagFilterActive(tf);
  // The folder's tags, plus any picked ones it doesn't have (found in subfolders).
  const offered = [...folderTags];
  for (const name of tf?.names ?? []) {
    if (!offered.some((o) => tagKey(o.tag.name) === tagKey(name))) {
      offered.push({ tag: { name, color: 0 }, count: 0 });
    }
  }
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
          // "Any tag" and particular tags exclude each other: the newest pick wins.
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
  const clipboard = useClipboard();
  const selCount = tab.selection.length;
  const hasSelection = selCount > 0;
  const inFolder = tab.location.kind === "path";
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
            New
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
        icon={<RenameRegular />}
        disabled={selCount !== 1}
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
        disabled={!inFolder || clipboard.paths.length === 0}
        onClick={() => paste()}
      />
      <CmdButton
        label="Share"
        icon={<ShareIosRegular />}
        disabled={!hasSelection}
        onClick={(e) => shareItems(tab.selection, e.currentTarget)}
      />
      <CmdButton
        label="Delete"
        icon={<DeleteRegular />}
        disabled={!hasSelection}
        onClick={() => deleteSelection(false)}
      />
      <div className="cmd-right">
        <SortMenu />
        <ViewMenu />
        <FilterMenu />
        <SplitToggle />
      </div>
    </div>
  );
}
