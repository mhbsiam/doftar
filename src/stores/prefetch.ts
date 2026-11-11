import { api } from "../ipc";
import { useFileIds } from "./fileIds";
import { useSettings } from "./settings";
import type { FileEntry } from "../types";

/** Recent folder listings. They show at once when a folder opens again. The real listing then replaces them. */

const TTL_MS = 60_000;
/** Hover prefetch skips larger folders. They are too big to send on a hover. */
const MAX_PREFETCH_ENTRIES = 5_000;
/** Limit rows across all listings to keep the cache small. */
const ROW_BUDGET = 150_000;
const MAX_FOLDERS = 12;

interface Hit {
  entries: FileEntry[];
  at: number;
  showHidden: boolean;
  stamp: string | null;
}

// Insertion order is recency. `take` and `remember` move an entry to the end.
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
 * Remember a finished listing. `stamp` is the `dirStamp` from before the read, so a change
 * during the read makes the entry look old.
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

export function prefetchListing(path: string) {
  if (isTrash(path) || inflight.has(path)) return;
  const showHidden = useSettings.getState().showHidden;
  const hit = cache.get(path);
  if (hit && hit.showHidden === showHidden && Date.now() - hit.at < TTL_MS) return;
  inflight.add(path);
  void useFileIds.getState().refresh([path]); // The saved view needs the folder id.
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
 * Returns the remembered listing if it is recent and `dirStamp` is unchanged. Only details,
 * such as size or date, can be old.
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
  cache.delete(path); // Move to the end.
  cache.set(path, hit);
  return hit.entries;
}

export function clearPrefetch() {
  cache.clear();
}
