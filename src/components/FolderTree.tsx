import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@fluentui/react-components";
import {
  ArrowMinimizeVerticalRegular,
  ChevronRightRegular,
  DismissRegular,
  SearchRegular,
} from "@fluentui/react-icons";
import { api } from "../ipc";
import { extractArchive, folderEntryForPath, openEntry } from "../actions";
import { useUI } from "../stores/ui";
import { useTabs } from "../stores/tabs";
import { useDateFormat, useSettings } from "../stores/settings";
import { useAppData } from "../stores/appdata";
import { useSearch } from "../hooks/useSearch";
import { EntryIcon, WinFileIcon, WinFolderIcon } from "./FileIcon";
import { formatDate, formatSize, shortDate } from "../util/format";
import { isFolder } from "../util/kinds";
import { dur } from "../util/motion";
import { archiveTree, flattenTree, matchTree, sizeOf, type TreeRow } from "../util/folderTree";
import type { FileEntry } from "../types";

let nextJob = 5_000_000;
/** Folders sized at one time. The rest wait. */
const SIZERS = 3;

/** Stays mounted to slide open and shut. Keeps the last folder on screen while it closes. */
export function FolderTreeSlot({ pane }: { pane: number }) {
  const root = useUI((s) => (s.folderTree?.pane === pane ? s.folderTree.root : null));
  const archive = useUI((s) => s.folderTree?.pane === pane && !!s.folderTree.archive);
  const showHidden = useSettings((s) => s.showHidden);
  const [shown, setShown] = useState(root);
  const [shownArchive, setShownArchive] = useState(archive);
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (slot.current) slot.current.inert = !root;
    if (root) {
      setShown(root);
      setShownArchive(archive);
      return;
    }
    // Unmount after it shuts. This also stops the sizing.
    const t = setTimeout(() => setShown(null), dur("slow"));
    return () => clearTimeout(t);
  }, [root, archive]);
  return (
    <div ref={slot} className={`ftree-slot${root ? "" : " closed"}`} aria-hidden={!root || undefined}>
      {shown &&
        (shownArchive ? (
          <ArchiveTree key={shown} root={shown} />
        ) : (
          <FolderTree key={`${shown}\0${showHidden}`} root={shown} showHidden={showHidden} />
        ))}
    </div>
  );
}

const rowKey = (r: TreeRow) => (r.kind === "entry" ? r.entry.path : `${r.parent}\0${r.kind}`);

