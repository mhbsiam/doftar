import { useEffect, useRef } from "react";
import { create } from "zustand";
import { api } from "../ipc";
import { sameTags } from "../util/tags";
import type { FileEntry, Tag } from "../types";

/**
 * Tags fresher than the listing's. A listing reads tags only for items with a Finder label
 * (see `tags::read_labelled`). A scan adds the other tags. Views use `withTags`.
 */
interface TagStore {
  byPath: Map<string, Tag[]>;
  rev: number;
  /** Increases after each finished edit of ours, so tag searches run again. */
  edits: number;
  pending: number;
  put: (pairs: [string, Tag[]][]) => void;
  beginEdit: () => void;
  noteEdit: () => void;
}

const MAX_PATHS = 50_000;

export const useTags = create<TagStore>((set, get) => ({
  byPath: new Map(),
  rev: 0,
  edits: 0,
  pending: 0,
  beginEdit: () => set((s) => ({ pending: s.pending + 1 })),
  noteEdit: () => set((s) => ({ edits: s.edits + 1, pending: Math.max(0, s.pending - 1) })),
  put: (pairs) => {
    const map = get().byPath;
    let changed = false;
    if (map.size > MAX_PATHS) {
      map.clear();
      changed = true;
    }
    for (const [path, tags] of pairs) {
      if (map.has(path) && sameTags(map.get(path), tags)) continue;
      map.set(path, tags);
      changed = true;
    }
    if (changed) set((s) => ({ rev: s.rev + 1 }));
  },
}));

/** Returns the same array if no tag differs. */
export function withTags(entries: FileEntry[], byPath: Map<string, Tag[]>): FileEntry[] {
  if (byPath.size === 0) return entries;
  let out: FileEntry[] | null = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const t = byPath.get(e.path);
    if (t === undefined || sameTags(t, e.tags)) continue;
    out ??= entries.slice();
    out[i] = { ...e, tags: t.length ? t : undefined };
  }
  return out ?? entries;
}

/**
 * Mark for a read that starts now. `readStillFresh(mark)` is true if none of our edits ran
 * since, so the read result is safe to store.
 */
export function readMark(): number {
  const s = useTags.getState();
  return s.pending > 0 ? -1 : s.edits;
}

export function readStillFresh(mark: number): boolean {
  const s = useTags.getState();
  return mark >= 0 && s.pending === 0 && s.edits === mark;
}

/** An item has one colored tag at most. A colored `tag` replaces other colored tags, as the backend does. */
export function withTagAdded(tags: Tag[], tag: Tag): Tag[] {
  const key = tag.name.toLowerCase();
  const kept = tag.color > 0 ? tags.filter((t) => t.color === 0 || t.name.toLowerCase() === key) : tags;
  return kept.some((t) => t.name.toLowerCase() === key) ? kept : [...kept, tag];
}

export function currentTags(e: FileEntry): Tag[] {
  return useTags.getState().byPath.get(e.path) ?? e.tags ?? [];
}

const SCAN_ALWAYS_MAX = 3000;

/**
 * Read the full tags of a settled listing once, to find tags without color. Scan big folders
 * only if `wanted` or when `refresh` changes.
 */
export function useTagScan(
  entries: FileEntry[],
  settled: boolean,
  wanted: boolean,
  refresh: number
) {
  const scanned = useRef(refresh);
  const asked = refresh !== scanned.current;
  const scan =
    settled && entries.length > 0 && (wanted || asked || entries.length <= SCAN_ALWAYS_MAX);
  useEffect(() => {
    if (!scan) return;
    scanned.current = refresh;
    let stale = false;
    const paths = entries.map((e) => e.path);
    const t = setTimeout(() => {
      const mark = readMark();
      api
        .scanTags(paths)
        .then((found) => {
          // A scan that overlapped an edit of ours may be old. The next listing change scans again.
          if (stale || !readStillFresh(mark)) return;
          // Keep an empty override only to clear tags that the listing shows from before an edit.
          const pairs: [string, Tag[]][] = [];
          const known = useTags.getState().byPath;
          for (const e of entries) {
            const tags = found[e.path];
            if (tags) pairs.push([e.path, tags]);
            else if (e.tags?.length || known.has(e.path)) pairs.push([e.path, []]);
          }
          useTags.getState().put(pairs);
        })
        .catch(() => {});
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [entries, scan, refresh]);
}
