import { create } from "zustand";
import type { FileEntry } from "../types";

/**
 * Changes shown in a listing before a reload confirms them. A reload that started after a
 * change drops it. A failed operation reverts it.
 */
export type OpBody =
  | { kind: "remove"; paths: string[] }
  | { kind: "add"; entry: FileEntry }
  | { kind: "put"; entry: FileEntry }
  | { kind: "rename"; from: string; entry: FileEntry };

export type Op = OpBody & { id: number };

interface OptimisticStore {
  ops: Record<string, Op[]>;
  push: (dir: string, body: OpBody) => number;
  /** Returns a marker for all changes pushed so far. Pass it to `clear`. */
  mark: () => number;
  /** Drop changes pushed at or before `upTo`. A later reload has caught up. */
  clear: (dir: string, upTo: number) => void;
  revert: (ids: number[]) => void;
}

let seq = 0;

export const useOptimistic = create<OptimisticStore>((set) => ({
  ops: {},
  push: (dir, body) => {
    const id = ++seq;
    set((s) => ({ ops: { ...s.ops, [dir]: [...(s.ops[dir] ?? []), { ...body, id }] } }));
    return id;
  },
  mark: () => seq,
  clear: (dir, upTo) =>
    set((s) => {
      const cur = s.ops[dir];
      if (!cur) return s;
      const keep = cur.filter((o) => o.id > upTo);
      if (keep.length === cur.length) return s;
      const ops = { ...s.ops };
      if (keep.length) ops[dir] = keep;
      else delete ops[dir];
      return { ops };
    }),
  revert: (ids) =>
    set((s) => {
      const drop = new Set(ids);
      const ops: Record<string, Op[]> = {};
      for (const [dir, list] of Object.entries(s.ops)) {
        const keep = list.filter((o) => !drop.has(o.id));
        if (keep.length) ops[dir] = keep;
      }
      return { ops };
    }),
}));

export function applyOps(entries: FileEntry[], ops: Op[]): FileEntry[] {
  let out = entries;
  for (const op of ops) {
    if (op.kind === "remove") {
      const gone = new Set(op.paths);
      out = out.filter((e) => !gone.has(e.path));
    } else if (op.kind === "add") {
      if (!out.some((e) => e.path === op.entry.path)) out = [...out, op.entry];
    } else if (op.kind === "put") {
      const i = out.findIndex((e) => e.path === op.entry.path);
      out = i < 0 ? [...out, op.entry] : out.map((e, k) => (k === i ? op.entry : e));
    } else {
      const present = out.some((e) => e.path === op.entry.path);
      out = out.filter((e) => e.path !== op.from);
      if (!present) out = [...out, op.entry];
    }
  }
  return out;
}

const extOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

export function newEntry(path: string, isDir: boolean): FileEntry {
  const name = path.split("/").pop() ?? path;
  const now = Date.now();
  return {
    name,
    path,
    isDir,
    isHidden: name.startsWith("."),
    isSymlink: false,
    isPackage: false,
    size: 0,
    modifiedMs: now,
    createdMs: now,
    ext: isDir ? "" : extOf(name),
  };
}

export function renamedEntry(entry: FileEntry, to: string): FileEntry {
  const name = to.split("/").pop() ?? to;
  return {
    ...entry,
    name,
    path: to,
    // The hidden flag carries over only if a dot did not cause it.
    isHidden: name.startsWith(".") || (entry.isHidden && !entry.name.startsWith(".")),
    ext: entry.isDir && !entry.isPackage ? "" : extOf(name),
  };
}
