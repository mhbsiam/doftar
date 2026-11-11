import { create } from "zustand";
import { api } from "../ipc";
import type { FavItem, PersistedStore, RecentItem, Step, TrashOrigin } from "../types";
import { useHistory, type HistoryEntry, type SavedEntry } from "./history";
import { useUI } from "./ui";

export interface CloudDrive {
  name: string;
  path: string;
}

/** Returns the first path on one of the drives, and that drive. */
export function inCloudDrive(
  paths: string[],
  drives: CloudDrive[]
): { path: string; drive: CloudDrive } | undefined {
  for (const path of paths) {
    const drive = drives.find((d) => path === d.path || path.startsWith(d.path + "/"));
    if (drive) return { path, drive };
  }
  return undefined;
}

/**
 * Where the item now at `path` came from, or null. `id` is its file id now.
 * Another item can land on a Trash path after the recorded one left.
 */
export function originOf(path: string, id: string | null, origins: Record<string, TrashOrigin>): string | null {
  const known = origins[path];
  return known && (!known.id || !id || known.id === id) ? known.origin : null;
}

const DEFAULT_HOME_PINS = ["Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures"];

export function defaultPinPaths(home: string): string[] {
  return DEFAULT_HOME_PINS.map((n) => `${home}/${n}`);
}

const MAX_RECENTS = 30;
// Fewer than recent files. Browsing adds one per folder.
// The command palette ranks all of them by visits. Home shows the newest `HOME_RECENT_FOLDERS`.
const MAX_RECENT_FOLDERS = 200;
export const HOME_RECENT_FOLDERS = 12;
const MAX_TRASH_ORIGINS = 500;

