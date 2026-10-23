import { useEffect, useState } from "react";
import { api } from "../ipc";
import type { FileEntry } from "../types";

const EMPTY: FileEntry[] = [];
const DEBOUNCE_MS = 200;

let nextSearchId = 1;

export interface SearchState {
  entries: FileEntry[];
  searching: boolean;
  truncated: boolean;
  error: string | null;
}

const IDLE: SearchState = { entries: EMPTY, searching: false, truncated: false, error: null };
const STARTING: SearchState = { entries: EMPTY, searching: true, truncated: false, error: null };

export function useSearch(
  root: string | null,
  query: string,
  showHidden: boolean,
  active: boolean
): SearchState {
  const q = query.trim();
  const key = active && root && q ? `${root}\0${q}\0${showHidden}` : null;
  // `key` says which search the state answers.
  const [state, setState] = useState<SearchState & { key: string | null }>({ ...IDLE, key: null });

  useEffect(() => {
    if (key === null || root === null) {
      setState((s) => (s.key === null && s.entries === EMPTY ? s : { ...IDLE, key: null }));
      return;
    }
    const id = nextSearchId++;
    let stale = false;
    let started = false;
    let replied = false;
    // The reply can arrive before the last batches; the search is only done
    // once all `count` results are in.
    let received = 0;
    let expected: number | null = null;
    let truncated = false;
    let lateTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (stale || expected === null || received < expected) return;
      if (lateTimer) clearTimeout(lateTimer);
      expected = null;
      setState((s) => ({ ...s, searching: false, truncated }));
    };
    setState({ ...STARTING, key });
    const timer = setTimeout(() => {
      started = true;
      api
        .searchDir(root, q, showHidden, id, (batch) => {
          if (stale) return;
          received += batch.length;
          setState((s) => ({ ...s, entries: s.entries === EMPTY ? batch : [...s.entries, ...batch] }));
          finish();
        })
        .then((sum) => {
          replied = true;
          if (stale) return;
          truncated = sum.truncated;
          expected = sum.count;
          finish();
          // Batches that never come (the channel dropped) mustn't leave the
          // search hanging: settle with what arrived.
          if (expected !== null) {
            lateTimer = setTimeout(() => {
              expected = received;
              finish();
            }, 2000);
          }
        })
        .catch((err) => {
          replied = true;
          if (!stale) setState((s) => ({ ...s, searching: false, error: String(err) }));
        });
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
      if (lateTimer) clearTimeout(lateTimer);
      // Only a search still running needs stopping.
      if (started && !replied) void api.cancelSearch(id).catch(() => {});
    };
    // `key` stands for root, q and showHidden.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Until the effect catches up with new inputs, the state is the last
  // search's; say a search is starting instead, so nothing reads the old
  // (or empty) results as this one's answer.
  return key === null ? IDLE : state.key === key ? state : STARTING;
}
