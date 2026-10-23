import { useEffect, useMemo, useState } from "react";
import {
  ArrowClockwiseRegular,
  CopyRegular,
  FolderOpenRegular,
  InfoRegular,
} from "@fluentui/react-icons";
import { EntryIcon } from "./FileIcon";
import { RovingListbox, Section } from "./HomeView";
import { TagDot, TagDots } from "./TagDots";
import { tagMenuItems } from "./tagMenu";
import { useTagSearch } from "../hooks/useTagSearch";
import { useSettings } from "../stores/settings";
import { useTags, withTags } from "../stores/tags";
import { parentOf, usePaneStore, useTabs } from "../stores/tabs";
import { useAppData } from "../stores/appdata";
import { useUI, type MenuItemSpec } from "../stores/ui";
import {
  copyAsPath,
  navigateTo,
  openEntry,
  quickLookPaths,
  refreshSoon,
  setViewEntries,
} from "../actions";
import { formatDate } from "../util/format";
import { typeLabel } from "../util/kinds";
import { compareTags, tagKey } from "../util/tags";
import type { FileEntry, Tag } from "../types";

/** Items shown per tag before "Show all". */
const PREVIEW = 8;
const ANY_TAG: string[] = [];

interface TagGroup {
  tag: Tag;
  items: FileEntry[];
}

/** Every tag in use, each with its items, newest first. */
function groupByTag(entries: FileEntry[]): TagGroup[] {
  const groups = new Map<string, TagGroup>();
  for (const e of entries) {
    for (const t of e.tags ?? []) {
      const k = tagKey(t.name);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { tag: t, items: [] }));
      else if (g.tag.color === 0 && t.color > 0) g.tag = t;
      if (!g.items.includes(e)) g.items.push(e);
    }
  }
  const out = [...groups.values()];
  for (const g of out) g.items.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return out.sort((a, b) => compareTags(a.tag, b.tag));
}

function folderLabel(path: string, home: string): string {
  const parent = parentOf(path) ?? "";
  return home && (parent === home || parent.startsWith(home + "/"))
    ? "~" + parent.slice(home.length)
    : parent;
}