interface AppDataStore {
  /** `readOnly`: the saved store could not be read, so it is left as it is. */
  phase: "loading" | "ready" | "readOnly";
  home: string;
  pins: string[];
  cloudDrives: CloudDrive[];
  favorites: FavItem[];
  recents: RecentItem[];
  /** Newest first. Kept apart, so browsing does not push out opened files. */
  recentFolders: RecentItem[];
  trashOrigins: Record<string, TrashOrigin>;
  history: HistoryEntry[];
  activity: HistoryEntry[];
  init: () => Promise<void>;
  addRecent: (path: string) => void;
  addRecentFolder: (path: string) => void;
  toggleFavorite: (item: FavItem) => void;
  removePaths: (paths: string[]) => void;
  clearFavorites: () => void;
  clearRecents: () => void;
  clearRecentFolders: () => void;
  removeRecent: (path: string) => void;
  recordTrashOrigins: (moves: { trashed: string; origin: string; id?: string }[]) => void;
  forgetTrashOrigins: (trashed: string[]) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveFailed = false;

type Edit = (s: AppDataStore) => Partial<AppDataStore>;
/** Edits made before the saved data is in. They run on it, so they cannot replace it. */
const beforeLoad: Edit[] = [];

function edit(change: Edit) {
  if (useAppData.getState().phase === "loading") {
    beforeLoad.push(change);
    return;
  }
  useAppData.setState(change);
  persistSoon(useAppData.getState);
}

function save(content: string): Promise<void> {
  if (useAppData.getState().phase !== "ready") return Promise.resolve();
  return api.saveStore(content, savedAt()).then(
    () => {
      saveFailed = false;
    },
    (err) => {
      if (saveFailed) return;
      saveFailed = true;
      useUI.getState().pushToast(`Couldn't save favorites, recents and undo history: ${err}`, undefined, "error");
    }
  );
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function dirName(p: string): string {
  const idx = p.replace(/\/+$/, "").lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

function withRecent(list: RecentItem[], path: string, max: number): RecentItem[] {
  const visits = (list.find((r) => r.path === path)?.visits ?? 0) + 1;
  const item = { path, name: basename(path), dirName: dirName(path), ts: Date.now(), visits };
  return [item, ...list.filter((r) => r.path !== path)].slice(0, max);
}

function snapshot(get: () => AppDataStore): string {
  const { favorites, recents, recentFolders, trashOrigins, history, activity } = get();
  const blob: PersistedStore = { favorites, recents, recentFolders, trashOrigins, history, activity };
  return JSON.stringify(blob);
}

const isAbsolute = (v: unknown): v is string => typeof v === "string" && v.startsWith("/");

/** Keep only well-formed entries. A hand-edited file cannot inject other data. */
function validateStore(raw: unknown): PersistedStore | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const favorites = (Array.isArray(r.favorites) ? r.favorites : [])
    .filter(
      (f): f is FavItem =>
        !!f &&
        typeof f === "object" &&
        isAbsolute((f as FavItem).path) &&
        typeof (f as FavItem).name === "string" &&
        typeof (f as FavItem).dirName === "string" &&
        typeof (f as FavItem).modifiedMs === "number"
    )
    .map((f) => ({
      path: f.path,
      name: f.name,
      dirName: f.dirName,
      modifiedMs: f.modifiedMs,
      ...(typeof f.isDir === "boolean" ? { isDir: f.isDir } : {}),
    }));
  const recentItems = (list: unknown): RecentItem[] =>
    (Array.isArray(list) ? list : [])
      .filter(
        (x): x is RecentItem =>
          !!x &&
          typeof x === "object" &&
          isAbsolute((x as RecentItem).path) &&
          typeof (x as RecentItem).name === "string" &&
          typeof (x as RecentItem).dirName === "string" &&
          typeof (x as RecentItem).ts === "number"
      )
      .map((x) => ({
        path: x.path,
        name: x.name,
        dirName: x.dirName,
        ts: x.ts,
        ...(typeof x.visits === "number" ? { visits: x.visits } : {}),
      }));
  const recents = recentItems(r.recents);
  const recentFolders = recentItems(r.recentFolders);
  const trashOrigins: Record<string, TrashOrigin> = {};
  if (r.trashOrigins && typeof r.trashOrigins === "object") {
    for (const [k, v] of Object.entries(r.trashOrigins as Record<string, unknown>)) {
      if (!isAbsolute(k)) continue;
      // Older stores hold only the path.
      if (isAbsolute(v)) trashOrigins[k] = { origin: v };
      else if (v && typeof v === "object" && isAbsolute((v as TrashOrigin).origin)) {
        const { origin, id } = v as TrashOrigin;
        trashOrigins[k] = typeof id === "string" ? { origin, id } : { origin };
      }
    }
  }
  const isStep = (x: unknown): x is Step => {
    if (!x || typeof x !== "object") return false;
    const s = x as Record<string, unknown>;
    if (s.id !== undefined && typeof s.id !== "string") return false;
    if (s.kind === "trash") return isAbsolute(s.path);
    return (s.kind === "move" || s.kind === "copy") && isAbsolute(s.from) && isAbsolute(s.to);
  };
  // Undo entries need steps. Logged entries have none.
  const entries = (list: unknown, undoable: boolean): SavedEntry[] =>
    (Array.isArray(list) ? list : [])
      .filter(
        (e): e is Record<string, unknown> & { label: string; steps: Step[] } =>
          !!e &&
          typeof e === "object" &&
          typeof e.label === "string" &&
          Array.isArray(e.steps) &&
          (undoable ? e.steps.length > 0 && e.steps.every(isStep) : e.steps.length === 0)
      )
      .map((e) => ({
        label: e.label,
        steps: e.steps,
        at: typeof e.at === "number" ? e.at : undefined,
        sources: Array.isArray(e.sources) && e.sources.every(isAbsolute) ? e.sources : undefined,
      }));
  const history = entries(r.history, true);
  const activity = entries(r.activity, false);
  return { favorites, recents, recentFolders, trashOrigins, history, activity };
}

/** Time of a snapshot on a clock all windows share. The store keeps the newest. */
const savedAt = () => performance.timeOrigin + performance.now();

function persistSoon(get: () => AppDataStore) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void save(snapshot(get));
  }, 300);
}

/** Save now. Windows mirror each other, so any window can save the latest copy. */
export function flushAppData(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  return save(snapshot(useAppData.getState));
}

