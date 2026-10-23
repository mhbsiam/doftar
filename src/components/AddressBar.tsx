import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronLeftRegular,
  DataPieRegular,
  ChevronRightRegular,
  ArrowUpRegular,
  ArrowClockwiseRegular,
  SearchRegular,
  HomeRegular,
  MoreVerticalRegular,
  ChevronDownRegular,
  SettingsRegular,
  CopyRegular,
  InfoRegular,
  CheckmarkRegular,
  DeleteDismissRegular,
  DesktopRegular,
  FolderRegular,
  TextFontSizeRegular,
  TagRegular,
} from "@fluentui/react-icons";
import {
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  MenuDivider,
  MenuItemRadio,
  MenuItemCheckbox,
} from "@fluentui/react-components";
import { useActiveTab, usePane, useTabs, parentOf, joinName } from "../stores/tabs";
import { locationTitle } from "../stores/tabs";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { EDIT_ADDRESS_EVENT } from "../hooks/useMenuEvents";
import { WinTerminalIcon } from "./FileIcon";
import { useSettings, type ThemePref } from "../stores/settings";
import { api } from "../ipc";
import { formatSize, normalizePath } from "../util/format";
import { useUI } from "../stores/ui";
import { useTerminalChoices } from "../stores/terminals";
import { useDropHover } from "../stores/drag";
import {
  clearAppCache,
  copyText,
  folderEntryForPath,
  openInTerminal,
  openInOtherTerminal,
  refreshSoon,
  runInTerminal,
  setTheme,
  showError,
} from "../actions";
import { TEXT_SCALES } from "../util/textScale";
import { FOLDER_COLORS, type FolderColorId } from "../util/folderColors";

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
            onClick={() => {
              if (!path) return;
              void copyText(path).catch(() =>
                showError("Couldn't copy the path to the clipboard.")
              );
            }}
          >
            Copy folder path
          </MenuItem>
          <MenuItem
            icon={<WinTerminalIcon />}
            onClick={() => path && openInTerminal(path)}
          >
            Open in {terminals.def?.name ?? "Terminal"}
          </MenuItem>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <MenuItem icon={<span />}>Open in</MenuItem>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {others.map((t) => (
                  <MenuItem key={t.path} onClick={() => path && openInTerminal(path, t)}>
                    {t.name}
                  </MenuItem>
                ))}
                {others.length > 0 && <MenuDivider />}
                <MenuItem onClick={() => path && void openInOtherTerminal(path)}>
                  Choose another app…
                </MenuItem>
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
  const settings = useSettings();
  const [cache, setCache] = useState<{ bytes: number; files: number } | null>(null);
  return (
    <Menu
      onOpenChange={(_, d) => {
        if (d.open) void api.cacheInfo().then(setCache).catch(() => setCache(null));
      }}
    >
      <MenuTrigger disableButtonEnhancement>
        <button className="navbtn settings" title="Options" aria-label="Options">
          <SettingsRegular />
        </button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <Menu
            checkedValues={{ theme: [settings.theme] }}
            onCheckedValueChange={(_, d) =>
              setTheme((d.checkedItems[0] as ThemePref) ?? "system")
            }
          >
            <MenuTrigger disableButtonEnhancement>
              <MenuItem icon={<DesktopRegular />}>Theme</MenuItem>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItemRadio name="theme" value="system">
                  Use system setting
                </MenuItemRadio>
                <MenuItemRadio name="theme" value="light">
                  Light
                </MenuItemRadio>
                <MenuItemRadio name="theme" value="dark">
                  Dark
                </MenuItemRadio>
              </MenuList>
            </MenuPopover>
          </Menu>
          <Menu
            checkedValues={{ textSize: [String(settings.textScale)] }}
            onCheckedValueChange={(_, d) => {
              const v = Number(d.checkedItems[0]);
              if (TEXT_SCALES.some((t) => t.value === v)) {
                settings.set({ textScale: v });
              }
            }}
          >
            <MenuTrigger disableButtonEnhancement>
              <MenuItem icon={<TextFontSizeRegular />}>Text size</MenuItem>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {TEXT_SCALES.map((t) => (
                  <MenuItemRadio key={t.value} name="textSize" value={String(t.value)}>
                    {t.label}
                  </MenuItemRadio>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
          <Menu
            checkedValues={{ folderColor: [settings.folderColor] }}
            onCheckedValueChange={(_, d) => {
              const id = d.checkedItems[0] as FolderColorId | undefined;
              if (id && FOLDER_COLORS.some((c) => c.id === id)) {
                settings.set({ folderColor: id });
              }
            }}
          >
            <MenuTrigger disableButtonEnhancement>
              <MenuItem icon={<FolderRegular />}>Folder color</MenuItem>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {FOLDER_COLORS.map((c) => (
                  <MenuItemRadio
                    key={c.id}
                    name="folderColor"
                    value={c.id}
                    icon={
                      <span
                        className="folder-swatch"
                        style={{
                          background: `linear-gradient(${c.stops[2]}, ${c.stops[1]})`,
                        }}
                      />
                    }
                  >
                    {c.label}
                  </MenuItemRadio>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
          <MenuDivider />
          <Menu
            checkedValues={{ privacy: settings.externalThumbnails ? ["externalThumbs"] : [] }}
            onCheckedValueChange={(_, d) =>
              settings.set({ externalThumbnails: d.checkedItems.includes("externalThumbs") })
            }
          >
            <MenuTrigger disableButtonEnhancement>
              <MenuItem icon={<InfoRegular />}>Privacy</MenuItem>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItemCheckbox name="privacy" value="externalThumbs">
                  Thumbnails on external drives
                </MenuItemCheckbox>
              </MenuList>
            </MenuPopover>
          </Menu>
          <MenuItem
            icon={<DeleteDismissRegular />}
            disabled={cache !== null && cache.files === 0}
            onClick={() => void clearAppCache()}
          >
            {cache && cache.files > 0 ? `Clear cache (${formatSize(cache.bytes)})` : "Clear cache"}
          </MenuItem>
          <MenuItem
            icon={<ArrowClockwiseRegular />}
            onClick={() => refreshSoon()}
          >
            Refresh
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

export function AddressBar() {
  const pane = usePane();
  const tab = useActiveTab();
  const search = useTabs((s) => s.search);
  const deepSearch = useTabs((s) => s.deepSearch);
  const info = useSystemInfo();
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

  const commitDraft = () => {
    const raw = draft.trim();
    setEditing(false);
    if (!raw || !currentPath) return;
    const home = info?.home;
    // Something that reads as a place is only ever a place; anything else
    // is a folder here if one has that name, and otherwise a command to run
    // in a terminal in this folder (`claude`, `git status`, `npm run dev`).
    const placeLike = /^(~|\/|\.{1,2}(\/|$))/.test(raw);
    let target = raw;
    if (raw === "~" && home) target = home;
    else if (raw.startsWith("~/") && home) target = joinName(home, raw.slice(2));
    else if (!raw.startsWith("/")) target = joinName(currentPath, raw);
    // `..` goes to the parent rather than into a folder literally named "b/..".
    target = normalizePath(target);
    if (target === currentPath) return;
    api
      .pathExists(target)
      .then((ok) => {
        if (ok) useTabs.getState().navigate({ kind: "path", path: target });
        else if (!placeLike) runInTerminal(currentPath, raw);
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
          {editing ? (
            <input
              ref={inputRef}
              className="crumbs-edit"
              aria-label="Folder path"
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => setEditing(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitDraft();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
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
        <HistoryMenu />
        <FolderMenu path={currentPath} />
      </div>
      <div
        className={`searchbox${canDeepSearch && search.trim() ? " has-query" : ""}${canDeepSearch ? "" : " off"}`}
      >
        <SearchRegular style={{ color: "var(--text-3)", flex: "none" }} />
        <input
          id={`wf-search-input-${pane}`}
          type="search"
          aria-label={canDeepSearch ? `Search ${title}` : "Search (open a folder to search)"}
          placeholder={canDeepSearch ? `Search ${title}` : "Open a folder to search"}
          disabled={!canDeepSearch}
          title={canDeepSearch ? undefined : "Search works inside a folder"}
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
      </div>
      <SettingsMenu />
    </div>
  );
}
