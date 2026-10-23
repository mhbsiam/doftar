import { create } from "zustand";
import { api } from "../ipc";

type ClipboardOp = "copy" | "cut";

interface ClipboardStore {
  op: ClipboardOp | null;
  paths: string[];
  changeCount: number;
  cutAt: number | null;
  copy: (paths: string[]) => Promise<void>;
  cut: (paths: string[]) => Promise<void>;
  sync: () => Promise<void>;
  clear: () => void;
}

export const useClipboard = create<ClipboardStore>((set, get) => ({
  op: null,
  paths: [],
  changeCount: -1,
  cutAt: null,
  copy: async (paths) => {
    const changeCount = await api.clipboardWriteFiles(paths);
    set({ op: "copy", paths, changeCount, cutAt: null });
  },
  cut: async (paths) => {
    const changeCount = await api.clipboardWriteFiles(paths);
    set({ op: "cut", paths, changeCount, cutAt: changeCount });
  },
  sync: async () => {
    try {
      const board = await api.clipboardReadFiles();
      const { cutAt } = get();
      const stillCut = cutAt !== null && cutAt === board.changeCount;
      set({
        paths: board.paths,
        changeCount: board.changeCount,
        op: board.paths.length === 0 ? null : stillCut ? "cut" : "copy",
        cutAt: stillCut ? cutAt : null,
      });
    } catch {
    }
  },
  clear: () => set({ op: null, paths: [], cutAt: null }),
}));

/**
 * Whether `path` is cut and waiting to be pasted: its row shows dimmed
 * meanwhile, and comes back once the cut is pasted, replaced by a copy, or
 * called off.
 */
export function useIsCut(path: string): boolean {
  return useClipboard((s) => s.op === "cut" && s.paths.includes(path));
}

/** Calls a pending cut off: what was cut stays, and a paste would copy it. */
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
