import { useEffect } from "react";
import { api } from "../ipc";
import { usePane } from "../stores/tabs";
import type { FileEntry } from "../types";

// The backend keeps one watched set per window; each half of a split adds its rows.
const shown: string[][] = [[], []];
const send = (pane: number, paths: string[]) => {
  shown[pane] = paths;
  void api.watchFiles(shown.flat()).catch(() => {});
};

export function useVisibleFileWatch(entries: FileEntry[], first: number, last: number) {
  const pane = usePane();
  useEffect(() => {
    const paths = entries
      .slice(first, last)
      .filter((e) => !e.isDir)
      .map((e) => e.path);
    const t = setTimeout(() => send(pane, paths), 150);
    return () => clearTimeout(t);
  }, [entries, first, last, pane]);

  useEffect(() => () => send(pane, []), [pane]);
}