/** The Tags page: each tag in use, with its most recently changed items. */
export function TagsView() {
  const showHidden = useSettings((s) => s.showHidden);
  const tick = useTabs((s) => s.refreshTick);
  const home = useAppData((s) => s.home);
  const found = useTagSearch(null, ANY_TAG, showHidden, true, tick);
  const rev = useTags((s) => s.rev);
  const entries = useMemo(
    () => withTags(found.entries, useTags.getState().byPath).filter((e) => e.tags?.length),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [found.entries, rev]
  );
  const groups = useMemo(() => groupByTag(entries), [entries]);
  // An item under several tags shows in each; selecting it selects them all.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const paneTabs = usePaneStore();
  useEffect(() => {
    const s = paneTabs.getState();
    setViewEntries(s.pane, entries);
    s.setListingCount(entries.length);
    s.setSelectionBytes(0);
  }, [entries, paneTabs]);
  useEffect(() => () => setViewEntries(paneTabs.getState().pane, []), [paneTabs]);

  const select = (e: React.MouseEvent | React.KeyboardEvent, entry: FileEntry) => {
    if (e.metaKey) {
      const next = new Set(selected);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      setSelected(next);
    } else {
      setSelected(new Set([entry.path]));
    }
  };

  const openMenu = (x: number, y: number, entry: FileEntry) => {
    let chosen = selected;
    if (!chosen.has(entry.path)) {
      chosen = new Set([entry.path]);
      setSelected(chosen);
    }
    const targets = entries.filter((e) => chosen.has(e.path));
    const single = targets.length === 1;
    const items: MenuItemSpec[] = [
      { key: "open", label: "Open", icon: <FolderOpenRegular />, disabled: !single, onSelect: () => openEntry(entry) },
      {
        key: "reveal",
        label: "Open file location",
        icon: <FolderOpenRegular />,
        disabled: !single,
        onSelect: () => useTabs.getState().reveal(entry.path),
      },
      ...tagMenuItems(targets),
      {
        key: "copy-path",
        label: "Copy as path",
        icon: <CopyRegular />,
        dividerBefore: true,
        onSelect: () => copyAsPath(targets.map((e) => e.path)),
      },
      {
        key: "props",
        label: "Properties",
        icon: <InfoRegular />,
        onSelect: () => useUI.getState().openProperties(single ? entry : targets),
      },
    ];
    useUI.getState().openContextMenu(x, y, items);
  };

  const row = (g: TagGroup, entry: FileEntry) => {
    const isSel = selected.has(entry.path);
    return (
      <div
        key={entry.path}
        className={`filerow${isSel ? " selected" : ""}`}
        data-prefetch={entry.isDir && !entry.isPackage ? entry.path : undefined}
        role="option"
        aria-selected={isSel}
        tabIndex={-1}
        onClick={(e) => select(e, entry)}
        onDoubleClick={() => openEntry(entry)}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e.clientX, e.clientY, entry);
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter") {
            e.preventDefault();
            openEntry(entry);
          } else if (e.key === " ") {
            e.preventDefault();
            select(e, entry);
            if (!e.repeat) quickLookPaths([entry.path]);
          } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.left + 32, r.bottom, entry);
          }
        }}
      >
        <span className="ficon">
          <EntryIcon entry={entry} size={24} />
        </span>
        <span className="fname tagged-name" title={entry.path}>
          <span className="name-text">{entry.name}</span>
          <TagDots tags={entry.tags?.filter((t) => tagKey(t.name) !== tagKey(g.tag.name))} />
        </span>
        <span className="fdate">{formatDate(entry.modifiedMs)}</span>
        <span className="floc">{folderLabel(entry.path, home)}</span>
        <span className="fdesc">{typeLabel(entry)}</span>
      </div>
    );
  };

  return (
    <div
      className="content home tags-page"
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest(".filerow, button")) setSelected(new Set());
      }}
      onContextMenu={(e) => {
        // Rows open their own menu; anywhere else gets the page's.
        if ((e.target as HTMLElement).closest(".filerow")) return;
        e.preventDefault();
        setSelected(new Set());
        const settings = useSettings.getState();
        useUI.getState().openContextMenu(e.clientX, e.clientY, [
          {
            key: "refresh",
            label: "Refresh",
            icon: <ArrowClockwiseRegular />,
            shortcut: "F5",
            onSelect: () => refreshSoon(),
          },
          {
            key: "hidden",
            label: "Show hidden files",
            dividerBefore: true,
            checked: settings.showHidden,
            onSelect: () => settings.set({ showHidden: !settings.showHidden }),
          },
        ]);
      }}
    >
      {groups.length === 0 ? (
        <div className="empty-state">
          {found.searching ? (
            <p className="loading">Finding tagged items…</p>
          ) : found.error ? (
            <p>{found.error}</p>
          ) : (
            <>
              <h2>No tagged items</h2>
              <p className="hint">
                Right-click a file or folder and pick a colour to tag it. Tagged items from
                anywhere on your Mac show up here, grouped by tag.
              </p>
            </>
          )}
        </div>
      ) : (
        groups.map((g) => (
          <Section
            key={tagKey(g.tag.name)}
            scope="tags"
            label={tagKey(g.tag.name)}
            heading={
              <span className="tag-heading">
                <TagDot color={g.tag.color} />
                {g.tag.name}
                <span className="dgroup-count">{g.items.length}</span>
              </span>
            }
            action={
              <button
                className="link-btn"
                onClick={() => navigateTo({ kind: "tags", tag: g.tag.name })}
              >
                {g.items.length > PREVIEW ? `Show all ${g.items.length}` : "Open as list"}
              </button>
            }
          >
            <RovingListbox label={`Tagged ${g.tag.name}`}>
              {g.items.slice(0, PREVIEW).map((e) => row(g, e))}
            </RovingListbox>
          </Section>
        ))
      )}
      {groups.length > 0 && (
        <p className="tags-note">
          {found.truncated
            ? "Showing the first 5,000 tagged items. "
            : ""}
          Tagged items come from Spotlight; places it doesn't index aren't listed.
        </p>
      )}
    </div>
  );
}
