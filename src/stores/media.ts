import { create } from "zustand";
import { api } from "../ipc";
import { fileKind } from "../util/kinds";
import type { FileEntry, MediaInfo } from "../types";

export { formatDuration, formatFps } from "../util/format";

interface MediaStore {
  /** null if the file has no info. */
  byPath: Map<string, MediaInfo | null>;
  rev: number;
  fetch: (paths: string[]) => Promise<void>;
}

const MAX_PATHS = 20_000;
const asked = new Set<string>();

export const useMedia = create<MediaStore>((set, get) => ({
  byPath: new Map(),
  rev: 0,
  fetch: async (paths) => {
    const fresh = paths.filter((p) => !asked.has(p));
    if (fresh.length === 0) return;
    fresh.forEach((p) => asked.add(p));
    const infos = await api.mediaInfo(fresh).catch(() => null);
    if (!infos) {
      fresh.forEach((p) => asked.delete(p));
      return;
    }
    const byPath = get().byPath;
    if (byPath.size > MAX_PATHS) {
      byPath.clear();
      asked.clear();
      fresh.forEach((p) => asked.add(p));
    }
    fresh.forEach((p, i) => byPath.set(p, infos[i] ?? null));
    set({ byPath, rev: get().rev + 1 });
  },
}));

export const isMedia = (e: FileEntry) => !e.isDir && ["video", "audio", "image"].includes(fileKind(e.ext));

export function useMediaOf(path: string | null): MediaInfo | null {
  return useMedia((s) => (path ? (s.byPath.get(path) ?? null) : null));
}

