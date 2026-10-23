import { api } from "../ipc";
import { useFileIds } from "./fileIds";
import { useSettings } from "./settings";
import type { FileEntry } from "../types";

/**
 * Recent folder listings, kept so opening a folder again (or one the pointer
 * just rested on) shows its rows at once while the real listing loads in the
 * background and quietly replaces them.
 */

/** How long a remembered listing may be shown ahead of the real one. */
const TTL_MS = 60_000;
/** Hover prefetch skips folders bigger than this: too much to ship on a hover. */
const MAX_PREFETCH_ENTRIES = 5_000;
/** Rows kept across all remembered listings, so the cache can't balloon. */
const ROW_BUDGET = 150_000;
const MAX_FOLDERS = 12;

interface Hit {
  entries: FileEntry[];
  at: number;
  showHidden: boolean;
  /** The folder's `dirStamp` from before the listing was read. */
  stamp: string | null;
}

// Insertion order is recency: `take` and `remember` move an entry to the end.
const cache = new Map<string, Hit>();
const inflight = new Set<string>();

function evict() {
  let rows = 0;
  for (const h of cache.values()) rows += h.entries.length;
  while (cache.size > MAX_FOLDERS || (rows > ROW_BUDGET && cache.size > 1)) {
    const oldest = cache.keys().next().value as string;
    rows -= cache.get(oldest)!.entries.length;
    cache.delete(oldest);
  }
}

const isTrash = (path: string) => /\/\.Trash(es)?(\/|$)/.test(path);

/**
 * Remembers a folder's finished listing for its next visit. `stamp` is the
 * folder's `dirStamp` taken before the listing was read, so a change during
 * the read makes the entry look out of date, never wrongly current.
 */
export function rememberListing(
  path: string,
  showHidden: boolean,
  entries: FileEntry[],
  stamp: string | null
) {
  if (isTrash(path) || stamp === null) return;
  cache.delete(path);
  cache.set(path, { entries, at: Date.now(), showHidden, stamp });
  evict();
}

/** Fetches `path`'s listing ahead of a likely click. */
export function prefetchListing(path: string) {
  if (isTrash(path) || inflight.has(path)) return;
  const showHidden = useSettings.getState().showHidden;
  const hit = cache.get(path);
  if (hit && hit.showHidden === showHidden && Date.now() - hit.at < TTL_MS) return;
  inflight.add(path);
  void useFileIds.getState().refresh([path]); // the folder's saved view needs its id
  api
    .dirStamp(path)
    .then(async (stamp) => {
      const entries = await api.listDirCapped(path, showHidden, MAX_PREFETCH_ENTRIES);
      if (entries) rememberListing(path, showHidden, entries, stamp);
    })
    .catch(() => {})
    .finally(() => inflight.delete(path));
}

/**
 * The remembered listing for `path`, if it is recent and the folder hasn't had
 * items added, removed or renamed since: it is checked against the folder's
 * current `dirStamp`, so the rows shown are never for items that are gone or
 * miss ones that are new. Only details like a file's size or date can be a
 * moment behind, until the background reload replaces them.
 */
export async function takeFreshListing(
  path: string,
  showHidden: boolean
): Promise<FileEntry[] | null> {
  const hit = cache.get(path);
  if (!hit || hit.showHidden !== showHidden || Date.now() - hit.at >= TTL_MS) return null;
  const now = await api.dirStamp(path).catch(() => null);
  if (now === null || now !== hit.stamp) {
    if (cache.get(path) === hit) cache.delete(path);
    return null;
  }
  cache.delete(path); // mark as recently used
  cache.set(path, hit);
  return hit.entries;
}

/** Drops every remembered listing. */
export function clearPrefetch() {
  cache.clear();
}