function FolderTree({ root, showHidden }: { root: string; showHidden: boolean }) {
  useDateFormat();
  const close = useUI((s) => s.closeFolderTree);
  const home = useAppData((s) => s.home);
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  /** Bytes and item counts per sized folder. Bytes are -1 if the folder could not be read. */
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const listed = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const queued = useRef(new Set<string>());
  const running = useRef(new Map<number, string>());
  const alive = useRef(true);

  const pump = useCallback(() => {
    while (alive.current && running.current.size < SIZERS && queue.current.length) {
      const path = queue.current.shift()!;
      const id = nextJob++;
      running.current.set(id, path);
      api
        .folderSize([path], id, () => {})
        .then((p) => {
          if (!alive.current || p.cancelled) return;
          setSizes((s) => ({ ...s, [path]: p.denied ? -1 : p.bytes }));
          setCounts((c) => ({ ...c, [path]: p.files + p.folders }));
        })
        .catch(() => alive.current && setSizes((s) => ({ ...s, [path]: -1 })))
        .finally(() => {
          running.current.delete(id);
          pump();
        });
    }
  }, []);

  // Put the folders just shown first, so the visible folders are sized first.
  const sizeSoon = useCallback(
    (paths: string[]) => {
      const fresh = paths.filter((p) => !queued.current.has(p));
      fresh.forEach((p) => queued.current.add(p));
      queue.current.unshift(...fresh);
      pump();
    },
    [pump]
  );

  const list = useCallback(
    (dir: string) => {
      if (listed.current.has(dir)) return;
      listed.current.add(dir);
      api
        .listDir(dir, showHidden)
        .then((items) => {
          if (!alive.current) return;
          setChildren((c) => ({ ...c, [dir]: items }));
          sizeSoon(items.filter((e) => e.isDir).map((e) => e.path));
        })
        .catch((err) => {
          if (!alive.current) return;
          setErrors((e) => ({ ...e, [dir]: String(err) }));
          setChildren((c) => ({ ...c, [dir]: [] }));
        });
    },
    [showHidden, sizeSoon]
  );

  useEffect(() => {
    alive.current = true;
    list(root);
    const jobs = running.current;
    return () => {
      alive.current = false;
      for (const id of jobs.keys()) void api.cancelSize(id).catch(() => {});
    };
  }, [root, list]);

  // If all items of a folder are sized, add them up. Then nothing sizes the folder twice.
  const allSizes = useMemo(() => {
    const out = { ...sizes };
    const top = children[root];
    if (top && top.every((e) => !e.isDir || e.path in sizes))
      out[root] = top.reduce((sum, e) => sum + Math.max(0, sizeOf(e, sizes) ?? 0), 0);
    return out;
  }, [children, sizes, root]);
  const top = children[root];
  const totalItems =
    top && top.every((e) => !e.isDir || e.path in counts)
      ? top.reduce((n, e) => n + 1 + (e.isDir ? counts[e.path] : 0), 0)
      : null;

  const search = useSearch(root, query, showHidden, true);
  const filtering = query.trim() !== "";
  const rows = useMemo(
    () =>
      filtering
        ? matchTree(root, search.entries, folderEntryForPath, allSizes)
        : flattenTree(root, { children, open, sizes: allSizes }),
    [filtering, root, search.entries, children, open, allSizes]
  );
  const entryRows = rows.filter((r): r is Extract<TreeRow, { kind: "entry" }> => r.kind === "entry");
  const activeIndex = entryRows.findIndex((r) => r.entry.path === active);

  const toggle = (path: string, to?: boolean) => {
    const next = to ?? !open.has(path);
    if (next) list(path);
    setOpen((o) => {
      const n = new Set(o);
      if (next) n.add(path);
      else n.delete(path);
      return n;
    });
  };

  const pick = (row: Extract<TreeRow, { kind: "entry" }>) => {
    setActive(row.entry.path);
    if (isFolder(row.entry)) {
      if (!filtering) toggle(row.entry.path);
    } else useTabs.getState().reveal(row.entry.path);
  };

  useEffect(() => {
    if (active) document.getElementById(treeId(active))?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    const row = entryRows[activeIndex];
    const move = (i: number) => {
      const to = entryRows[Math.max(0, Math.min(entryRows.length - 1, i))];
      if (to) setActive(to.entry.path);
    };
    switch (e.key) {
      case "ArrowDown":
        move(activeIndex + 1);
        break;
      case "ArrowUp":
        move(activeIndex < 0 ? 0 : activeIndex - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(entryRows.length - 1);
        break;
      case "ArrowRight":
        if (!row || !isFolder(row.entry) || filtering) return;
        if (!open.has(row.entry.path)) toggle(row.entry.path, true);
        else move(activeIndex + 1);
        break;
      case "ArrowLeft":
        if (!row) return;
        if (isFolder(row.entry) && open.has(row.entry.path) && !filtering) toggle(row.entry.path, false);
        else if (row.parent !== root) setActive(row.parent);
        break;
      case "Enter":
        if (row) openEntry(row.entry);
        break;
      case " ":
        if (row) pick(row);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const rootSize = allSizes[root];
  const shownPath = home && root.startsWith(`${home}/`) ? `~${root.slice(home.length)}` : root;
  let stagger = 0;
  let lastParent = "";

  return (
    <aside className="ftree" aria-label={`Folder tree of ${baseOf(root)}`}>
      <header className="ftree-head">
        <div className="ftree-title">
          <EntryIcon entry={folderEntryForPath(root)} size={28} />
          <div className="ftree-title-text">
            <h2 title={root}>{baseOf(root)}</h2>
            <p title={root}>
              <span className="ftree-path">{shownPath}</span>
            </p>
          </div>
          <Button
            appearance="subtle"
            size="small"
            icon={<ArrowMinimizeVerticalRegular />}
            aria-label="Collapse all"
            title="Collapse all"
            disabled={open.size === 0 || filtering}
            onClick={() => setOpen(new Set())}
          />
          <Button
            appearance="subtle"
            size="small"
            icon={<DismissRegular />}
            aria-label="Close folder tree"
            title="Close"
            onClick={close}
          />
        </div>
        <div className="ftree-stats" aria-live="polite">
          {rootSize === undefined ? (
            <span className="shimmer-text">Adding up sizes…</span>
          ) : (
            <>
              <strong>{formatSize(rootSize)}</strong>
              {totalItems !== null && <span>{totalItems.toLocaleString()} items</span>}
            </>
          )}
        </div>
        <label className="ftree-find">
          <SearchRegular aria-hidden />
          <input
            type="search"
            placeholder={`Find in ${baseOf(root)}`}
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (query) setQuery("");
                else close();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                treeRef.current?.focus();
                if (!active && entryRows[0]) setActive(entryRows[0].entry.path);
              }
            }}
          />
        </label>
      </header>

      <div
        ref={treeRef}
        className="ftree-list"
        role="tree"
        tabIndex={0}
        aria-label={baseOf(root)}
        aria-activedescendant={active ? treeId(active) : undefined}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          } else onKey(e);
        }}
      >
        {filtering && rows.length === 0 && (
          <p className="ftree-note">
            {search.searching ? <span className="shimmer-text">Searching {baseOf(root)}…</span> : search.error ?? `Nothing in ${baseOf(root)} matches “${query.trim()}”.`}
          </p>
        )}
        {rows.map((row) => {
          if (row.parent !== lastParent) {
            lastParent = row.parent;
            stagger = 0;
          }
          const delay = `${Math.min(stagger++, 14) * 18}ms`;
          const indent = { "--depth": row.depth, animationDelay: delay } as React.CSSProperties;
          if (row.kind === "loading")
            return (
              <div key={rowKey(row)} className="ftree-skel" style={indent} aria-hidden>
                {[0, 1, 2].map((i) => (
                  <span key={i} className="ftree-skel-row">
                    <span className="sk-icon" />
                    <span className="sk-name" />
                    <span className="sk-size" />
                  </span>
                ))}
              </div>
            );
          if (row.kind === "empty" || row.kind === "more")
            return (
              <div key={rowKey(row)} className="ftree-row ftree-meta" style={indent}>
                <span className="ftree-name">
                  {row.kind === "more"
                    ? `${row.count.toLocaleString()} more — open the folder to see them`
                    : errors[row.parent]
                      ? "Can't read this folder"
                      : "Empty folder"}
                </span>
              </div>
            );
          const { entry } = row;
          const folder = isFolder(entry);
          const isOpen = folder && (filtering || open.has(entry.path));
          const size = sizeOf(entry, allSizes);
          const pending = entry.isDir && size === undefined && queued.current.has(entry.path);
          const parentSize = allSizes[row.parent];
          const share = size !== undefined && size > 0 && parentSize > 0 ? size / parentSize : 0;
          return (
            <TreeItem
              key={rowKey(row)}
              id={treeId(entry.path)}
              depth={row.depth}
              delay={delay}
              folder={folder}
              open={isOpen}
              active={active === entry.path}
              title={entry.path}
              icon={<EntryIcon entry={entry} size={16} />}
              label={filtering ? markMatch(entry.name, query.trim()) : entry.name}
              share={share}
              pending={pending}
              size={pending ? <span className="ftree-pend" /> : size === undefined ? "" : size < 0 ? "—" : formatSize(size)}
              date={folder ? "" : shortDate(entry.modifiedMs)}
              dateTitle={folder ? undefined : formatDate(entry.modifiedMs)}
              onClick={() => pick(row)}
              onDoubleClick={() => openEntry(entry)}
            />
          );
        })}
        {filtering && search.searching && rows.length > 0 && (
          <p className="ftree-note">
            <span className="shimmer-text">Still searching…</span>
          </p>
        )}
        {filtering && !search.searching && search.truncated && (
          <p className="ftree-note">Showing the first {search.entries.length.toLocaleString()} matches.</p>
        )}
      </div>
      <footer className="ftree-foot">Click a file to show it · double-click to open</footer>
    </aside>
  );
}

