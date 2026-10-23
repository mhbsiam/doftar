import { useEffect, useRef, useState } from "react";
import { ChevronDownRegular } from "@fluentui/react-icons";
import {
  WinFolderIcon,
  WinDriveIcon,
  WinNetworkDriveIcon,
  WinKnownFolderIcon,
  DriveMeter,
  EntryIcon,
  knownFolderKind,
} from "./FileIcon";
import { api } from "../ipc";
import type { SizeProgress } from "../types";
import { useAppData } from "../stores/appdata";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { formatSize } from "../util/format";
import { useSettings } from "../stores/settings";
import { useUI, type MenuItemSpec } from "../stores/ui";
import {
  copyAsPath,
  setViewEntries,
  navigateTo,
  openFile as openFileAt,
  quickLookPaths,
  shareItems,
} from "../actions";
import { formatDate, basename } from "../util/format";
import { parentOf, usePaneStore, useTabs } from "../stores/tabs";
import { useRovingFocus } from "../hooks/useRovingFocus";
import type { FileEntry, RecentItem } from "../types";

function toPseudoEntry(path: string, modifiedMs: number, isDir = false): FileEntry {
  const name = basename(path);
  const ext = name.includes(".")
    ? name.split(".").pop()!.toLowerCase()
    : "";
  return {
    name,
    path,
    isDir,
    isHidden: false,
    isSymlink: false,
    isPackage: false,
    size: 0,
    modifiedMs,
    createdMs: 0,
    ext,
  };
}

const sizeCache = new Map<string, SizeProgress>();
const sizeJobs = new Map<string, Promise<SizeProgress>>();
let nextSizeJob = 2_000_000;

function folderTotals(path: string, onProgress: (p: SizeProgress) => void): Promise<SizeProgress> {
  const cached = sizeCache.get(path);
  // A folder that couldn't be read is asked about again next time, since
  // the user may have allowed Doftar into it since.
  if (cached?.done && !cached.denied) return Promise.resolve(cached);
  let job = sizeJobs.get(path);
  if (!job) {
    const id = nextSizeJob++;
    job = api
      .folderSize([path], id, (p) => {
        sizeCache.set(path, p);
        onProgress(p);
      })
      .then((p) => {
        sizeCache.set(path, p);
        sizeJobs.delete(path);
        return p;
      });
    sizeJobs.set(path, job);
  }
  return job;
}

function useQuickFolderTotals(path: string): SizeProgress | null {
  const [totals, setTotals] = useState<SizeProgress | null>(() => sizeCache.get(path) ?? null);
  useEffect(() => {
    let live = true;
    void folderTotals(path, (p) => live && setTotals(p))
      .then((p) => live && setTotals(p))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path]);
  return totals;
}

function totalsLabel(t: SizeProgress | null, fallback: string): string {
  if (!t) return fallback;
  if (t.denied) return "No access · allow Doftar in Privacy & Security";
  const items = t.files + t.folders;
  const n = `${items.toLocaleString()} item${items === 1 ? "" : "s"}`;
  return `${n} · ${formatSize(t.bytes)}${t.done ? "" : "…"}`;
}

/**
 * What the Quick access and Drives tiles do with the pointer and keys, like
 * the rows below them: a click selects, a double-click or Enter opens.
 */
function tileProps(path: string, onSelect: (path: string) => void) {
  const open = () => navigateTo({ kind: "path", path });
  return {
    onClick: () => onSelect(path),
    onDoubleClick: open,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        open();
      }
    },
  };
}

function QuickTile(props: { pin: string; selected: boolean; onSelect: (path: string) => void }) {
  const { pin, selected, onSelect } = props;
  const name = basename(pin);
  const kind = knownFolderKind(name);
  const totals = useQuickFolderTotals(pin);
  return (
    <div
      className={`qa-tile${kind ? " known" : ""}${selected ? " selected" : ""}`}
      title={pin}
      data-prefetch={pin}
    >
      <button className="qa-main" aria-pressed={selected} {...tileProps(pin, onSelect)}>
        <span className="qa-icon" aria-hidden>
          {kind ? <WinKnownFolderIcon kind={kind} size={44} path={pin} /> : <WinFolderIcon size={44} path={pin} />}
        </span>
        <span className="qa-text">
          <span className="qa-name">{name}</span>
          <span className="qa-sub">{totalsLabel(totals, pinLocation(pin))}</span>
        </span>
      </button>
    </div>
  );
}

