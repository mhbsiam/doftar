import { create } from "zustand";
import { api } from "../ipc";
import type { Step } from "../types";

const LIMIT = 50;
const LOG_LIMIT = 100;

export interface HistoryEntry {
  /** Stays the same through undo and redo. */
  id: number;
  label: string;
  steps: Step[];
  at: number;
  /** Items acted on when the steps do not show them, for example the originals of a copy. */
  sources?: string[];
  /** In the log: true for the entry undone last. */
  undone?: boolean;
}

export type SavedEntry = Pick<HistoryEntry, "label" | "steps" | "sources"> & { at?: number };

interface HistoryStore {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  /** Every file action, oldest first. An entry with no steps cannot be undone. */
  log: HistoryEntry[];
  /** Label of the window that runs an undo or redo. null if none. */
  busy: string | null;
  record: (label: string, steps: Step[], sources?: string[]) => HistoryEntry;
  /** Log an action that cannot be undone, for example a permanent delete. */
  logOnly: (label: string, sources: string[]) => void;
  clearLog: () => void;
  /** Move the part of `entry` that ran (`inverse`) to the other stack. `left` stays. */
  settle: (dir: "undo" | "redo", entry: HistoryEntry, inverse: Step[], left?: Step[]) => void;
  setBusy: (busy: string | null) => void;
  /** Set the stacks from saved ones, unless this session has entries. */
  restore: (undo: SavedEntry[], activity?: SavedEntry[]) => void;
}

const capped = (list: HistoryEntry[]) => list.slice(-LIMIT);
/** Discard hidden items that a replace on a network share set aside. No entry can restore them. */
const forget = (entries: HistoryEntry[]) => {
  const paths = entries.flatMap((e) => e.steps.map((s) => (s.kind === "trash" ? s.path : s.from)));
  if (paths.length) void api.discardAsides(paths).catch(() => {});
};
/** `after` is `before` capped. The difference is what fell off the front. */
const trimmed = (before: HistoryEntry[], after: HistoryEntry[]) => before.slice(0, before.length - after.length);
// Compare by id. Another window sends new copies of every entry.
const without = (list: HistoryEntry[], entry: HistoryEntry) =>
  list.filter((e) => e.id !== entry.id);
// Each window numbers its own entries into one shared history, so ids start at random.
let nextId = Math.floor(Math.random() * 2 ** 32) * 2 ** 20;
const make = (label: string, steps: Step[], sources?: string[], at = Date.now()): HistoryEntry =>
  sources ? { id: nextId++, label, steps, at, sources } : { id: nextId++, label, steps, at };

let restoring = false;
/** True while `restore` loads history from disk. This is not a change to share. */
export const isRestoring = () => restoring;

export const useHistory = create<HistoryStore>((set) => ({
  undo: [],
  redo: [],
  log: [],
  busy: null,
  record: (label, steps, sources) => {
    const entry = make(label, steps, sources);
    set((s) => {
      const undo = capped([...s.undo, entry]);
      forget([...s.redo, ...trimmed([...s.undo, entry], undo)]);
      return { undo, redo: [], log: [...s.log, entry].slice(-LOG_LIMIT) };
    });
    return entry;
  },
  logOnly: (label, sources) => set((s) => ({ log: [...s.log, make(label, [], sources)].slice(-LOG_LIMIT) })),
  clearLog: () =>
    set((s) => {
      forget([...s.undo, ...s.redo]);
      return { log: [], undo: [], redo: [] };
    }),
  settle: (dir, entry, inverse, left = []) =>
    set((s) => {
      const list = dir === "undo" ? s.undo : s.redo;
      const from = left.length
        ? list.map((e) => (e.id === entry.id ? { ...entry, steps: left } : e))
        : without(list, entry);
      const other = dir === "undo" ? s.redo : s.undo;
      // The half that a cancelled undo or redo left takes this half back, so an id stays one entry.
      const half = other.find((e) => e.id === entry.id);
      const mirror: HistoryEntry[] = inverse.length
        ? [...other.filter((e) => e.id !== entry.id), { ...entry, steps: half ? [...inverse, ...half.steps] : inverse }]
        : other;
      const log = inverse.length
        ? s.log.map((e) => (e.id === entry.id ? { ...e, undone: dir === "undo" } : e))
        : s.log;
      const kept = capped(mirror);
      forget(trimmed(mirror, kept));
      return dir === "undo" ? { undo: from, redo: kept, log } : { redo: from, undo: kept, log };
    }),
  setBusy: (busy) => set({ busy }),
  restore: (saved, activity = []) => {
    restoring = true;
    try {
      set((s) => {
        if (s.undo.length || (!saved.length && !activity.length)) return s;
        const undo = capped(saved.map((e) => make(e.label, e.steps, e.sources, e.at ?? 0)));
        const done = activity.map((e) => make(e.label, [], e.sources, e.at ?? 0));
        const log = [...done, ...undo].sort((a, b) => a.at - b.at);
        return { undo, log: [...log, ...s.log].slice(-LOG_LIMIT) };
      });
    } finally {
      restoring = false;
    }
  },
}));

