import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../ipc";
import { useSettings } from "./settings";

interface FileIdStore {
  byPath: Record<string, string>;
  /** Paths whose lookup has finished, whether or not it found an id. */
  settled: Record<string, true>;
  /** Looks `paths` up again and records any ids that changed. */
  refresh: (paths: string[]) => Promise<void>;
}

/** Path → file id, for places that only know a path (tabs, pins, dialogs). */
export const useFileIds = create<FileIdStore>((set, get) => ({
  byPath: {},
  settled: {},
  refresh: async (paths) => {
    if (paths.length === 0) return;
    let ids: (string | null)[] = [];
    try {
      ids = await api.fileIds(paths);
    } catch {
      // Leave the paths unresolved; they are still marked settled below.
    }
    const cur = get().byPath;
    let byPath: Record<string, string> | null = null;
    paths.forEach((p, i) => {
      const id = ids[i];
      if (id && cur[p] !== id) (byPath ??= { ...cur })[p] = id;
    });
    const seen = get().settled;
    const fresh = paths.filter((p) => !seen[p]);
    set({
      ...(byPath ? { byPath } : {}),
      ...(fresh.length
        ? { settled: { ...seen, ...Object.fromEntries(fresh.map((p) => [p, true as const])) } }
        : {}),
    });
  },
}));

interface Identified {
  path: string;
  fileId?: string;
}

/**
 * File ids for `items`: the one the entry already carries, else a looked-up
 * one. Looked-up ids are re-checked on mount so a folder replaced at the same
 * path doesn't inherit the old folder's color.
 */
export function useFileIdsFor(items: Identified[]): (string | undefined)[] {
  const byPath = useFileIds((s) => s.byPath);
  const missing = items.filter((i) => !i.fileId).map((i) => i.path);
  const key = missing.join("\n");
  useEffect(() => {
    if (key) void useFileIds.getState().refresh(key.split("\n"));
  }, [key]);
  return items.map((i) => i.fileId ?? byPath[i.path]);
}

/** Moves folder colors saved under paths (older versions) onto file ids. */
export async function migrateFolderColors() {
  const legacy = useSettings.getState().legacyFolderColors;
  const paths = Object.keys(legacy);
  if (paths.length === 0) return;
  let ids: (string | null)[];
  try {
    ids = await api.fileIds(paths);
  } catch {
    return;
  }
  const colors = { ...useSettings.getState().folderColors };
  paths.forEach((p, i) => {
    const id = ids[i];
    if (id && !colors[id]) colors[id] = legacy[p];
  });
  useSettings.getState().set({ folderColors: colors, legacyFolderColors: {} });
}
