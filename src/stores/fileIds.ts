import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../ipc";
import { useSettings } from "./settings";

interface FileIdStore {
  byPath: Record<string, string>;
  /** Paths whose lookup is done, with or without an id. */
  settled: Record<string, true>;
  refresh: (paths: string[]) => Promise<void>;
}

/** File id by path, for places that know only a path. */
export const useFileIds = create<FileIdStore>((set, get) => ({
  byPath: {},
  settled: {},
  refresh: async (paths) => {
    if (paths.length === 0) return;
    let ids: (string | null)[] = [];
    try {
      ids = await api.fileIds(paths);
    } catch {
      // Leave the paths unresolved.
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
 * Returns the file id of each item. Re-checks looked-up ids on mount, so a new folder
 * at an old path does not inherit the old folder color.
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

/** Move folder colors saved by path in old versions to file ids. */
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
  // Keep colors of folders not found now, for example on an unmounted drive.
  const unresolved = Object.fromEntries(paths.filter((_, i) => !ids[i]).map((p) => [p, legacy[p]]));
  useSettings.getState().set({ folderColors: colors, legacyFolderColors: unresolved });
}
