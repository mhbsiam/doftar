import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../ipc";
import { parentOf } from "../stores/tabs";
import { useAppData } from "../stores/appdata";
import { applyOps, useOptimistic } from "../stores/optimistic";
import { useTags } from "../stores/tags";
import { sameTags } from "../util/tags";
import { rememberListing, takeFreshListing } from "../stores/prefetch";
import type { FileEntry, Location } from "../types";

const EMPTY: FileEntry[] = [];

/** Whether two listings show the same rows (same items, names, sizes, dates). */
function sameListing(a: FileEntry[], b: FileEntry[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.path !== y.path ||
      x.modifiedMs !== y.modifiedMs ||
      x.size !== y.size ||
      x.isDir !== y.isDir ||
      x.isHidden !== y.isHidden ||
      !sameTags(x.tags, y.tags)
    ) {
      return false;
    }
  }
  return true;
}
const FOCUS_RELOAD_AFTER_MS = 2000;
/** Minimum gap between list updates while a big folder streams in. */
const STREAM_FLUSH_MS = 150;

export function useDirectory(
  location: Location,
  showHidden: boolean,
  tick: number
) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const path = location.kind === "path" ? location.path : null;
  const prevPath = useRef<string | null>(null);
  // The folder whose rows are on screen; a reload of it swaps in one go
  // instead of shrinking the list and streaming it back.
  const shownFor = useRef<string | null>(null);

  useEffect(() => {
    if (!path) {
      setEntries([]);
      setError(null);
      setLoadedPath(null);
      prevPath.current = null;
      shownFor.current = null;
      return;
    }
    if (prevPath.current !== path) {
      prevPath.current = path;
      shownFor.current = null;
      setEntries([]);
      setError(null);
      setLoadedPath(null);
    }
    let cancelled = false;
    // A remembered listing, checked against the folder's current stamp so it
    // can't show items that are gone or miss new ones. It paints while the
    // real load runs, and that load then replaces it quietly.
    if (shownFor.current !== path) {
      void takeFreshListing(path, showHidden).then((warm) => {
        if (!warm || cancelled || prevPath.current !== path || shownFor.current === path) return;
        shownFor.current = path;
        setEntries(warm);
        setLoadedPath(path);
      });
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const isHomeTrash = path === `${useAppData.getState().home}/.Trash`;
    let extras: string[] = [];
    const syncExtraWatches = (next: string[]) => {
      for (const d of extras) if (!next.includes(d)) void api.unwatchPath(d).catch(() => {});
      for (const d of next) if (!extras.includes(d)) void api.watchPath(d).catch(() => {});
      extras = next;
    };
    // Loads overlap (watcher, refocus, stat fallback); an older one that
    // resolves last must not overwrite the newer listing.
    let seq = 0;
    // The listing being streamed; a newer load or leaving the folder stops it,
    // so the backend doesn't keep shipping rows nobody will see.
    let stream: { cancel: () => void } | null = null;
    const load = async () => {
      stream?.cancel();
      stream = null;
      const my = ++seq;
      const live = () => !cancelled && my === seq;
      // Changes made before this load started are in the listing it reads.
      const caughtUp = useOptimistic.getState().mark();
      // Taken before the listing is read: if the folder changes during the
      // read, the remembered copy will look out of date rather than current.
      const stamp = await api.dirStamp(path).catch(() => null);
      if (!live()) return; // superseded or unmounted meanwhile: don't start a stream
      const progressive = shownFor.current !== path;
      const acc: FileEntry[] = [];
      let lastFlush = 0;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        flushTimer = null;
        if (!live()) return;
        lastFlush = Date.now();
        shownFor.current = path;
        setEntries(acc.slice());
        setError(null);
        // Rows can be shown while the rest is still arriving.
        setLoadedPath(path);
      };
      try {
        const running = api.listDirStream(path, showHidden, (batch) => {
          if (!live()) return;
          for (const e of batch) acc.push(e);
          if (!progressive) return;
          const wait = STREAM_FLUSH_MS - (Date.now() - lastFlush);
          if (lastFlush === 0 || wait <= 0) flush();
          else if (!flushTimer) flushTimer = setTimeout(flush, wait);
        });
        stream = running;
        await running.done;
        if (!live()) return;
        if (flushTimer) clearTimeout(flushTimer);
        let e: FileEntry[] = acc;
        if (isHomeTrash) {
          const dirs = (await api.trashDirs().catch(() => [])).filter((d) => d !== path);
          if (!cancelled) syncExtraWatches(dirs);
          const more = await Promise.all(
            dirs.map((d) => api.listDir(d, showHidden).catch(() => [] as FileEntry[]))
          );
          e = e.concat(...more);
        }
        if (live()) {
          shownFor.current = path;
          // A refresh that found nothing new keeps the same list, so nothing
          // re-sorts or re-renders.
          setEntries((prev) => (sameListing(prev, e) ? prev : e));
          setError(null);
          useOptimistic.getState().clear(path, caughtUp);
          rememberListing(path, showHidden, e, stamp);
        }
      } catch (err) {
        if (flushTimer) clearTimeout(flushTimer);
        if (live()) {
          shownFor.current = path;
          setEntries([]);
          setError(String(err));
        }
      } finally {
        if (live()) {
          setLoading(false);
          setLoadedPath(path);
        }
      }
    };

    setLoading(true);
    void load();
    void api.watchPath(path).catch(() => {});

    const touched = new Set<string>();
    let fileTimer: ReturnType<typeof setTimeout> | null = null;
    const unlistenFile = listen<string>("fs:file", (ev) => {
      const dir = parentOf(ev.payload);
      if (dir !== path && !(dir !== null && extras.includes(dir))) return;
      touched.add(ev.payload);
      if (fileTimer) clearTimeout(fileTimer);
      fileTimer = setTimeout(async () => {
        const batch = [...touched];
        touched.clear();
        const fresh = await api.statEntries(batch).catch(() => null);
        if (cancelled || !fresh) return;
        if (fresh.length < batch.length) {
          void load();
          return;
        }
        const byPath = new Map(fresh.map((e) => [e.path, e]));
        setEntries((prev) => prev.map((e) => byPath.get(e.path) ?? e));
        // A stat reads every tag, so it outranks what was known before
        // (tags changed in Finder show up here).
        useTags.getState().put(fresh.map((e) => [e.path, e.tags ?? []]));
      }, 100);
    });

    let blurredAt = 0;
    const onBlur = () => (blurredAt = Date.now());
    const onFocus = () => {
      if (blurredAt && Date.now() - blurredAt > FOCUS_RELOAD_AFTER_MS) void load();
      blurredAt = 0;
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);

    const unlisten = listen<string>("fs:changed", (ev) => {
      const hit = (dir: string) => ev.payload === dir || parentOf(ev.payload) === dir;
      if (hit(path) || extras.some(hit)) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void load(), 50);
      }
    });

    return () => {
      cancelled = true;
      stream?.cancel();
      void unlisten.then((f) => f());
      void unlistenFile.then((f) => f());
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      if (fileTimer) clearTimeout(fileTimer);
      if (timer) clearTimeout(timer);
      void api.unwatchPath(path).catch(() => {});
      syncExtraWatches([]);
    };
  }, [path, showHidden, tick]);

  const pending = useOptimistic((s) => (path ? s.ops[path] : undefined));
  const shown = useMemo(
    () => (pending && pending.length > 0 ? applyOps(entries, pending) : entries),
    [entries, pending]
  );
  const current = path !== null && loadedPath === path;
  return {
    entries: current ? shown : EMPTY,
    error: current ? error : null,
    loading: loading || (path !== null && !current),
    loadedPath,
  };
}
