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
  removeFiles: (paths: string[]) => void;
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

  removeFiles: (paths) => {
    const report = get().report;
    if (!report) return;
    const gone = new Set(paths);
    const removed = report.topFiles.filter((f) => gone.has(f.path));
    if (removed.length === 0) return;
    const bytes = removed.reduce((n, f) => n + f.size, 0);
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
    const folders = report.folders.map((folder) => {
      const inside = removed.filter((f) =>
        folder.isDir ? f.path.startsWith(folder.path + "/") : !f.path.slice(report.root.length + 1).includes("/")
      );
      return inside.length === 0
        ? folder
        : { ...folder, bytes: Math.max(0, folder.bytes - inside.reduce((n, f) => n + f.size, 0)) };
    });
    const next: DiskReport = {
      ...report,
      totalBytes: Math.max(0, report.totalBytes - bytes),
      totalFiles: Math.max(0, report.totalFiles - removed.length),
      categories,
      folders,
      topFiles: report.topFiles.filter((f) => !gone.has(f.path)),
    };
    saveReport(next);
    set({ report: next });
  },
}));
