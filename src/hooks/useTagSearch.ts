import { useEffect, useRef, useState } from "react";
import { api } from "../ipc";
import { readMark, readStillFresh, useTags } from "../stores/tags";
import type { FileEntry } from "../types";
import type { SearchState } from "./useSearch";

const EMPTY: FileEntry[] = [];
const IDLE: SearchState = { entries: EMPTY, searching: false, truncated: false, error: null };

// Shares the id space and the cancel command with name searches.
let nextSearchId = 1_000_000_000;

/** Spotlight is late to show a tag change. A re-run after an edit waits this long. */
const EDIT_SETTLE_MS = 1500;
/** Minimum gap between re-runs when the window regains focus. */
const FOCUS_MIN_GAP_MS = 10_000;
const MAX_CACHED = 20;
const STORE_KEY = "doftar.tagged-items";

interface Cached {
  entries: FileEntry[];
  truncated: boolean;
  /** Time the search finished. 0 for results loaded from disk. */
  at: number;
}

/**
 * The last results of each query. A tag page shows them first and refreshes in place.
 * The Tags page query (every tag, everywhere) is also kept on disk.
 */
const cache = new Map<string, Cached>();

function queryKey(root: string | null, key: string, showHidden: boolean): string {
  return `${root ?? ""}\0${key}\0${showHidden}`;
}

function kept(root: string | null, key: string): boolean {
  return root === null && key === "";
}

try {
  const raw = localStorage.getItem(STORE_KEY);
  if (raw) {
    const saved = JSON.parse(raw) as { query: string; entries: FileEntry[]; truncated: boolean };
    if (typeof saved.query === "string" && Array.isArray(saved.entries)) {
      cache.set(saved.query, { entries: saved.entries, truncated: !!saved.truncated, at: 0 });
    }
  }
} catch {
}

function remember(query: string, persist: boolean, c: Cached) {
  cache.delete(query);
  cache.set(query, c);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  if (!persist) return;
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ query, entries: c.entries, truncated: c.truncated })
    );
  } catch {
  }
}

/**
 * Items with any of `names` (any tag if empty) under `root`, or everywhere Spotlight indexes if `root` is null.
 * Runs while `active`. `tick`, a finished tag edit and window focus run it again.
 * Remembered results show at once. The new run replaces them when it ends.
 */
export function useTagSearch(
  root: string | null,
  names: string[],
  showHidden: boolean,
  active: boolean,
  tick = 0
): SearchState {
  const key = names.join("\n");
  const query = queryKey(root, key, showHidden);
  // `for` is the query the state answers. It is null while inactive.
  const [state, setState] = useState<SearchState & { for: string | null }>(() => ({
    ...starting(query),
    for: active ? query : null,
  }));
  const lastQuery = useRef<string | null>(null);
  const running = useRef(false);

  // Our own tag edits run the search again after Spotlight catches up.
  const edits = useTags((s) => s.edits);
  const [settledEdits, setSettledEdits] = useState(edits);
  useEffect(() => {
    if (edits === settledEdits) return;
    const t = setTimeout(() => setSettledEdits(edits), EDIT_SETTLE_MS);
    return () => clearTimeout(t);
  }, [edits, settledEdits]);

  // Window focus picks up tags changed in Finder or elsewhere.
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const onFocus = () => {
      if (running.current) return;
      const c = lastQuery.current !== null ? cache.get(lastQuery.current) : undefined;
      if (c && Date.now() - c.at < FOCUS_MIN_GAP_MS) return;
      setFocusTick((n) => n + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active]);

  useEffect(() => {
    if (!active) {
      lastQuery.current = null;
      setState((s) => (s.for === null && s.entries === EMPTY && !s.searching ? s : { ...IDLE, for: null }));
      return;
    }
    const id = nextSearchId++;
    let stale = false;
    const cached = cache.get(query);
    // Keep remembered results and swap in the new ones at once, so counts do not jump.
    // A re-run keeps its old results until the first new batch comes.
    const buffered = cached !== undefined;
    const rerun = lastQuery.current === query;
    lastQuery.current = query;
    running.current = true;
    setState((s) => ({
      entries: cached ? cached.entries : rerun ? s.entries : EMPTY,
      searching: true,
      truncated: cached?.truncated ?? false,
      error: null,
      for: query,
    }));
    const found: FileEntry[] = [];
    const mark = readMark();
    // The reply can arrive before the last batches. The search is done only when all `count` results are in.
    let expected: number | null = null;
    let truncated = false;
    let lateTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (stale || expected === null || found.length < expected) return;
      if (lateTimer) clearTimeout(lateTimer);
      expected = null;
      running.current = false;
      const entries = found.length > 0 ? found : EMPTY;
      // These tags were just read from the item, so they replace older tags in the store.
      // Skip this if one of our own edits ran meanwhile.
      if (readStillFresh(mark)) {
        useTags.getState().put(entries.map((e) => [e.path, e.tags ?? []]));
      }
      remember(query, kept(root, key), { entries, truncated, at: Date.now() });
      setState({ entries, searching: false, truncated, error: null, for: query });
    };
    let replied = false;
    api
      .searchTags(root, key ? key.split("\n") : [], showHidden, id, (batch) => {
        if (stale) return;
        const first = found.length === 0;
        for (const e of batch) found.push(e);
        if (!buffered) {
          setState((s) => ({ ...s, entries: first ? batch : [...s.entries, ...batch] }));
        }
        finish();
      })
      .then((sum) => {
        replied = true;
        if (stale) return;
        truncated = sum.truncated;
        expected = sum.count;
        finish();
        // The batches may never come if the channel drops. Settle with the results that arrived.
        if (expected !== null) {
          lateTimer = setTimeout(() => {
            expected = found.length;
            finish();
          }, 2000);
        }
      })
      .catch((err) => {
        replied = true;
        if (stale) return;
        running.current = false;
        setState((s) => ({ ...s, searching: false, error: String(err) }));
      });
    return () => {
      stale = true;
      running.current = false;
      if (lateTimer) clearTimeout(lateTimer);
      if (!replied) void api.cancelSearch(id).catch(() => {});
    };
    // `query` covers root, key and showHidden.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, active, tick, settledEdits, focusTick]);

  // Until the effect runs for a new query, the state is the last one's.
  // Report a search as starting, so old results do not look like the answer.
  if (!active) return IDLE;
  return state.for === query ? state : starting(query);
}

function starting(query: string): SearchState {
  const c = cache.get(query);
  return { entries: c?.entries ?? EMPTY, searching: true, truncated: c?.truncated ?? false, error: null };
}