/** What an archive holds, as a tree. Read from its index: nothing is extracted, and no row is a real file. */
function ArchiveTree({ root }: { root: string }) {
  const close = useUI((s) => s.closeFolderTree);
  const [listing, setListing] = useState<ReturnType<typeof archiveTree> | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  useEffect(() => {
    let stale = false;
    api
      .archiveList(root)
      .then((l) => {
        if (stale) return;
        const tree = archiveTree(root, l.entries);
        setListing(tree);
        setTruncated(l.truncated);
        // One top folder is the usual shape. Open it, so the first view is not a single row.
        const top = tree.children[root];
        if (top.length === 1 && top[0].isDir) setOpen(new Set([top[0].path]));
      })
      .catch((err) => !stale && setError(String(err)));
    return () => {
      stale = true;
    };
  }, [root]);
  const q = query.trim().toLowerCase();
  const rows = useMemo(() => {
    if (!listing) return [];
    return q
      ? matchTree(root, listing.files.filter((f) => f.name.toLowerCase().includes(q)), folderEntryForPath, listing.sizes)
      : flattenTree(root, { children: listing.children, open, sizes: listing.sizes });
  }, [listing, root, open, q]);
  const toggle = (path: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (!n.delete(path)) n.add(path);
      return n;
    });
  return (
    <aside className="ftree" aria-label={`Contents of ${baseOf(root)}`}>
      <header className="ftree-head">
        <div className="ftree-title">
          <WinFileIcon entry={{ isDir: false, ext: root.split(".").pop() ?? "" }} size={28} />
          <div className="ftree-title-text">
            <h2 title={root}>{baseOf(root)}</h2>
            <p>
              <span className="ftree-path">Archive contents</span>
            </p>
          </div>
          <Button appearance="subtle" size="small" icon={<DismissRegular />} aria-label="Close" title="Close" onClick={close} />
        </div>
        <div className="ftree-stats" aria-live="polite">
          {error ? (
            <span>{error}</span>
          ) : !listing ? (
            <span className="shimmer-text">Reading the archive…</span>
          ) : (
            <>
              <strong>{formatSize(listing.sizes[root])}</strong>
              <span>
                {listing.files.length.toLocaleString()} files when extracted{truncated ? " (first 50,000 shown)" : ""}
              </span>
            </>
          )}
        </div>
        <label className="ftree-find">
          <SearchRegular aria-hidden />
          <input
            type="search"
            placeholder={`Find in ${baseOf(root)}`}
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.stopPropagation();
              if (query) setQuery("");
              else close();
            }}
          />
        </label>
      </header>
      <div className="ftree-list" role="tree" tabIndex={0} aria-label={baseOf(root)}>
        {listing && q && rows.length === 0 && <p className="ftree-note">Nothing in this archive matches “{query.trim()}”.</p>}
        {rows.map((row) => {
          const indent = { "--depth": row.depth } as React.CSSProperties;
          if (row.kind !== "entry")
            return (
              <div key={rowKey(row)} className="ftree-row ftree-meta" style={indent}>
                <span className="ftree-name">
                  {row.kind === "more" ? `${row.count.toLocaleString()} more` : row.kind === "empty" ? "Empty" : ""}
                </span>
              </div>
            );
          const { entry } = row;
          const isOpen = entry.isDir && (q !== "" || open.has(entry.path));
          const size = listing ? sizeOf(entry, listing.sizes) ?? 0 : 0;
          const parentSize = listing?.sizes[row.parent] ?? 0;
          return (
            <TreeItem
              key={rowKey(row)}
              depth={row.depth}
              folder={entry.isDir}
              open={isOpen}
              title={entry.path.slice(root.length + 1)}
              icon={entry.isDir ? <WinFolderIcon size={16} /> : <WinFileIcon entry={entry} size={16} />}
              label={q ? markMatch(entry.name, query.trim()) : entry.name}
              share={parentSize > 0 ? size / parentSize : 0}
              size={formatSize(size)}
              onClick={() => entry.isDir && !q && toggle(entry.path)}
            />
          );
        })}
      </div>
      <footer className="ftree-foot">
        <Button
          appearance="primary"
          size="small"
          disabled={!listing}
          onClick={() => {
            close();
            void extractArchive(root);
          }}
        >
          Extract here
        </Button>
      </footer>
    </aside>
  );
}

