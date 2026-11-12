import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronLeftRegular,
  DataPieRegular,
  BranchRegular,
  ColumnDoubleCompareRegular,
  DiamondRegular,
  ScreenshotRegular,
  ChevronRightRegular,
  ArrowUpRegular,
  ArrowClockwiseRegular,
  ArrowUndoRegular,
  ArrowRedoRegular,
  SearchRegular,
  HomeRegular,
  MoreVerticalRegular,
  ChevronDownRegular,
  SettingsRegular,
  CopyRegular,
  InfoRegular,
  QuestionCircleRegular,
  BookQuestionMarkRegular,
  KeyboardRegular,
  ArrowSyncCircleRegular,
  CheckmarkRegular,
  DeleteDismissRegular,
  DesktopRegular,
  TagRegular,
  CodeRegular,
  StarFilled,
  StarRegular,
} from "@fluentui/react-icons";
import {
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  MenuDivider,
  MenuGroup,
  MenuGroupHeader,
} from "@fluentui/react-components";
import { useActiveTab, usePane, useTabs, parentOf, joinName } from "../stores/tabs";
import { locationTitle } from "../stores/tabs";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { EDIT_ADDRESS_EVENT } from "../hooks/useMenuEvents";
import { WinFolderIcon, WinTerminalIcon } from "./FileIcon";
import { rankNames, splitDraft, tabComplete } from "../util/pathComplete";
import { sameSearch, useSettings, type SavedSearch } from "../stores/settings";
import { api } from "../ipc";
import { formatSize, normalizePath } from "../util/format";
import { useUI } from "../stores/ui";
import { topOf, useHistory } from "../stores/history";
import { useEditorChoices, useTerminalChoices } from "../stores/terminals";
import { useDropHover } from "../stores/drag";
import {
  clearAppCache,
  checkForUpdates,
  showAbout,
  copyAsPath,
  folderEntryForPath,
  openInTerminal,
  openInOtherTerminal,
  openInEditor,
  openInOtherEditor,
  redoLast,
  refreshSoon,
  runInTerminal,
  undoLast,
  showError,
  toggleSavedSearch,
} from "../actions";

interface Crumb {
  label: string;
  path: string;
  home?: boolean;
  root?: boolean;
}