export const topOf = (list: HistoryEntry[]): HistoryEntry | undefined =>
  list[list.length - 1];

const name = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const TRASH = /\/\.Trash(?:es\/\d+)?(?:\/|$)/;
const what = (paths: string[]) => (paths.length === 1 ? `"${name(paths[0])}"` : `${paths.length} items`);

export function placeName(dir: string, home: string): string {
  if (TRASH.test(dir + "/")) return "the Trash";
  if (home && dir === home) return "~";
  return home && dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir;
}

/** Describe an entry from the steps that undo it. */
export function summarize(e: HistoryEntry): { items: string[]; from?: string; to?: string; renamed?: string } {
  const first = e.steps[0];
  const sources = e.sources?.length ? e.sources : undefined;
  if (!first) return { items: sources ?? [], from: sources && dirOf(sources[0]) };
  if (first.kind === "move" && e.steps.every((s) => s.kind === "move" && dirOf(s.from) === dirOf(s.to))) {
    return {
      items: e.steps.map((s) => (s.kind === "move" ? s.to : "")),
      to: dirOf(first.from),
      renamed: e.steps.length === 1 ? name(first.from) : undefined,
    };
  }
  // Skip steps that restore items from the Trash, unless they are all the steps.
  const own = e.steps.filter((s) => !(s.kind === "move" && TRASH.test(s.from)));
  const lead = own[0] ?? first;
  const items = sources ?? (own.length ? own : e.steps).map((s) => (s.kind === "trash" ? s.path : s.to));
  const to = dirOf(lead.kind === "trash" ? lead.path : lead.from);
  const from = sources ? dirOf(sources[0]) : lead.kind === "move" ? dirOf(lead.to) : undefined;
  return { items, from, to };
}

/** Paths to look up. Their file ids show if `steps` can still run. */
export function stepEnds(steps: Step[]): string[] {
  return steps.flatMap((s) => (s.kind === "trash" ? [s.path, s.path, s.path] : [s.from, s.to, dirOf(s.to)]));
}

/**
 * Returns the steps that cannot run. The item is gone or replaced, another item is at the
 * old place, or the folder is gone. `ids` are the file ids of `stepEnds(steps)`.
 */
export function staleSteps(steps: Step[], ids: (string | null)[]): Step[] {
  // Paths that an earlier step empties. Undoing a replace trashes the newcomer first.
  const freed = new Set<string>();
  // Paths that an earlier step fills, for example a folder that gets its contents back.
  const filled = new Set<string>();
  return steps.filter((s, i) => {
    const here = ids[3 * i];
    const there = ids[3 * i + 1];
    const parent = ids[3 * i + 2];
    const stale =
      here == null ||
      (s.kind !== "copy" && !!s.id && s.id !== here) ||
      // A case-only rename finds its own item at the old name.
      (s.kind !== "trash" && there != null && there !== here && !freed.has(s.to)) ||
      (s.kind !== "trash" && parent == null && !filled.has(dirOf(s.to)));
    if (!stale) {
      freed.add(s.kind === "trash" ? s.path : s.from);
      if (s.kind !== "trash") filled.add(s.to);
    }
    return stale;
  });
}

export function undoQuestion(steps: Step[], stale: Step[], home: string): string {
  const groups = new Map<string, { verb: (w: string) => string; paths: string[] }>();
  const add = (key: string, verb: (w: string) => string, path: string) => {
    const g = groups.get(key) ?? { verb, paths: [] };
    g.paths.push(path);
    groups.set(key, g);
  };
  const skip = new Set(stale);
  const run = steps.filter((s) => !skip.has(s));
  for (const s of run) {
    if (s.kind === "trash") {
      add("trash", (w) => `move ${w} to the Trash`, s.path);
      continue;
    }
    const dir = dirOf(s.to);
    if (s.kind === "copy") add(`copy:${dir}`, (w) => `copy ${w} back to ${placeName(dir, home)}`, s.from);
    else if (dir === dirOf(s.from)) {
      if (run.length === 1) add("rename", () => `rename "${name(s.from)}" back to "${name(s.to)}"`, s.from);
      else add("rename", (w) => `rename ${w} back`, s.from);
    } else if (TRASH.test(s.to)) add("totrash", (w) => `move ${w} back to the Trash`, s.from);
    else if (TRASH.test(s.from)) add(`back:${dir}`, (w) => `put ${w} back in ${placeName(dir, home)}`, s.from);
    else add(`move:${dir}`, (w) => `move ${w} back to ${placeName(dir, home)}`, s.from);
  }
  const parts = [...groups.values()].map((g) => g.verb(what(g.paths)));
  const said = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "";
  const question = said.charAt(0).toUpperCase() + said.slice(1) + "?";
  if (stale.length === 0) return question;
  const n = stale.length;
  return `${question} ${n === 1 ? `"${name(stale[0].kind === "trash" ? stale[0].path : stale[0].from)}" has` : `${n} other items have`} changed or moved since and ${n === 1 ? "stays" : "stay"} as ${n === 1 ? "it is" : "they are"}.`;
}
