import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { api } from "../ipc";
import { parentOf } from "../stores/tabs";
import { useAppData } from "../stores/appdata";
import { applyOps, useOptimistic } from "../stores/optimistic";
import { useTags } from "../stores/tags";
import { useWriting } from "../stores/writing";
import { sameTags } from "../util/tags";
import { rememberListing, takeFreshListing } from "../stores/prefetch";
import type { FileEntry, Location } from "../types";

const EMPTY: FileEntry[] = [];

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
  // The folder on screen. A reload of it swaps in the new list in one step, with no shrink.
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
    // Show a remembered listing while the real load runs. Check its stamp against the folder stamp,
    // so it cannot show items that are gone or miss new ones.
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
    // An unwatch can arrive before its watch and find nothing to release. Make each unwatch wait for its watch.
    const watching = new Map<string, Promise<unknown>>();
    const watch = (d: string) => watching.set(d, api.watchPath(d).catch(() => {}));
    const unwatch = (d: string) => {
      const w = watching.get(d);
      watching.delete(d);
      void w?.then(() => api.unwatchPath(d).catch(() => {}));
    };
    const syncExtraWatches = (next: string[]) => {
      for (const d of extras) if (!next.includes(d)) unwatch(d);
      for (const d of next) if (!extras.includes(d)) watch(d);
      extras = next;
    };
    // Loads overlap. An older load that ends last must not overwrite the newer listing.
    let seq = 0;
    // A newer load, or leaving the folder, cancels the stream. The backend then stops sending rows.
    let stream: { cancel: () => void } | null = null;
    // Ask once per visit, so a second "Don't Allow" or a refocus does not ask again.
    let askedAccess = false;
    const load = async () => {
      stream?.cancel();
      stream = null;
      const my = ++seq;
      const live = () => !cancelled && my === seq;
      // Changes made before this load are in the listing it reads.
      const caughtUp = useOptimistic.getState().mark();
      // Get the stamp before the read. If the folder changes during the read, the saved copy then looks old.
      const stamp = await api.dirStamp(path).catch(() => null);
      if (!live()) return;
      let progressive = shownFor.current !== path;
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
        setLoadedPath(path);
      };
      try {
        const running = api.listDirStream(path, showHidden, (batch) => {
          if (!live()) return;
          for (const e of batch) acc.push(e);
          // Keep a remembered listing on screen until the whole new one is in.
          if (lastFlush === 0 && shownFor.current === path) progressive = false;
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
          // Commit the listing before dropping its changes. The store renders first otherwise, and a removed row comes back for one frame.
          flushSync(() => {
            // A refresh that finds nothing new keeps the same list, so nothing sorts or renders again.
            setEntries((prev) => (sameListing(prev, e) ? prev : e));
            setError(null);
          });
          useOptimistic.getState().clear(path, caughtUp);
          rememberListing(path, showHidden, e, stamp);
        }
      } catch (err) {
        if (flushTimer) clearTimeout(flushTimer);
        // EPERM means macOS privacy blocks the folder. Ask for access again. Do not point to Settings.
        if (!askedAccess && /\(os error 1\)/.test(String(err)) && live()) {
          askedAccess = true;
          if ((await api.requestFolderAccess(path).catch(() => false)) && live()) {
            void load();
            return;
          }
        }
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
    const own = api.watchPath(path).catch(() => {});

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
        setEntries((prev) => {
          for (const e of prev) {
            const now = byPath.get(e.path);
            if (now && now.size > e.size) useWriting.getState().mark(e.path);
          }
          return prev.map((e) => byPath.get(e.path) ?? e);
        });
        // A stat reads every tag, so it replaces older tag data. This shows tags changed in Finder.
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
      void own.then(() => api.unwatchPath(path).catch(() => {}));
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