/** One line of a tree: a folder tree's item, or an archive's entry. */
function TreeItem(props: {
  id?: string;
  depth: number;
  delay?: string;
  folder: boolean;
  open: boolean;
  active?: boolean;
  title: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  /** This item's part of its folder's size, 0 to 1. */
  share: number;
  pending?: boolean;
  size: React.ReactNode;
  date?: string;
  dateTitle?: string;
  onClick: () => void;
  onDoubleClick?: () => void;
}) {
  const { folder, open, active = false } = props;
  return (
    <div
      id={props.id}
      role="treeitem"
      aria-level={props.depth + 1}
      aria-expanded={folder ? open : undefined}
      aria-selected={active}
      className={`ftree-row${active ? " active" : ""}`}
      style={{ "--depth": props.depth, animationDelay: props.delay } as React.CSSProperties}
      title={props.title}
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
    >
      <span className="ftree-guides" aria-hidden />
      <span className="ftree-name">
        <span className={`ftree-chev${folder ? "" : " none"}${open ? " open" : ""}`} aria-hidden>
          {folder && <ChevronRightRegular />}
        </span>
        {props.icon}
        <span className="ftree-label">{props.label}</span>
      </span>
      <span className={`ftree-bar${props.pending ? " pending" : ""}`} aria-hidden>
        <i style={{ transform: `scaleX(${props.share})` }} />
      </span>
      <span className="ftree-size">{props.size}</span>
      <span className="ftree-date" title={props.dateTitle}>
        {props.date}
      </span>
    </div>
  );
}

function markMatch(name: string, q: string) {
  const at = name.toLowerCase().indexOf(q.toLowerCase());
  if (!q || at < 0) return name;
  return (
    <>
      {name.slice(0, at)}
      <mark>{name.slice(at, at + q.length)}</mark>
      {name.slice(at + q.length)}
    </>
  );
}

const baseOf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
const treeId = (path: string) => `ftree-${encodeURIComponent(path)}`;
