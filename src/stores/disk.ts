import { create } from "zustand";
import { api } from "../ipc";
import { useAppData } from "./appdata";
import type { DiskReport, ScanProgress } from "../types";

const KEY = "doftar.disk-report";

function loadReport(): DiskReport | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DiskReport) : null;
  } catch {
    return null;
  }
}

function saveReport(report: DiskReport | null) {
  try {
    if (report) localStorage.setItem(KEY, JSON.stringify(report));
    else localStorage.removeItem(KEY);
  } catch {
  }
}

interface DiskStore {
  report: DiskReport | null;
  scanning: boolean;
  progress: ScanProgress | null;
  error: string | null;
  scan: () => Promise<void>;
  cancel: () => void;
  /** `sizes[i]` is the known size of `paths[i]` (see api.diskMapForget). */
  removeFiles: (paths: string[], sizes?: number[]) => void;
}

let nextScanId = 1;
let activeScan: number | null = null;

export const useDisk = create<DiskStore>((set, get) => ({
  report: loadReport(),
  scanning: false,
  progress: null,
  error: null,

  scan: async () => {
    if (get().scanning) return;
    const id = nextScanId++;
    activeScan = id;
    set({ scanning: true, progress: null, error: null });
    try {
      const report = await api.diskScan(useAppData.getState().home, id, (progress) =>
        set({ progress })
      );
      if (!report.cancelled) {
        saveReport(report);
        set({ report });
      }
    } catch (err) {
      set({ error: String(err) });
    } finally {
      activeScan = null;
      set({ scanning: false, progress: null });
    }
  },

  cancel: () => {
    if (activeScan !== null) void api.cancelDiskScan(activeScan).catch(() => {});
  },

  removeFiles: (paths, sizes = []) => {
    const report = get().report;
    if (!report) return;
    const within = (p: string, g: string) => p === g || p.startsWith(g + "/");
    const gone = (p: string) => paths.some((g) => within(p, g));
    const sized = paths.flatMap((path, i) => ((sizes[i] ?? 0) > 0 ? [{ path, bytes: sizes[i] }] : []));
    const counted = (p: string) => sized.some((s) => within(p, s.path));
    const devFolders = report.devFolders ?? [];
    const goneDevFolders = devFolders.filter((j) => gone(j.path));
    const removed = report.topFiles.filter((f) => gone(f.path));
    if (removed.length === 0 && goneDevFolders.length === 0 && sized.length === 0) return;
    // Count each byte once: a measured item, a developer folder, or another file.
    const pieces = [
      ...sized,
      ...goneDevFolders
        // A worktree can hold a developer folder of its own.
        .filter((j) => !counted(j.path) && !goneDevFolders.some((o) => o !== j && within(j.path, o.path)))
        .map((j) => ({ path: j.path, bytes: j.bytes })),
      ...removed
        .filter((f) => !counted(f.path) && !goneDevFolders.some((j) => f.path.startsWith(j.path + "/")))
        .map((f) => ({ path: f.path, bytes: f.size })),
    ];
    const bytes = pieces.reduce((n, p) => n + p.bytes, 0);
    // shortcut: developer folder bytes are not split by kind. The kinds keep them until the next scan.
    const categories = report.categories.map((c) => {
      const hit = removed.filter((f) => f.category === c.key);
      return hit.length === 0
        ? c
        : {
            ...c,
            bytes: Math.max(0, c.bytes - hit.reduce((n, f) => n + f.size, 0)),
            files: Math.max(0, c.files - hit.length),
          };
    });
    // Bytes in no top-level folder belong to a loose file.
    const dirs = report.folders.filter((f) => f.isDir);
    const folders = report.folders.filter((f) => !(f.isDir && gone(f.path))).map((folder) => {
      const inside = pieces.filter((p) =>
        folder.isDir ? within(p.path, folder.path) : !dirs.some((d) => within(p.path, d.path))
      );
      return inside.length === 0
        ? folder
        : { ...folder, bytes: Math.max(0, folder.bytes - inside.reduce((n, p) => n + p.bytes, 0)) };
    });
    const next: DiskReport = {
      ...report,
      totalBytes: Math.max(0, report.totalBytes - bytes),
      totalFiles: Math.max(0, report.totalFiles - removed.length),
      categories,
      folders,
      topFiles: report.topFiles.filter((f) => !gone(f.path)),
      devFolders: devFolders.filter((j) => !gone(j.path)),
    };
    saveReport(next);
    set({ report: next });
  },
}));