async function defaultPins(home: string): Promise<string[]> {
  const candidates = defaultPinPaths(home);
  const exists = await Promise.all(
    candidates.map((p) => api.pathExists(p).catch(() => false))
  );
  return candidates.filter((_, i) => exists[i]);
}

async function resolveFavoriteKinds(favorites: FavItem[]): Promise<FavItem[]> {
  const unknown = favorites.filter((f) => f.isDir === undefined).map((f) => f.path);
  if (unknown.length === 0) return favorites;
  const found = await api.statEntries(unknown).catch(() => []);
  const dirs = new Map(found.map((e) => [e.path, e.isDir && !e.isPackage]));
  return favorites.map((f) =>
    f.isDir === undefined && dirs.has(f.path) ? { ...f, isDir: dirs.get(f.path) } : f
  );
}

function homeCloudLabel(name: string): string | null {
  if (name === "Dropbox") return "Dropbox";
  if (name === "Google Drive" || name === "GoogleDrive") return "Google Drive";
  if (name === "Box" || name === "Box Sync") return "Box";
  if (name === "MEGA") return "MEGA";
  if (name === "pCloud Drive") return "pCloud";
  if (name.startsWith("OneDrive")) return "OneDrive";
  return null;
}

function storageLabel(name: string): string {
  const dash = name.indexOf("-");
  const provider = dash > 0 ? name.slice(0, dash) : name;
  const account = dash > 0 ? name.slice(dash + 1) : "";
  const pretty =
    provider === "GoogleDrive"
      ? "Google Drive"
      : provider.replace(/([a-z])([A-Z])/g, "$1 $2");
  return account && account !== provider ? `${pretty} (${account})` : pretty;
}

async function detectCloudDrives(home: string): Promise<CloudDrive[]> {
  const drives: CloudDrive[] = [];
  const paths = new Set<string>();
  const add = (name: string, path: string) => {
    if (paths.has(path)) return;
    paths.add(path);
    drives.push({ name, path });
  };
  const iCloud = `${home}/Library/Mobile Documents/com~apple~CloudDocs`;
  if (await api.pathExists(iCloud).catch(() => false)) add("iCloud Drive", iCloud);
  try {
    const storage = `${home}/Library/CloudStorage`;
    for (const entry of await api.listDir(storage, false)) {
      if (entry.isDir) add(storageLabel(entry.name), entry.path);
    }
  } catch {
  }
  try {
    const seen = new Set(drives.map((d) => d.name.split(" (")[0]));
    for (const entry of await api.listDir(home, false)) {
      if (!entry.isDir) continue;
      const label = homeCloudLabel(entry.name);
      if (label && !seen.has(label)) {
        seen.add(label);
        add(label, `${home}/${entry.name}`);
      }
    }
  } catch {
  }
  return drives;
}

// Another window's mirrored state replaces these. It is newer than the disk copy.
const NO_FAVORITES: AppDataStore["favorites"] = [];
const NO_RECENTS: AppDataStore["recents"] = [];
const NO_RECENT_FOLDERS: AppDataStore["recentFolders"] = [];
const NO_TRASH_ORIGINS: AppDataStore["trashOrigins"] = {};

