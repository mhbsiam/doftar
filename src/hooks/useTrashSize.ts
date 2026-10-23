import { useEffect, useRef, useState } from "react";
import { api } from "../ipc";
import { useTabs } from "../stores/tabs";

/** The Trash icon reads as full, and turns red, at this size. */
export const TRASH_LIMIT_BYTES = 15 * 1024 ** 3;

let nextJob = 3_000_000;

/** Bytes in the Trash, re-measured after file operations and when the window regains focus. */
export function useTrashSize(path: string | null): number | null {
  const [bytes, setBytes] = useState<number | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const refreshTick = useTabs((s) => s.refreshTick);
  const lastStamp = useRef<string | null>(null);

  useEffect(() => {
    const onFocus = () => setFocusTick((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (!path) return;
    let live = true;
    const id = nextJob++;
    // Debounced, so a burst of operations measures once.
    const timer = setTimeout(async () => {
      // Items enter and leave the Trash at its top level, which changes the
      // folder's stamp; if it hasn't, the last measurement still holds.
      const stamp = await api.dirStamp(path).catch(() => null);
      if (!live || (stamp !== null && stamp === lastStamp.current)) return;
      api
        .folderSize([path], id, () => {})
        .then((p) => {
          if (live && !p.cancelled) {
            lastStamp.current = stamp;
            setBytes(p.bytes);
          }
        })
        .catch(() => {});
    }, 500);
    return () => {
      live = false;
      clearTimeout(timer);
      void api.cancelSize(id).catch(() => {});
    };
  }, [path, refreshTick, focusTick]);

  return bytes;
}
