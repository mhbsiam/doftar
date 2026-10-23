import { create } from "zustand";
import { api } from "../ipc";
import type { FavItem, PersistedStore, RecentItem } from "../types";

export interface CloudDrive {
  name: string;
  path: string;
}

const DEFAULT_HOME_PINS = ["Desktop", "Documents", "Downloads"];

export function defaultPinPaths(home: string): string[] {
  return DEFAULT_HOME_PINS.map((n) => `${home}/${n}`);
}

const MAX_RECENTS = 30;
const MAX_TRASH_ORIGINS = 500;

interface AppDataStore {
  ready: boolean;
  home: string;
  pins: string[];
  cloudDrives: CloudDrive[];
  favorites: FavItem[];
  recents: RecentItem[];
  trashOrigins: Record<string, string>;
  init: () => Promise<void>;
  addRecent: (path: string) => void;
  toggleFavorite: (item: FavItem) => void;
  removePaths: (paths: string[]) => void;
  clearFavorites: () => void;
  clearRecents: () => void;
  removeRecent: (path: string) => void;
  recordTrashOrigins: (moves: { trashed: string; origin: string }[]) => void;
  forgetTrashOrigins: (trashed: string[]) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function dirName(p: string): string {
  const idx = p.replace(/\/+$/, "").lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

function snapshot(get: () => AppDataStore): string {
  const { favorites, recents, trashOrigins } = get();
  const blob: PersistedStore = { favorites, recents, trashOrigins };
  return JSON.stringify(blob);
}

const isAbsolute = (v: unknown): v is string => typeof v === "string" && v.startsWith("/");

/**
 * Keeps only well-formed entries of a store read from disk: every path must
 * be an absolute string, and every other field its expected type. A file
 * edited by hand or by another program can't inject anything else.
 */
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
  const recents = (Array.isArray(r.recents) ? r.recents : [])
    .filter(
      (x): x is RecentItem =>
        !!x &&
        typeof x === "object" &&
        isAbsolute((x as RecentItem).path) &&
        typeof (x as RecentItem).name === "string" &&
        typeof (x as RecentItem).dirName === "string" &&
        typeof (x as RecentItem).ts === "number"
    )
    .map((x) => ({ path: x.path, name: x.name, dirName: x.dirName, ts: x.ts }));
  const trashOrigins: Record<string, string> = {};
  if (r.trashOrigins && typeof r.trashOrigins === "object") {
    for (const [k, v] of Object.entries(r.trashOrigins as Record<string, unknown>)) {
      if (isAbsolute(k) && isAbsolute(v)) trashOrigins[k] = v;
    }
  }
  return { favorites, recents, trashOrigins };
}

/**
 * When a snapshot was taken, in milliseconds on a clock all windows share;
 * the store keeps the newest, whichever save reaches it last.
 */
const savedAt = () => performance.timeOrigin + performance.now();

function persistSoon(get: () => AppDataStore) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    api.saveStore(snapshot(get), savedAt()).catch(() => {});
  }, 300);
}

/**
 * Writes favorites, recents and Trash origins now, before the app quits or a
 * window opens. Windows mirror each other, so any one of them can save the
 * latest copy, even one with nothing pending of its own.
 */
export function flushAppData(): Promise<void> {
  if (!useAppData.getState().ready) return Promise.resolve();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  return api.saveStore(snapshot(useAppData.getState), savedAt()).catch(() => {});
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

// What a window starts with before `init`. Another window's state mirrored in
// meanwhile replaces these, and is newer than what `init` reads from disk.
const NO_FAVORITES: AppDataStore["favorites"] = [];
const NO_RECENTS: AppDataStore["recents"] = [];
const NO_TRASH_ORIGINS: AppDataStore["trashOrigins"] = {};

export const useAppData = create<AppDataStore>((set, get) => ({
  ready: false,
  home: "/",
  pins: [],
  cloudDrives: [],
  favorites: NO_FAVORITES,
  recents: NO_RECENTS,
  trashOrigins: NO_TRASH_ORIGINS,

  init: async () => {
    const info = await api.systemInfo().catch(() => null);
    const home = info?.home ?? "/";
    let stored: PersistedStore | null = null;
    try {
      const raw = await api.loadStore();
      stored = raw ? validateStore(JSON.parse(raw)) : null;
    } catch {
      stored = null;
    }
    const pins = await defaultPins(home);
    const favorites = await resolveFavoriteKinds(stored?.favorites ?? []);
    const cloudDrives = await detectCloudDrives(home);
    const now = get();
    set({
      ready: true,
      home,
      pins,
      cloudDrives,
      favorites: now.favorites !== NO_FAVORITES ? now.favorites : favorites,
      recents: now.recents !== NO_RECENTS ? now.recents : (stored?.recents ?? []),
      trashOrigins:
        now.trashOrigins !== NO_TRASH_ORIGINS ? now.trashOrigins : (stored?.trashOrigins ?? {}),
    });
  },

  addRecent: (path) => {
    set((s) => {
      const recents = [
        {
          path,
          name: basename(path),
          dirName: dirName(path),
          ts: Date.now(),
        },
        ...s.recents.filter((r) => r.path !== path),
      ].slice(0, MAX_RECENTS);
      return { recents };
    });
    persistSoon(get);
  },

  toggleFavorite: (item) => {
    set((s) => {
      const favorites = s.favorites.some((f) => f.path === item.path)
        ? s.favorites.filter((f) => f.path !== item.path)
        : [item, ...s.favorites];
      return { favorites };
    });
    persistSoon(get);
  },

  removePaths: (paths) => {
    set((s) => ({
      favorites: s.favorites.filter((f) => !paths.includes(f.path)),
      recents: s.recents.filter((r) => !paths.includes(r.path)),
    }));
    persistSoon(get);
  },

  clearFavorites: () => {
    set({ favorites: [] });
    persistSoon(get);
  },

  clearRecents: () => {
    set({ recents: [] });
    persistSoon(get);
  },

  recordTrashOrigins: (moves) => {
    set((s) => {
      const next = { ...s.trashOrigins };
      for (const m of moves) next[m.trashed] = m.origin;
      const keys = Object.keys(next);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TRASH_ORIGINS))) {
        delete next[k];
      }
      return { trashOrigins: next };
    });
    persistSoon(get);
  },

  forgetTrashOrigins: (trashed) => {
    set((s) => {
      const next = { ...s.trashOrigins };
      for (const t of trashed) delete next[t];
      return { trashOrigins: next };
    });
    persistSoon(get);
  },

  removeRecent: (path) => {
    set((s) => ({ recents: s.recents.filter((r) => r.path !== path) }));
    persistSoon(get);
  },
}));
