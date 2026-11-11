import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../ipc";
import type { FileEntry, GitInfo } from "../types";

/** Git status by folder path. null if the folder is not in a repository. */
export const useGit = create<{ byDir: Record<string, GitInfo | null> }>(() => ({ byDir: {} }));

/** Number of panes that show each folder. At zero the status is dropped. */
const shown = new Map<string, number>();

/** Wait for a streaming listing to settle before the status read. */
const SETTLE_MS = 120;

/** Keep the Git status current. A commit in a terminal changes only `.git`, so reload on focus. */
export function useGitWatch(dir: string | null, entries: FileEntry[], tick: number) {
  useEffect(() => {
    if (!dir) return;
    shown.set(dir, (shown.get(dir) ?? 0) + 1);
    return () => {
      const n = (shown.get(dir) ?? 1) - 1;
      if (n > 0) return void shown.set(dir, n);
      shown.delete(dir);
      useGit.setState((s) => {
        const { [dir]: _, ...rest } = s.byDir;
        return { byDir: rest };
      });
    };
  }, [dir]);

  useEffect(() => {
    if (!dir) return;
    let cancelled = false;
    const load = () =>
      void api
        .gitInfo(dir)
        .catch(() => null)
        .then((info) => {
          if (!cancelled && shown.has(dir)) {
            useGit.setState((s) => ({ byDir: { ...s.byDir, [dir]: info } }));
          }
        });
    const timer = setTimeout(load, SETTLE_MS);
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("focus", load);
    };
  }, [dir, entries, tick]);
}