export const useAppData = create<AppDataStore>((set, get) => ({
  phase: "loading",
  home: "/",
  pins: [],
  cloudDrives: [],
  favorites: NO_FAVORITES,
  recents: NO_RECENTS,
  recentFolders: NO_RECENT_FOLDERS,
  trashOrigins: NO_TRASH_ORIGINS,
  history: [],
  activity: [],

  init: async () => {
    const info = await api.systemInfo().catch(() => null);
    const home = info?.home ?? "/";
    let stored: PersistedStore | null = null;
    let raw: string | null = null;
    let phase: "ready" | "readOnly" = "ready";
    try {
      raw = await api.loadStore();
    } catch (err) {
      phase = "readOnly";
      const said = `Couldn't read saved favorites, recents and undo history (${err}). They're left as they are, and changes this session won't be saved.`;
      useUI.getState().pushToast(said, undefined, "error");
    }
    if (raw) {
      try {
        stored = validateStore(JSON.parse(raw));
      } catch {
        stored = null;
      }
      // Keep the unreadable store aside for recovery before a save replaces it.
      if (!stored) {
        await api.setAsideStore().catch(() => {
          phase = "readOnly";
        });
        const said = "Saved favorites, recents and undo history couldn't be understood, so Doftar started afresh.";
        useUI.getState().pushToast(said, undefined, "error");
      }
    }
    const pins = await defaultPins(home);
    const favorites = await resolveFavoriteKinds(stored?.favorites ?? []);
    const cloudDrives = await detectCloudDrives(home);
    const now = get();
    set({
      phase,
      home,
      pins,
      cloudDrives,
      favorites: now.favorites !== NO_FAVORITES ? now.favorites : favorites,
      recents: now.recents !== NO_RECENTS ? now.recents : (stored?.recents ?? []),
      recentFolders:
        now.recentFolders !== NO_RECENT_FOLDERS ? now.recentFolders : (stored?.recentFolders ?? []),
      trashOrigins:
        now.trashOrigins !== NO_TRASH_ORIGINS ? now.trashOrigins : (stored?.trashOrigins ?? {}),
    });
    useHistory.getState().restore(stored?.history ?? [], stored?.activity ?? []);
    // Start from the restored state, or the next save writes [].
    const logged = (log: HistoryEntry[]) => log.filter((e) => e.steps.length === 0);
    set({ history: useHistory.getState().undo, activity: logged(useHistory.getState().log) });
    useHistory.subscribe((h, prev) => {
      if (h.undo === get().history && h.log === prev.log) return;
      set({ history: h.undo, activity: logged(h.log) });
      persistSoon(get);
    });
    for (const change of beforeLoad.splice(0)) edit(change);
  },

  addRecent: (path) => {
    edit((s) => ({ recents: withRecent(s.recents, path, MAX_RECENTS) }));
  },

  addRecentFolder: (path) => {
    edit((s) => ({ recentFolders: withRecent(s.recentFolders, path, MAX_RECENT_FOLDERS) }));
  },

  toggleFavorite: (item) => {
    // Decide from the list on screen. During load, the edit runs later on the saved list.
    const remove = useAppData.getState().favorites.some((f) => f.path === item.path);
    edit((s) => {
      const others = s.favorites.filter((f) => f.path !== item.path);
      return { favorites: remove ? others : [item, ...others] };
    });
  },

  removePaths: (paths) => {
    const gone = (p: string) => paths.some((g) => p === g || p.startsWith(g + "/"));
    edit((s) => ({
      favorites: s.favorites.filter((f) => !gone(f.path)),
      recents: s.recents.filter((r) => !gone(r.path)),
      recentFolders: s.recentFolders.filter((r) => !gone(r.path)),
    }));
  },

  clearFavorites: () => {
    edit(() => ({ favorites: [] }));
  },

  clearRecents: () => {
    edit(() => ({ recents: [] }));
  },

  clearRecentFolders: () => {
    edit(() => ({ recentFolders: [] }));
  },

  recordTrashOrigins: (moves) => {
    edit((s) => {
      const next = { ...s.trashOrigins };
      // Delete first, so a path that is recorded again is the newest.
      for (const m of moves) {
        delete next[m.trashed];
        next[m.trashed] = { origin: m.origin, id: m.id };
      }
      const keys = Object.keys(next);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TRASH_ORIGINS))) {
        delete next[k];
      }
      return { trashOrigins: next };
    });
  },

  forgetTrashOrigins: (trashed) => {
    edit((s) => {
      const next = { ...s.trashOrigins };
      for (const t of trashed) delete next[t];
      return { trashOrigins: next };
    });
  },

  removeRecent: (path) => {
    edit((s) => ({
      recents: s.recents.filter((r) => r.path !== path),
      recentFolders: s.recentFolders.filter((r) => r.path !== path),
    }));
  },
}));
