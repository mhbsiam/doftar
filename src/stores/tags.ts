import { useEffect, useRef } from "react";
import { create } from "zustand";
import { api } from "../ipc";
import { sameTags } from "../util/tags";
import type { FileEntry, Tag } from "../types";

/**
 * Tags known to be fresher than a listing's. A folder listing only reads
 * tags for items with a Finder label (see `tags::read_labelled`), so a scan
 * fills in tags without a colour, and our own edits show before anything
 * reloads. Views pass their entries through `withTags`.
 */
interface TagStore {
  byPath: Map<string, Tag[]>;
  /** Bumped on every change, for selectors and memos. */
  rev: number;
  /** Bumped once a tag edit of ours has finished, so tag searches re-run. */
  edits: number;
  /** Tag edits of ours still running. */
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

/** `entries` with the fresher tags applied; the same array when none differ. */
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
 * A mark for reads of tags started now: `readStillFresh(mark)` says whether
 * no edit of ours ran meanwhile, so what the read found can replace what
 * the store knows without undoing that edit.
 */
export function readMark(): number {
  const s = useTags.getState();
  return s.pending > 0 ? -1 : s.edits;
}

export function readStillFresh(mark: number): boolean {
  const s = useTags.getState();
  return mark >= 0 && s.pending === 0 && s.edits === mark;
}

/**
 * An item has at most one colour: `tag`, if coloured, replaces any other
 * coloured tag (as the backend does); tags without a colour stay.
 */
export function withTagAdded(tags: Tag[], tag: Tag): Tag[] {
  const key = tag.name.toLowerCase();
  const kept = tag.color > 0 ? tags.filter((t) => t.color === 0 || t.name.toLowerCase() === key) : tags;
  return kept.some((t) => t.name.toLowerCase() === key) ? kept : [...kept, tag];
}

/** The current tags of an item shown somewhere, ours first. */
export function currentTags(e: FileEntry): Tag[] {
  return useTags.getState().byPath.get(e.path) ?? e.tags ?? [];
}

/** Folders up to this size are scanned for tags without a colour as they load. */
const SCAN_ALWAYS_MAX = 3000;

/**
 * Reads the full tags of a settled listing's items, once per listing, so
 * tags without a colour show up. Big folders are only scanned while
 * `wanted` (a tag filter or tag grouping needs them) or when `refresh`
 * changes (the user asked for a refresh).
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
          // A scan that overlapped an edit of ours may predate it; the
          // next listing change scans again.
          if (stale || !readStillFresh(mark)) return;
          // An item the scan found nothing on keeps an override only to
          // clear tags the listing still shows from before an edit.
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
    // A new listing (or the same one re-read) or a refresh calls for a scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, scan, refresh]);
}