function crumbsFor(path: string, bootVolumeName: string): Crumb[] {
  const parts = path.split("/").filter(Boolean);
  let crumbs: Crumb[];
  let acc: string;
  if (parts[0] === "Volumes" && parts.length >= 2) {
    acc = `/Volumes/${parts[1]}`;
    crumbs = [{ label: parts[1], path: acc, root: true }];
    parts.splice(0, 2);
  } else {
    acc = "";
    crumbs = [{ label: bootVolumeName, path: "/", root: true }];
  }
  for (const part of parts) {
    acc += `/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

function CrumbButton({ c }: { c: Crumb }) {
  const dropKey = `crumb|path:${c.path}`;
  const hover = useDropHover(dropKey);
  return (
    <button
      className={`crumb${hover ? " drop-hover" : ""}`}
      data-drop={dropKey}
      title={c.path}
      onClick={() => useTabs.getState().navigate({ kind: "path", path: c.path })}
    >
      {c.root ? <DesktopRegular /> : c.home ? <HomeRegular /> : null}
      <span className="crumb-label">{c.label}</span>
    </button>
  );
}

const OVERFLOW_W = 44;

function CrumbTrail({ crumbs }: { crumbs: Crumb[] }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(0);

  const recompute = useCallback(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const avail = row.clientWidth;
    const widths = Array.from(measure.children).map(
      (el) => el.getBoundingClientRect().width
    );
    if (widths.reduce((a, b) => a + b, 0) <= avail) {
      setHidden(0);
      return;
    }
    let used = OVERFLOW_W;
    let keep = 0;
    for (let i = widths.length - 1; i >= 0; i--) {
      if (keep > 0 && used + widths[i] > avail) break;
      used += widths[i];
      keep++;
    }
    setHidden(widths.length - keep);
  }, []);

  useLayoutEffect(recompute, [crumbs, recompute]);
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const ro = new ResizeObserver(recompute);
    ro.observe(row);
    return () => ro.disconnect();
  }, [recompute]);

  const overflow = crumbs.slice(0, hidden);
  const visible = crumbs.slice(hidden);
  return (
    <div className="crumb-trail" ref={rowRef}>
      <div className="crumb-measure" ref={measureRef} aria-hidden>
        {crumbs.map((c, i) => (
          <span key={c.path} className="crumb-item">
            {i > 0 && <span className="crumb-sep">›</span>}
            <span className="crumb">
              {c.root ? <DesktopRegular /> : c.home ? <HomeRegular /> : null}
              <span className="crumb-label">{c.label}</span>
            </span>
          </span>
        ))}
      </div>
      {overflow.length > 0 && (
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <button
              className="crumbs-chev crumbs-overflow"
              title="Show more locations"
              aria-label="Show more locations"
            >
              «
            </button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {[...overflow].reverse().map((c) => (
                <MenuItem
                  key={c.path}
                  onClick={() =>
                    useTabs.getState().navigate({ kind: "path", path: c.path })
                  }
                >
                  {c.label}
                </MenuItem>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
      )}
      {visible.map((c, i) => (
        <span
          key={c.path}
          className={`crumb-item${i === visible.length - 1 ? " last" : ""}`}
        >
          {(i > 0 || overflow.length > 0) && <span className="crumb-sep">›</span>}
          <CrumbButton c={c} />
        </span>
      ))}
    </div>
  );
}

function CopyPathButton({ path }: { path: string }) {
  // Counts copies, so each repeat click replays the check. 0 is the resting state.
  const [copies, setCopies] = useState(0);
  const reset = useRef<ReturnType<typeof setTimeout>>();
  const copy = async () => {
    if (!(await copyAsPath([path]))) return;
    setCopies((n) => n + 1);
    clearTimeout(reset.current);
    reset.current = setTimeout(() => setCopies(0), 1500);
  };
  const label = copies ? "Path copied" : "Copy as path";
  return (
    <button
      className={`crumbs-chev copy-path${copies ? " copied" : ""}`}
      title={label}
      aria-label={label}
      onClick={copy}
    >
      {copies ? (
        <span key={copies} className="copy-check">
          <CheckmarkRegular />
        </span>
      ) : (
        <CopyRegular />
      )}
    </button>
  );
}

function HistoryMenu() {
  const tab = useActiveTab();
  const entries = tab.history
    .map((loc, i) => ({ loc, i }))
    .reverse();
  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <button
          className="crumbs-chev"
          title="Recent locations"
          aria-label="Recent locations"
          onClick={(e) => e.stopPropagation()}
        >
          <ChevronDownRegular />
        </button>
      </MenuTrigger>
      <MenuPopover className="hist-menu">
        <MenuList>
          {entries.map(({ loc, i }) => (
            <MenuItem
              key={i}
              icon={
                i === tab.historyIndex ? <CheckmarkRegular /> : <span />
              }
              title={loc.kind === "path" ? loc.path : undefined}
              onClick={() => useTabs.getState().go(i - tab.historyIndex)}
            >
              {locationTitle(loc)}
            </MenuItem>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

function FolderMenu({ path }: { path: string | null }) {
  const terminals = useTerminalChoices();
  const others = terminals.list.filter((t) => t.path !== terminals.def?.path);
  const editors = useEditorChoices();
  const otherEditors = editors.list.filter((t) => t.path !== editors.def?.path);
  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <button
          className="crumbs-dots"
          title="Folder actions"
          aria-label="Folder actions"
          disabled={!path}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVerticalRegular />
        </button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem
            icon={<CopyRegular />}
            onClick={() => path && copyAsPath([path])}
          >
            Copy folder path
          </MenuItem>
          <MenuItem
            icon={<WinTerminalIcon />}
            onClick={() => path && openInTerminal(path)}
          >
            Open in {terminals.def?.name ?? "Terminal"}
          </MenuItem>
          <MenuItem icon={<CodeRegular />} onClick={() => path && openInEditor(path)}>
            {editors.def ? `Open in ${editors.def.name}` : "Open in code editor…"}
          </MenuItem>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <MenuItem icon={<span />}>Open in</MenuItem>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuGroup>
                  <MenuGroupHeader>Terminals</MenuGroupHeader>
                  {others.map((t) => (
                    <MenuItem key={t.path} onClick={() => path && openInTerminal(path, t)}>
                      {t.name}
                    </MenuItem>
                  ))}
                  <MenuItem onClick={() => path && void openInOtherTerminal(path)}>
                    Choose another terminal…
                  </MenuItem>
                </MenuGroup>
                <MenuDivider />
                <MenuGroup>
                  <MenuGroupHeader>Code editors</MenuGroupHeader>
                  {otherEditors.map((t) => (
                    <MenuItem key={t.path} onClick={() => path && openInEditor(path, t)}>
                      {t.name}
                    </MenuItem>
                  ))}
                  <MenuItem onClick={() => path && void openInOtherEditor(path)}>
                    Choose another editor…
                  </MenuItem>
                </MenuGroup>
              </MenuList>
            </MenuPopover>
          </Menu>
          <MenuDivider />
          <MenuItem
            icon={<InfoRegular />}
            onClick={() =>
              path && useUI.getState().openProperties(folderEntryForPath(path))
            }
          >
            Properties
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

function SettingsMenu() {
  const [cache, setCache] = useState<{ bytes: number; files: number } | null>(null);
  const gear = useRef<HTMLButtonElement>(null);
  return (
    <Menu
      onOpenChange={(_, d) => {
        if (d.open) void api.cacheInfo().then(setCache).catch(() => setCache(null));
      }}
    >
      <MenuTrigger disableButtonEnhancement>
        <button ref={gear} className="navbtn settings" title="Options" aria-label="Options">
          <SettingsRegular />
        </button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem
            icon={<SettingsRegular />}
            secondaryContent="⌘,"
            onClick={() => useUI.getState().setSettingsOpen(true)}
          >
            Settings…
          </MenuItem>
          <MenuDivider />
          <MenuItem
            icon={<DeleteDismissRegular />}
            disabled={cache !== null && cache.files === 0}
            onClick={() => void clearAppCache()}
          >
            {cache && cache.files > 0 ? `Clear cache (${formatSize(cache.bytes)})` : "Clear cache"}
          </MenuItem>
          <MenuDivider />
          <MenuItem
            icon={<BookQuestionMarkRegular />}
            secondaryContent="⌘?"
            onClick={() => useUI.getState().setHelpOpen(true)}
          >
            Help
          </MenuItem>
          <MenuItem
            icon={<KeyboardRegular />}
            secondaryContent="⌘/"
            onClick={() => useUI.getState().setShortcutsOpen(true)}
          >
            Keyboard shortcuts
          </MenuItem>
          <MenuItem icon={<ArrowSyncCircleRegular />} onClick={() => checkForUpdates()}>
            Check for updates
          </MenuItem>
          <MenuItem icon={<QuestionCircleRegular />} onClick={() => void showAbout()}>
            About Doftar
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

function SaveSearchButton({ search }: { search: SavedSearch }) {
  const saved = useSettings((s) => s.savedSearches.some((x) => sameSearch(x, search)));
  return (
    <button
      className="search-deep"
      aria-pressed={saved}
      title={saved ? "Remove this search from the sidebar" : "Save this search in the sidebar"}
      aria-label={saved ? "Remove saved search" : "Save search"}
      onClick={() => toggleSavedSearch(search)}
    >
      {saved ? <StarFilled /> : <StarRegular />}
    </button>
  );
}

export function AddressBar() {
  const pane = usePane();
  const tab = useActiveTab();
  const search = useTabs((s) => s.search);
  const deepSearch = useTabs((s) => s.deepSearch);
  const searchContents = useSettings((s) => s.searchContents);
  const info = useSystemInfo();
  const undoTop = useHistory((s) => topOf(s.undo));
  const redoTop = useHistory((s) => topOf(s.redo));
  const historyBusy = useHistory((s) => s.busy !== null);
  const canBack = tab.historyIndex > 0;
  const canFwd = tab.historyIndex < tab.history.length - 1;
  const canUp =
    tab.location.kind === "path" && parentOf(tab.location.path) !== null;
  const title = locationTitle(tab.location);
  const crumbs =
    tab.location.kind === "path"
      ? crumbsFor(tab.location.path, info?.bootVolumeName ?? "Macintosh HD")
      : [];
  const currentPath =
    tab.location.kind === "path" ? tab.location.path : (info?.home ?? null);

  const searchFolder = tab.location.kind === "path" ? tab.location.path : null;
  const canDeepSearch = searchFolder !== null;
  const deepOn = canDeepSearch && deepSearch === searchFolder;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const showHidden = useSettings((s) => s.showHidden);
  // Folder names under the typed folder, for completion. Cached per folder while editing.
  const [names, setNames] = useState<{ dir: string; list: string[] } | null>(null);
  const [pick, setPick] = useState(-1);
  const listed = useRef(new Map<string, string[]>());
  const parts = editing && info && currentPath ? splitDraft(draft, info.home, currentPath) : null;
  const dirToList = parts?.dir ?? null;
  const wantHidden = showHidden || (parts?.prefix.startsWith(".") ?? false);
  useEffect(() => {
    if (!editing) {
      listed.current.clear();
      setNames(null);
      return;
    }
    if (!dirToList) return;
    const key = `${dirToList}\0${wantHidden}`;
    const cached = listed.current.get(key);
    if (cached) return setNames({ dir: dirToList, list: cached });
    let live = true;
    const t = setTimeout(() => {
      api
        .listDir(dirToList, wantHidden)
        .then((entries) => {
          const list = entries.filter((e) => e.isDir && !e.isPackage).map((e) => e.name);
          listed.current.set(key, list);
          if (live) setNames({ dir: dirToList, list });
        })
        .catch(() => live && setNames(null));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [editing, dirToList, wantHidden]);
  const suggestions =
    parts && names?.dir === parts.dir && draft !== currentPath ? rankNames(parts.prefix, names.list) : [];
  const exact = suggestions.length === 1 && suggestions[0] === parts?.prefix;
  const open = suggestions.length > 0 && !exact;
  const choose = (name: string) => `${parts?.typedDir ?? ""}${name}/`;
  useEffect(() => setPick(-1), [draft]);

  useEffect(() => {
    setEditing(false);
  }, [tab.id]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = () => {
    if (!currentPath) return;
    setDraft(tab.location.kind === "path" ? currentPath : "~");
    setEditing(true);
  };

  const startEditRef = useRef(startEdit);
  startEditRef.current = startEdit;
  useEffect(() => {
    const onEdit = () => startEditRef.current();
    window.addEventListener(EDIT_ADDRESS_EVENT, onEdit);
    return () => window.removeEventListener(EDIT_ADDRESS_EVENT, onEdit);
  }, []);

  const commitDraft = (typed = draft) => {
    const raw = typed.trim();
    setEditing(false);
    if (!raw || !currentPath) return;
    const home = info?.home;
    // Text that looks like a place is always a place.
    // Otherwise use a folder with that name, or run the text as a command in a terminal.
    const placeLike = /^(~|\/|\.{1,2}(\/|$))/.test(raw);
    let target = raw;
    if (raw === "~" && home) target = home;
    else if (raw.startsWith("~/") && home) target = joinName(home, raw.slice(2));
    else if (!raw.startsWith("/")) target = joinName(currentPath, raw);
    // `..` means the parent folder, not a folder named "b/..".
    target = normalizePath(target);
    if (target === currentPath) return;
    const here = () => {
      const s = useTabs.getState();
      const t = s.tabs.find((t) => t.id === s.activeId);
      return t?.history[t.historyIndex];
    };
    const from = here();
    Promise.all([api.isFolder(target), api.pathExists(target)])
      .then(([folder, exists]) => {
        // Skip if the user went elsewhere meanwhile.
        if (here() !== from) return;
        if (folder) useTabs.getState().navigate({ kind: "path", path: target });
        else if (!placeLike) runInTerminal(currentPath, raw);
        // For a file, show its folder.
        else if (exists) useTabs.getState().reveal(target);
        else
          showError(
            `Can't find “${target}”. Check the spelling and try again.`
          );
      })
      .catch(showError);
  };

  return (
    <div className="addressrow">
      <button
        className="navbtn"
        disabled={!canBack}
        title="Back (Alt+Left)"
        aria-label="Back"
        onClick={() => useTabs.getState().go(-1)}
      >
        <ChevronLeftRegular />
      </button>
      <button
        className="navbtn"
        disabled={!canFwd}
        title="Forward (Alt+Right)"
        aria-label="Forward"
        onClick={() => useTabs.getState().go(1)}
      >
        <ChevronRightRegular />
      </button>
      <button
        className="navbtn"
        disabled={!canUp}
        title="Up (Alt+Up)"
        aria-label="Up one level"
        onClick={() => useTabs.getState().goUp()}
      >
        <ArrowUpRegular />
      </button>
      <button
        className="navbtn"
        title="Refresh (F5)"
        aria-label="Refresh"
        onClick={() => refreshSoon()}
      >
        <ArrowClockwiseRegular />
      </button>
      <button
        className="navbtn"
        disabled={!undoTop || historyBusy}
        title={undoTop ? `Undo ${undoTop.label} (⌘Z)` : "Undo (⌘Z)"}
        aria-label="Undo"
        onClick={() => void undoLast()}
      >
        <ArrowUndoRegular />
      </button>
      <button
        className="navbtn"
        disabled={!redoTop || historyBusy}
        title={redoTop ? `Redo ${redoTop.label} (⇧⌘Z)` : "Redo (⇧⌘Z)"}
        aria-label="Redo"
        onClick={() => void redoLast()}
      >
        <ArrowRedoRegular />
      </button>
      <div
        className="crumbs"
        title={currentPath ?? undefined}
        onClick={(e) => {
          const el = e.target as HTMLElement;
          if (!e.currentTarget.contains(el)) return;
          if (el.closest(".crumb, .crumbs-chev, .crumbs-dots")) return;
          startEdit();
        }}
      >
        <div className="crumbs-list">
          {editing && open && (
            <ul className="path-suggest" id={`wf-path-suggest-${pane}`} role="listbox" aria-label="Matching folders">
              {suggestions.map((name, i) => (
                <li
                  key={name}
                  id={`wf-path-suggest-${pane}-${i}`}
                  role="option"
                  aria-selected={i === pick}
                  // Keep focus in the field, which closes the list on blur.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commitDraft(choose(name))}
                >
                  <WinFolderIcon size={16} /> {name}
                </li>
              ))}
            </ul>
          )}
          {editing ? (
            <input
              ref={inputRef}
              className="crumbs-edit"
              aria-label="Folder path"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={`wf-path-suggest-${pane}`}
              aria-activedescendant={open && pick >= 0 ? `wf-path-suggest-${pane}-${pick}` : undefined}
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => setEditing(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitDraft(open && pick >= 0 ? choose(suggestions[pick]) : draft);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  if (open && pick >= 0) setPick(-1);
                  else setEditing(false);
                } else if (e.key === "Tab" && !e.shiftKey && parts && names?.dir === parts.dir) {
                  // Shell-style: complete the name. Tab stays in the field while there is a name to finish.
                  const next = pick >= 0 && open ? choose(suggestions[pick]) : tabComplete(parts, names.list);
                  if (next && next !== draft) {
                    e.preventDefault();
                    setDraft(next);
                  }
                } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && open) {
                  e.preventDefault();
                  const n = suggestions.length;
                  setPick((p) => (e.key === "ArrowDown" ? (p + 1) % n : p <= 0 ? n - 1 : p - 1));
                }
              }}
            />
          ) : tab.location.kind === "home" ? (
            <span className="crumb current">
              <HomeRegular /> Home
            </span>
          ) : tab.location.kind === "disk" ? (
            <span className="crumb current">
              <DataPieRegular /> Disk
            </span>
          ) : tab.location.kind === "skills" ? (
            <span className="crumb current">
              <DiamondRegular /> Skills
            </span>
          ) : tab.location.kind === "repos" ? (
            <span className="crumb current">
              <BranchRegular /> Git
            </span>
          ) : tab.location.kind === "compare" ? (
            <span className="crumb current">
              <ColumnDoubleCompareRegular /> Compare
            </span>
          ) : tab.location.kind === "screenshots" ? (
            <span className="crumb current">
              <ScreenshotRegular /> Screenshots
            </span>
          ) : tab.location.kind === "tags" ? (
            tab.location.tag === undefined ? (
              <span className="crumb current">
                <TagRegular /> Tags
              </span>
            ) : (
              <>
                <button
                  className="crumb"
                  onClick={() => useTabs.getState().navigate({ kind: "tags" })}
                >
                  <TagRegular /> Tags
                </button>
                <span className="crumb-sep">›</span>
                <span className="crumb current">{tab.location.tag}</span>
              </>
            )
          ) : (
            <CrumbTrail crumbs={crumbs} />
          )}
        </div>
        {searchFolder && <CopyPathButton key={searchFolder} path={searchFolder} />}
        <HistoryMenu />
        <FolderMenu path={currentPath} />
      </div>
      <div
        className={`searchbox${canDeepSearch && search.trim() ? " has-query" : ""}${canDeepSearch ? "" : " off"}`}
        title={canDeepSearch ? undefined : "Search works inside a folder"}
      >
        <SearchRegular />
        <input
          id={`wf-search-input-${pane}`}
          type="search"
          aria-label={canDeepSearch ? `Search ${title}` : "Search (open a folder to search)"}
          placeholder={canDeepSearch ? `Search ${title}` : "Open a folder to search"}
          disabled={!canDeepSearch}
          value={canDeepSearch ? search : ""}
          onChange={(e) => useTabs.getState().setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              useTabs.getState().setSearch("");
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Enter" && canDeepSearch && search.trim()) {
              useTabs.getState().setDeepSearch(searchFolder);
            }
          }}
        />
        {canDeepSearch && search.trim() && (
          <button
            className="search-deep"
            aria-pressed={deepOn}
            title={
              deepOn
                ? "Searching this folder and its subfolders (click to search this folder only)"
                : "Also search subfolders (Enter)"
            }
            onClick={() => useTabs.getState().setDeepSearch(deepOn ? null : searchFolder)}
          >
            Subfolders
          </button>
        )}
        {canDeepSearch && search.trim() && (
          <button
            className="search-deep"
            role="checkbox"
            aria-checked={deepOn && searchContents}
            title={
              deepOn && searchContents
                ? "Matching names and text inside files (click to match names only)"
                : "Also match text inside files. Covers what Spotlight has indexed, in this folder and its subfolders"
            }
            onClick={() => {
              const on = !(deepOn && searchContents);
              useSettings.getState().set({ searchContents: on });
              if (on && !deepOn) useTabs.getState().setDeepSearch(searchFolder);
            }}
          >
            Contents
          </button>
        )}
        {deepOn && search.trim() && (
          <SaveSearchButton search={{ root: searchFolder, query: search.trim(), contents: searchContents }} />
        )}
      </div>
      <SettingsMenu />
    </div>
  );
}
