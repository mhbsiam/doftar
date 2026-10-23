import { create } from "zustand";
import type { Step } from "../types";

const LIMIT = 50;

export interface HistoryEntry {
  label: string;
  steps: Step[];
}

interface HistoryStore {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  busy: boolean;
  record: (label: string, steps: Step[]) => HistoryEntry;
  settle: (dir: "undo" | "redo", entry: HistoryEntry, inverse: Step[]) => void;
  discard: (dir: "undo" | "redo", entry: HistoryEntry) => void;
  setBusy: (busy: boolean) => void;
}

const capped = (list: HistoryEntry[]) => list.slice(-LIMIT);
const without = (list: HistoryEntry[], entry: HistoryEntry) =>
  list.filter((e) => e !== entry);

export const useHistory = create<HistoryStore>((set) => ({
  undo: [],
  redo: [],
  busy: false,
  record: (label, steps) => {
    const entry = { label, steps };
    set((s) => ({ undo: capped([...s.undo, entry]), redo: [] }));
    return entry;
  },
  settle: (dir, entry, inverse) =>
    set((s) => {
      const from = without(dir === "undo" ? s.undo : s.redo, entry);
      const mirror: HistoryEntry[] = inverse.length
        ? [...(dir === "undo" ? s.redo : s.undo), { label: entry.label, steps: inverse }]
        : dir === "undo"
          ? s.redo
          : s.undo;
      return dir === "undo"
        ? { undo: from, redo: capped(mirror) }
        : { redo: from, undo: capped(mirror) };
    }),
  discard: (dir, entry) =>
    set((s) =>
      dir === "undo" ? { undo: without(s.undo, entry) } : { redo: without(s.redo, entry) }
    ),
  setBusy: (busy) => set({ busy }),
}));

export const topOf = (list: HistoryEntry[]): HistoryEntry | undefined =>
  list[list.length - 1];