function pinLocation(path: string): string {
  const parent = parentOf(path);
  return !parent || parent === "/" ? "Computer" : basename(parent);
}

function openFile(entry: FileEntry) {
  if (entry.isDir) {
    navigateTo({ kind: "path", path: entry.path });
    return;
  }
  openFileAt(entry.path);
}

function homeMenu(entry: FileEntry, kind: "fav" | "recent", x: number, y: number): MenuItemSpec[] {
  const appdata = useAppData.getState();
  const ui = useUI.getState();
  return [
    { key: "open", label: "Open", onSelect: () => openFile(entry) },
    {
      key: "reveal",
      label: "Open file location",
      onSelect: () => useTabs.getState().reveal(entry.path),
    },
    {
      key: "remove",
      label: kind === "fav" ? "Remove from Favorites" : "Remove from Recent",
      onSelect: () => {
        if (kind === "fav") {
          appdata.toggleFavorite({
            path: entry.path,
            name: entry.name,
            dirName: "",
            modifiedMs: entry.modifiedMs,
          });
        } else {
          appdata.removeRecent(entry.path);
        }
      },
    },
    { key: "d", dividerBefore: true },
    { key: "share", label: "Share", onSelect: () => shareItems([entry.path], { x, y, width: 1, height: 1 }) },
    { key: "copy-path", label: "Copy as path", shortcut: "⌥⌘C", onSelect: () => copyAsPath([entry.path]) },
    { key: "props", label: "Properties", onSelect: () => ui.openProperties(entry) },
  ];
}

function InfoRow(props: {
  kind: "fav" | "recent";
  entry: FileEntry;
  dateMs: number;
  location: string;
  description: string;
  selected: boolean;
  onSelect: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
}) {
  const { kind, entry, dateMs, location, description, selected, onSelect, onContextMenu } = props;
  return (
    <div
      className={`filerow${selected ? " selected" : ""}`}
      data-prefetch={entry.isDir && !entry.isPackage ? entry.path : undefined}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onClick={() => onSelect(entry.path)}
      onDoubleClick={() => openFile(entry)}
      onContextMenu={(e) => onContextMenu(e, entry)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") {
          e.preventDefault();
          openFile(entry);
        } else if (e.key === " ") {
          e.preventDefault();
          onSelect(entry.path);
          if (!e.repeat) quickLookPaths([entry.path]);
        } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          useUI.getState().openContextMenu(r.left + 32, r.bottom, homeMenu(entry, kind, r.left + 32, r.bottom));
        }
      }}
    >
      <span className="ficon">
        <EntryIcon entry={entry} size={24} />
      </span>
      <span className="fname">{entry.name}</span>
      <span className="fdate">{formatDate(dateMs)}</span>
      <span className="floc">{location}</span>
      <span className="fdesc">{description}</span>
    </div>
  );
}

