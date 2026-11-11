import { create } from "zustand";
import { api } from "../ipc";

type ClipboardOp = "copy" | "cut";

export interface ClipEntry {
  op: ClipboardOp;
  paths: string[];
  at: number;
}

const MAX_HISTORY = 20;

const sameFiles = (a: string[], b: string[]) => a.length === b.length && a.every((p, i) => p === b[i]);

/** Put `entry` on top. The same files move up and do not repeat. */
export function withEntry(history: ClipEntry[], entry: ClipEntry): ClipEntry[] {
  return [entry, ...history.filter((e) => !sameFiles(e.paths, entry.paths))].slice(0, MAX_HISTORY);
}

interface ClipboardStore {
  op: ClipboardOp | null;
  paths: string[];
  changeCount: number;
  cutAt: number | null;
  /** Newest first. This session only. */
  history: ClipEntry[];
  copy: (paths: string[]) => Promise<void>;
  cut: (paths: string[]) => Promise<void>;
  sync: () => Promise<void>;
  clear: () => void;
  forget: (paths: string[]) => void;
  clearHistory: () => void;
}

export const useClipboard = create<ClipboardStore>((set, get) => ({
  op: null,
  paths: [],
  changeCount: -1,
  cutAt: null,
  history: [],
  copy: async (paths) => {
    const changeCount = await api.clipboardWriteFiles(paths);
    set({ op: "copy", paths, changeCount, cutAt: null, history: withEntry(get().history, { op: "copy", paths, at: Date.now() }) });
  },
  cut: async (paths) => {
    const changeCount = await api.clipboardWriteFiles(paths);
    set({ op: "cut", paths, changeCount, cutAt: changeCount, history: withEntry(get().history, { op: "cut", paths, at: Date.now() }) });
  },
  sync: async () => {
    try {
      const board = await api.clipboardReadFiles();
      const { cutAt, changeCount, history } = get();
      const stillCut = cutAt !== null && cutAt === board.changeCount;
      // Files from another app, such as Finder, join the history.
      const fresh = board.changeCount !== changeCount && board.paths.length > 0;
      set({
        history: fresh ? withEntry(history, { op: "copy", paths: board.paths, at: Date.now() }) : history,
        paths: board.paths,
        changeCount: board.changeCount,
        op: board.paths.length === 0 ? null : stillCut ? "cut" : "copy",
        cutAt: stillCut ? cutAt : null,
      });
    } catch {
    }
  },
  clear: () => set({ op: null, paths: [], cutAt: null }),
  forget: (paths) => set((s) => ({ history: s.history.filter((e) => !sameFiles(e.paths, paths)) })),
  clearHistory: () => set({ history: [] }),
}));

export function entryLabel(e: ClipEntry): string {
  const name = e.paths[0].split("/").filter(Boolean).pop() ?? e.paths[0];
  return e.paths.length > 1 ? `${name} and ${e.paths.length - 1} more` : name;
}

export function copiedAgo(at: number, now = Date.now()): string {
  const min = Math.floor((now - at) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

export function isPendingCut(e: ClipEntry): boolean {
  const s = useClipboard.getState();
  return s.op === "cut" && sameFiles(s.paths, e.paths);
}

export function useIsCut(path: string): boolean {
  return useClipboard((s) => s.op === "cut" && s.paths.includes(path));
}

/** Cancel a pending cut. A paste then copies. */
export function uncut() {
  const s = useClipboard.getState();
  if (s.op === "cut") useClipboard.setState({ op: "copy", cutAt: null });
}

if (typeof window !== "undefined") {
  const resync = () => void useClipboard.getState().sync();
  window.addEventListener("focus", resync);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) resync();
  });
  resync();
}
