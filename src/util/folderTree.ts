import type { ArchiveEntry, FileEntry } from "../types";
import { isFolder } from "./kinds";

/** One line of the folder tree: an item, or a placeholder under an open folder. */
export type TreeRow =
  | { kind: "entry"; entry: FileEntry; depth: number; parent: string }
  | { kind: "loading"; depth: number; parent: string }
  | { kind: "empty"; depth: number; parent: string }
  | { kind: "more"; depth: number; parent: string; count: number };

export interface TreeState {
  /** The items of each listed folder. A folder missing here is still being listed. */
  children: Record<string, FileEntry[]>;
  open: Set<string>;
  /** Bytes of each sized folder. A folder missing here is still being sized. */
  sizes: Record<string, number>;
}

// shortcut: a folder shows only its first CAP items. Raise CAP or virtualize the list if huge folders need all items.
export const CAP = 400;

export function sizeOf(entry: FileEntry, sizes: Record<string, number>): number | undefined {
  return entry.isDir ? sizes[entry.path] : entry.size;
}

/**
 * Biggest first when all sibling folders are sized. Before that, by name,
 * so rows reorder once per level, not on every size.
 */
export function orderLevel(items: FileEntry[], sizes: Record<string, number>): FileEntry[] {
  const sized = items.every((e) => !e.isDir || e.path in sizes);
  return [...items].sort((a, b) =>
    sized
      ? (sizeOf(b, sizes) ?? 0) - (sizeOf(a, sizes) ?? 0) || a.name.localeCompare(b.name)
      : Number(isFolder(b)) - Number(isFolder(a)) || a.name.localeCompare(b.name, undefined, { numeric: true })
  );
}

export function flattenTree(root: string, state: TreeState): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    const items = state.children[dir];
    if (!items) {
      rows.push({ kind: "loading", depth, parent: dir });
      return;
    }
    if (items.length === 0) rows.push({ kind: "empty", depth, parent: dir });
    const ordered = orderLevel(items, state.sizes);
    for (const entry of ordered.slice(0, CAP)) {
      rows.push({ kind: "entry", entry, depth, parent: dir });
      if (isFolder(entry) && state.open.has(entry.path)) walk(entry.path, depth + 1);
    }
    if (ordered.length > CAP) rows.push({ kind: "more", depth, parent: dir, count: ordered.length - CAP });
  };
  walk(root, 0);
  return rows;
}

/** Rows for search results under `root`: each match under its folders, all open. */
export function matchTree(
  root: string,
  matches: FileEntry[],
  folderEntry: (path: string) => FileEntry,
  sizes: Record<string, number>
): TreeRow[] {
  const prefix = root === "/" ? "/" : `${root}/`;
  const byParent = new Map<string, Map<string, FileEntry>>();
  // Placeholder folders lead down to a match. A real match for the folder replaces them.
  const standIns = new Set<string>();
  const add = (entry: FileEntry, standIn: boolean) => {
    const cut = entry.path.lastIndexOf("/");
    const parent = cut <= 0 ? "/" : entry.path.slice(0, cut);
    const level = byParent.get(parent) ?? new Map<string, FileEntry>();
    byParent.set(parent, level);
    const had = level.has(entry.path);
    if (had && (standIn || !standIns.has(entry.path))) return;
    level.set(entry.path, entry);
    if (standIn) standIns.add(entry.path);
    else standIns.delete(entry.path);
    if (!had && parent !== root && parent.startsWith(prefix)) add(folderEntry(parent), true);
  };
  for (const m of matches) if (m.path.startsWith(prefix)) add(m, false);
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    const level = byParent.get(dir);
    if (!level) return;
    for (const entry of orderLevel([...level.values()], sizes)) {
      rows.push({ kind: "entry", entry, depth, parent: dir });
      if (entry.isDir) walk(entry.path, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/**
 * The entries of an archive as a tree under `root`, the archive's own path. The paths are made up
 * (`<archive>/<entry>`), for keys and for `flattenTree`. Nothing exists there on disk.
 * Folders an archive does not list are added, and each folder gets the size of what it holds.
 */
export function archiveTree(root: string, entries: ArchiveEntry[]): Pick<TreeState, "children" | "sizes"> & { files: FileEntry[] } {
  const children: Record<string, FileEntry[]> = { [root]: [] };
  const sizes: Record<string, number> = { [root]: 0 };
  const files: FileEntry[] = [];
  const pseudo = (path: string, isDir: boolean, size: number): FileEntry => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    return { name, path, isDir, isHidden: false, isSymlink: false, isPackage: false, size, modifiedMs: 0, createdMs: 0, ext: isDir || dot <= 0 ? "" : name.slice(dot + 1).toLowerCase() };
  };
  const folder = (path: string) => {
    if (path in children) return;
    children[path] = [];
    sizes[path] = 0;
    const parent = path.slice(0, path.lastIndexOf("/"));
    folder(parent);
    children[parent].push(pseudo(path, true, 0));
  };
  for (const e of entries) {
    const path = `${root}/${e.path}`;
    if (e.isDir) {
      folder(path);
      continue;
    }
    const parent = path.slice(0, path.lastIndexOf("/"));
    folder(parent);
    const file = pseudo(path, false, e.size);
    children[parent].push(file);
    files.push(file);
    for (let dir = parent; ; dir = dir.slice(0, dir.lastIndexOf("/"))) {
      sizes[dir] += e.size;
      if (dir === root) break;
    }
  }
  return { children, sizes, files };
}