// One Tab stop per list; Up/Down, Home and End move between its rows.
export function RovingListbox(props: { label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const roving = useRovingFocus(ref, { selector: '[role="option"]', vertical: true });
  return (
    <div
      ref={ref}
      className="filelist"
      role="listbox"
      aria-label={props.label}
      onFocus={roving.onFocus}
      onKeyDown={roving.onKeyDown}
    >
      {props.children}
    </div>
  );
}

export function Section(props: {
  label: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  /** Shown in place of `label`, which still keys the collapsed state. */
  heading?: React.ReactNode;
  /** Keeps collapsed states apart between pages. */
  scope?: string;
}) {
  const key = `${props.scope ?? "home"}:${props.label}`;
  const open = !useSettings((s) => s.collapsedSections).includes(key);
  const setOpen = () => useSettings.getState().toggleSection(key);
  return (
    <div className="section">
      <div className="section-h">
        <h2 className="section-title">
          <button
            className="section-toggle"
            aria-expanded={open}
            onClick={setOpen}
          >
            <span className={`navchev${open ? " open" : ""}`} aria-hidden>
              <ChevronDownRegular />
            </span>
            {props.heading ?? props.label}
          </button>
        </h2>
        <span className="section-action">{props.action}</span>
      </div>
      {open && props.children}
    </div>
  );
}

const HIDDEN_VOLUME_NAMES = new Set(["Recovery", "Preboot", "VM", "Update"]);

export function HomeView() {
  const appdata = useAppData();
  const ui = useUI.getState();
  const [selected, setSelected] = useState<string | null>(null);
  const volumes = (useSystemInfo()?.volumes ?? []).filter(
    (v) => !HIDDEN_VOLUME_NAMES.has(v.name)
  );

  const paneTabs = usePaneStore();
  useEffect(() => {
    const s = paneTabs.getState();
    setViewEntries(s.pane, []);
    s.setListingCount(0);
    s.setSelectionBytes(0);
  }, [paneTabs]);

  const listContextMenu = (
    e: React.MouseEvent,
    entry: FileEntry,
    kind: "fav" | "recent"
  ) => {
    e.preventDefault();
    ui.openContextMenu(e.clientX, e.clientY, homeMenu(entry, kind, e.clientX, e.clientY));
  };

  return (
    <div className="content home">
      <Section label="Quick access">
        <div className="qa-grid">
          {appdata.pins.map((pin) => (
            <QuickTile
              key={pin}
              pin={pin}
              selected={selected === pin}
              onSelect={setSelected}
            />
          ))}
        </div>
      </Section>

      {volumes.length > 0 && (
        <Section label="Drives">
          <div className="qa-grid">
            {volumes.map((vol) => {
              const used = vol.totalBytes - vol.freeBytes;
              return (
                <div
                  key={vol.path}
                  className={`qa-tile drive${selected === vol.path ? " selected" : ""}`}
                  title={vol.path}
                  data-prefetch={vol.path}
                >
                  <button
                    className="qa-main"
                    aria-pressed={selected === vol.path}
                    {...tileProps(vol.path, setSelected)}
                  >
                    <span className="qa-icon" aria-hidden>
                      {vol.isNetwork ? <WinNetworkDriveIcon size={44} /> : <WinDriveIcon size={44} />}
                    </span>
                    <span className="qa-text">
                      <span className="qa-name">{vol.name}</span>
                      {vol.totalBytes > 0 && (
                        <>
                          <DriveMeter usedBytes={used} totalBytes={vol.totalBytes} />
                          <span className="qa-sub">
                            {formatSize(vol.freeBytes)} free of {formatSize(vol.totalBytes)}
                          </span>
                        </>
                      )}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section
        label="Favorites"
        action={
          appdata.favorites.length > 0 ? (
            <button
              className="link-btn"
              onClick={() =>
                ui.openConfirm({
                  title: "Clear all favorites?",
                  message: `This removes all ${appdata.favorites.length} favorites from the list. The files themselves are not touched.`,
                  confirmLabel: "Clear all",
                  danger: true,
                  onConfirm: () => appdata.clearFavorites(),
                })
              }
            >
              Clear all
            </button>
          ) : null
        }
      >
        <RovingListbox label="Favorites">
          {appdata.favorites.length === 0 ? (
            <div className="list-empty">
              Add items with right-click → "Add to Favorites".
            </div>
          ) : (
            appdata.favorites.map((f) => {
              const entry = toPseudoEntry(f.path, f.modifiedMs, f.isDir === true);
              return (
                <InfoRow
                  kind="fav"
                  key={f.path}
                  entry={entry}
                  dateMs={f.modifiedMs}
                  location={f.dirName}
                  description="Pinned"
                  selected={selected === f.path}
                  onSelect={setSelected}
                  onContextMenu={(e, entry) => listContextMenu(e, entry, "fav")}
                />
              );
            })
          )}
        </RovingListbox>
      </Section>

      <Section
        label="Recent"
        action={
          appdata.recents.length > 0 ? (
            <button className="link-btn" onClick={() => appdata.clearRecents()}>
              Clear all
            </button>
          ) : null
        }
      >
        <RovingListbox label="Recent files">
          {appdata.recents.length === 0 ? (
            <div className="list-empty">Files you open will show up here.</div>
          ) : (
            appdata.recents.map((r: RecentItem) => {
              const entry = toPseudoEntry(r.path, r.ts);
              return (
                <InfoRow
                  kind="recent"
                  key={r.path}
                  entry={entry}
                  dateMs={r.ts}
                  location={r.dirName}
                  description="Opened"
                  selected={selected === r.path}
                  onSelect={setSelected}
                  onContextMenu={(e, entry) =>
                    listContextMenu(e, entry, "recent")
                  }
                />
              );
            })
          )}
        </RovingListbox>
      </Section>
    </div>
  );
}
