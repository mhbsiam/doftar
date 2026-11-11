import { createContext, useContext } from "react";
import { flushSync } from "react-dom";
import { create, createStore, useStore, type StoreApi } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { clearRenameDraft } from "../util/renameDraft";
import type { FileEntry, Location, PortableTab, Tag, TagFilter } from "../types";
import { flushTransitions, runTransition as runPageTransition, type TransitionKind } from "../util/transition";
import { dur } from "../util/motion";
import { animateTabClose, isTabClosing, tabClosed } from "../util/tabClose";
import type { ItemFilter } from "../util/itemFilter";

export interface TabState {
  id: number;
  location: Location;
  history: Location[];
  historyIndex: number;
  selection: string[];
  anchor: string | null;
  renaming: string | null;
  /** Scroll offset to restore when the rows load. Then cleared. */
  restoreScroll: number | null;
  /** Clear when the tab leaves the folder. */
  tagFilter: TagFilter | null;
  /** Narrows the folder or its search by kind and date. Clear when the tab leaves. */
  itemFilter: ItemFilter | null;
  /** Show as columns in every folder. Other views are kept per folder. */
  columns: boolean;
}

interface SavedView {
  scrollTop: number;
  selection: string[];
  anchor: string | null;
  tagFilter: TagFilter | null;
  itemFilter: ItemFilter | null;
}

// Keyed by the history entry object, so a changed history needs no cleanup.
const savedViews = new WeakMap<Location, SavedView>();

const readScroll = (pane: number) =>
  document.querySelector<HTMLElement>(`.pane[data-pane="${pane}"] .content`)?.scrollTop ?? 0;

function rememberHere(pane: number, t: TabState | undefined) {
  const entry = t?.history[t.historyIndex];
  if (!t || !entry) return;
  savedViews.set(entry, {
    scrollTop: readScroll(pane),
    selection: t.selection,
    anchor: t.anchor,
    tagFilter: t.tagFilter,
    itemFilter: t.itemFilter,
  });
}

export interface TabsStore {
  /** 0 is the left half of the window, 1 is the right half. */
  pane: number;
  tabs: TabState[];
  activeId: number;
  refreshTick: number;
  search: string;
  deepSearch: string | null;
  newTab: (loc?: Location) => void;
  /** `moved` is for a tab that went to another window or pane. It cannot be reopened here. */
  closeTab: (id: number, moved?: boolean) => void;
  /** Close every other tab, or only the tabs to the right of `id`. */
  closeOthers: (id: number, rightOnly?: boolean) => void;
  /** Show the tab `delta` places along, wrapping at the ends. */
  cycleTab: (delta: number) => void;
  clearRestoreScroll: () => void;
  setActive: (id: number) => void;
  navigate: (loc: Location) => void;
  go: (delta: number) => void;
  goUp: () => void;
  setSelection: (paths: string[], anchor?: string | null) => void;
  setTagFilter: (filter: TagFilter | null) => void;
  setItemFilter: (filter: ItemFilter | null) => void;
  setColumns: (on: boolean) => void;
  setRenaming: (path: string | null) => void;
  pruneSelection: (listed: Set<string>) => void;
  setSearch: (s: string) => void;
  setDeepSearch: (folder: string | null) => void;
  searchIn: (root: string, query: string) => void;
  reveal: (file: string) => void;
  bumpRefresh: () => void;
  leave: (prefix: string) => void;
  moveTab: (id: number, to: number) => void;
  /** Replace this window's tabs with one from another window. */
  adopt: (tab: PortableTab) => void;
  /** Add a tab from another window at position `at` and open it. */
  insertTab: (tab: PortableTab, at: number) => void;
  listingCount: number;
  /** Bytes of the selected files. Folders are in `selectionDirs`. */
  selectionBytes: number;
  selectionDirs: string[];
  folderTags: { tag: Tag; count: number }[];
  navPaneHidden: boolean;
  /** While open, a double-click on a file shows it in the preview bar. */
  previewOpen: boolean;
  preview: FileEntry | null;
  setListingCount: (n: number) => void;
  setSelectionBytes: (n: number, dirs?: string[]) => void;
  setFolderTags: (tags: { tag: Tag; count: number }[]) => void;
  toggleNavPane: () => void;
  setPreviewOpen: (open: boolean) => void;
  setPreview: (entry: FileEntry | null) => void;
}

/** Tab windows close with their last tab. The main window keeps a new tab. */
const isMainWindow = getCurrentWindow().label === "main";

function fromPortable(p: PortableTab): TabState {
  const history = p.history.length > 0 ? p.history : [{ kind: "home" as const }];
  const historyIndex = Math.max(0, Math.min(p.historyIndex, history.length - 1));
  return {
    ...freshTab(),
    history,
    historyIndex,
    location: history[historyIndex],
    selection: p.selection,
    anchor: p.anchor,
    columns: p.columns ?? false,
  };
}

export function portableTab(t: TabState): PortableTab {
  return { history: t.history, historyIndex: t.historyIndex, selection: t.selection, anchor: t.anchor, columns: t.columns };
}

let nextId = 1;

// Closed tabs of this window, newest last. Their history entries keep scroll and selection (see `savedViews`).
const closedTabs: PortableTab[] = [];
const CLOSED_LIMIT = 25;

function rememberClosed(t: TabState) {
  // An untouched Home tab is not worth reopening.
  if (t.history.length === 1 && t.location.kind === "home") return;
  closedTabs.push(portableTab(t));
  if (closedTabs.length > CLOSED_LIMIT) closedTabs.shift();
}

export const hasClosedTab = () => closedTabs.length > 0;

/** Reopen the last closed tab in the focused pane. False if there is none. */
export function reopenClosedTab(): boolean {
  const p = closedTabs.pop();
  if (!p) return false;
  const store = useTabs.getState();
  store.insertTab(p, store.tabs.length);
  return true;
}

function freshTab(): TabState {
  return {
    id: nextId++,
    location: { kind: "home" },
    history: [{ kind: "home" }],
    historyIndex: 0,
    selection: [],
    anchor: null,
    renaming: null,
    restoreScroll: null,
    tagFilter: null,
    itemFilter: null,
    columns: false,
  };
}

export function sameLocation(a: Location, b: Location): boolean {
  if (a.kind === "path" && b.kind === "path") return a.path === b.path;
  if (a.kind === "tags" && b.kind === "tags") return a.tag === b.tag;
  if (a.kind === "compare" && b.kind === "compare") return a.a === b.a && a.b === b.b;
  return a.kind === b.kind;
}

export function parentOf(path: string): string | null {
  if (path === "/") return null;
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

export function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function joinName(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

export function locationTitle(loc: Location): string {
  if (loc.kind === "home") return "Home";
  if (loc.kind === "disk") return "Disk";
  if (loc.kind === "tags") return loc.tag ?? "Tags";
  if (loc.kind === "screenshots") return "Screenshots";
  if (loc.kind === "skills") return "Skills";
  if (loc.kind === "repos") return "Git";
  if (loc.kind === "compare") return "Compare";
  if (loc.path === "/") return "Computer";
  const parts = loc.path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? loc.path;
}

const makePane = (pane: number) => createStore<TabsStore>()((set, get) => {
  const activeTab = () => get().tabs.find((t) => t.id === get().activeId);
  const rememberView = (t: TabState | undefined) => rememberHere(pane, t);
  // Only this pane's listing slides.
  const runTransition: typeof runPageTransition = (kind, update, wait) => {
    document.documentElement.dataset.vtPane = String(pane);
    return runPageTransition(kind, update, wait);
  };
  // Show `to`. Two tabs at the same place swap without a slide, which would shake identical content.
  const showTab = (kind: TransitionKind, from: TabState, to: TabState) => {
    const update = () => {
      const back = savedViews.get(to.history[to.historyIndex]);
      set((s) => ({
        activeId: to.id,
        search: "",
        deepSearch: null,
        tabs: s.tabs.map((t) =>
          t.id === to.id ? { ...t, restoreScroll: back ? back.scrollTop : null } : t
        ),
      }));
    };
    if (sameLocation(from.history[from.historyIndex], to.history[to.historyIndex])) {
      update();
      return undefined;
    }
    return runTransition(kind, update, true);
  };

  const applyNavigate = (loc: Location, select?: string): boolean => {
    let changed = false;
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== s.activeId) return t;
        const cur = t.history[t.historyIndex];
        if (sameLocation(loc, cur)) {
          // Already here: still select the requested item.
          return select ? { ...t, selection: [select], anchor: select, renaming: null } : t;
        }
        changed = true;
        const history = [...t.history.slice(0, t.historyIndex + 1), loc];
        return {
          ...t,
          location: loc,
          history,
          historyIndex: history.length - 1,
          selection: select ? [select] : [],
          anchor: select ?? null,
          renaming: null,
          restoreScroll: null,
          tagFilter: null,
          itemFilter: null,
        };
      }),
      search: "", deepSearch: null,
    }));
    return changed;
  };

  const closeNow = (id: number) =>
    runTransition(
      "fade",
      () => {
        set((s) => {
          const rest = s.tabs.filter((t) => t.id !== id);
          if (rest.every((t) => isTabClosing(t.id))) {
            const t = freshTab();
            return { tabs: [...rest, t], activeId: t.id, search: "", deepSearch: null };
          }
          const live = s.tabs.filter((t) => t.id === id || !isTabClosing(t.id));
          const idx = live.findIndex((t) => t.id === id);
          const open = live.filter((t) => t.id !== id);
          const activeId =
            s.activeId === id
              ? (open[Math.min(idx, open.length - 1)] ?? open[0]).id
              : s.activeId;
          return { tabs: rest, activeId, search: "", deepSearch: null };
        });
      },
      true
    );

  return {
    ...blankPane(),
    pane,

    newTab: (loc) =>
      set((s) => {
        const t = freshTab();
        if (loc) {
          t.location = loc;
          t.history = [loc];
        }
        return { tabs: [...s.tabs, t], activeId: t.id, search: "", deepSearch: null };
      }),

    closeTab: (id, moved = false) => {
      if (isTabClosing(id)) return;
      // Ignore tabs that are closing. They do not count as the last tab and do not take over.
      const { activeId } = get();
      const tabs = get().tabs.filter((t) => !isTabClosing(t.id));
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      // The last tab of a half ends split view, and that waits for the halves to settle.
      if (tabs.length <= 1 && usePanes.getState().split && splitAnimating) return;
      if (id === activeId) rememberView(tabs[idx]);
      if (!moved) rememberClosed(tabs[idx]);
      // The last tab is replaced, so nothing winds down.
      if (tabs.length <= 1) {
        if (usePanes.getState().split) return closeSplit(1 - pane);
        if (!isMainWindow) return void getCurrentWindow().close();
        return closeNow(id);
      }

      // For the open tab, switch pages while the tab winds down. A background tab keeps the page.
      const next = id === activeId ? (tabs[idx + 1] ?? tabs[idx - 1]) : null;
      const shown = next
        ? showTab(idx + 1 < tabs.length ? "forward" : "back", tabs[idx], next)
        : undefined;
      const collapse = animateTabClose(id, shown);
      void collapse.then(() => {
        set((s) => ({ tabs: s.tabs.filter((t) => t.id !== id) }));
        tabClosed(id);
      });
    },

    closeOthers: (id, rightOnly = false) => {
      const tabs = get().tabs.filter((t) => !isTabClosing(t.id));
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const gone = tabs.filter((_, i) => (rightOnly ? i > idx : i !== idx));
      if (gone.length === 0) return;
      const switching = gone.some((t) => t.id === get().activeId);
      if (switching) rememberView(activeTab());
      for (const t of gone) rememberClosed(t);
      const goneIds = new Set(gone.map((t) => t.id));
      const keep = tabs[idx];
      const apply = () => {
        const back = switching ? savedViews.get(keep.history[keep.historyIndex]) : undefined;
        set((s) => ({
          tabs: s.tabs
            .filter((t) => !goneIds.has(t.id))
            .map((t) => (switching && t.id === id ? { ...t, restoreScroll: back ? back.scrollTop : null } : t)),
          ...(switching ? { activeId: id, search: "", deepSearch: null } : {}),
        }));
      };
      // Many tabs go at once, so skip the per-tab collapse.
      if (switching) void runTransition("fade", apply, true);
      else apply();
    },

    cycleTab: (delta) => {
      const tabs = get().tabs.filter((t) => !isTabClosing(t.id));
      if (tabs.length < 2) return;
      const idx = tabs.findIndex((t) => t.id === get().activeId);
      get().setActive(tabs[(idx + delta + tabs.length) % tabs.length].id);
    },

    setActive: (id) => {
      const { tabs, activeId } = get();
      if (id === activeId) return;
      const from = tabs.findIndex((t) => t.id === activeId);
      const to = tabs.findIndex((t) => t.id === id);
      rememberView(tabs[from]);
      showTab(to > from ? "forward" : "back", tabs[from], tabs[to]);
    },

    navigate: (loc) => {
      rememberView(activeTab());
      runTransition("forward", () => applyNavigate(loc), true);
    },

    go: (delta) => {
      rememberView(activeTab());
      runTransition(delta < 0 ? "back" : "forward", () => {
        let changed = false;
        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.id !== s.activeId) return t;
            const idx = t.historyIndex + delta;
            if (idx < 0 || idx >= t.history.length) return t;
            changed = true;
            const saved = savedViews.get(t.history[idx]);
            return {
              ...t,
              historyIndex: idx,
              location: t.history[idx],
              selection: saved?.selection ?? [],
              anchor: saved?.anchor ?? null,
              renaming: null,
              restoreScroll: saved ? saved.scrollTop : null,
              tagFilter: saved?.tagFilter ?? null,
              itemFilter: saved?.itemFilter ?? null,
            };
          }),
          search: "", deepSearch: null,
        }));
        return changed;
      }, true);
    },

    goUp: () => {
      rememberView(activeTab());
      runTransition("back", () => {
        const t = get().tabs.find((x) => x.id === get().activeId);
        if (!t || t.location.kind !== "path") return false;
        const parent = parentOf(t.location.path);
        if (parent === null) return false;
        return applyNavigate({ kind: "path", path: parent });
      }, true);
    },

    setSelection: (paths, anchor = null) =>
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === s.activeId ? { ...t, selection: paths, anchor } : t
        ),
      })),

    setTagFilter: (tagFilter) =>
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === s.activeId ? { ...t, tagFilter } : t)),
      })),

    setItemFilter: (itemFilter) =>
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === s.activeId ? { ...t, itemFilter } : t)),
      })),

    setColumns: (columns) =>
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === s.activeId ? { ...t, columns } : t)),
      })),

    setRenaming: (path) => {
      clearRenameDraft();
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === s.activeId ? { ...t, renaming: path } : t
        ),
      }));
    },

    pruneSelection: (listed) =>
      set((s) => {
        const t = s.tabs.find((x) => x.id === s.activeId);
        if (!t) return s;
        const selection = t.selection.filter((p) => listed.has(p));
        const anchor = t.anchor !== null && listed.has(t.anchor) ? t.anchor : null;
        const renaming = t.renaming !== null && listed.has(t.renaming) ? t.renaming : null;
        if (
          selection.length === t.selection.length &&
          anchor === t.anchor &&
          renaming === t.renaming
        ) {
          return s;
        }
        return {
          tabs: s.tabs.map((x) =>
            x.id === t.id ? { ...x, selection, anchor, renaming } : x
          ),
        };
      }),

    setSearch: (search) => set(search ? { search } : { search, deepSearch: null }),

    setDeepSearch: (deepSearch) => set({ deepSearch }),

    searchIn: (root, query) => {
      rememberView(activeTab());
      // In one update: navigating clears the search box.
      runTransition("forward", () => {
        applyNavigate({ kind: "path", path: root });
        set({ search: query, deepSearch: root });
        return true;
      }, true);
    },

    reveal: (file) => {
      const dir = parentOf(file);
      if (dir === null) return;
      rememberView(activeTab());
      runTransition("forward", () => applyNavigate({ kind: "path", path: dir }, file), true);
    },

    leave: (prefix) =>
      set((s) => {
        const inside = (t: TabState) =>
          t.location.kind === "path" &&
          (t.location.path === prefix || t.location.path.startsWith(prefix + "/"));
        const cleared = s.tabs.some((t) => t.id === s.activeId && inside(t))
          ? { search: "", deepSearch: null }
          : {};
        return {
          ...cleared,
          tabs: s.tabs.map((t) => {
            if (!inside(t)) return t;
            const home: Location = { kind: "home" };
            return {
              ...t,
              location: home,
              history: [...t.history.slice(0, t.historyIndex + 1), home],
              historyIndex: t.historyIndex + 1,
              selection: [],
              anchor: null,
              renaming: null,
              restoreScroll: null,
              tagFilter: null,
              itemFilter: null,
            };
          }),
        };
      }),

    clearRestoreScroll: () =>
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === s.activeId && t.restoreScroll !== null ? { ...t, restoreScroll: null } : t
        ),
      })),

    bumpRefresh: () => set((s) => ({ refreshTick: s.refreshTick + 1 })),

    moveTab: (id, to) =>
      set((s) => {
        const from = s.tabs.findIndex((t) => t.id === id);
        const dest = Math.max(0, Math.min(to, s.tabs.length - 1));
        if (from < 0 || from === dest) return s;
        const tabs = [...s.tabs];
        const [moved] = tabs.splice(from, 1);
        tabs.splice(dest, 0, moved);
        return { tabs };
      }),

    adopt: (p) => {
      const t = fromPortable(p);
      set({ tabs: [t], activeId: t.id, search: "", deepSearch: null });
    },

    insertTab: (p, at) => {
      rememberView(activeTab());
      runTransition("fade", () => {
        const t = fromPortable(p);
        set((s) => {
          const tabs = [...s.tabs];
          tabs.splice(Math.max(0, Math.min(at, tabs.length)), 0, t);
          return { tabs, activeId: t.id, search: "", deepSearch: null };
        });
      }, true);
    },

    setListingCount: (listingCount) => set({ listingCount }),
    setSelectionBytes: (selectionBytes, dirs = NO_DIRS) =>
      set((s) => ({
        selectionBytes,
        selectionDirs: dirs.join("\n") === s.selectionDirs.join("\n") ? s.selectionDirs : dirs,
      })),
    setFolderTags: (folderTags) =>
      set((s) =>
        s.folderTags.length === 0 && folderTags.length === 0 ? s : { folderTags }
      ),
    // While the preview has taken the right half's navigation pane away, the toggle brings it back.
    toggleNavPane: () =>
      set((s) =>
        pane === 1 && s.previewOpen ? { previewOpen: false, navPaneHidden: false } : { navPaneHidden: !s.navPaneHidden }
      ),
    setPreviewOpen: (previewOpen) => set({ previewOpen }),
    setPreview: (preview) => set({ preview }),
  };
});

const NO_DIRS: string[] = [];

function blankPane() {
  const t = freshTab();
  return {
    tabs: [t],
    activeId: t.id,
    refreshTick: 0,
    search: "",
    deepSearch: null,
    listingCount: 0,
    selectionBytes: 0,
    selectionDirs: NO_DIRS,
    folderTags: [],
    navPaneHidden: false,
    previewOpen: false,
    preview: null,
  };
}

// One pane, or two side by side. Each pane has its own tabs. Commands act on the focused pane.
const panes: StoreApi<TabsStore>[] = [makePane(0), makePane(1)];

export const usePanes = create<{ split: boolean; focused: number }>(() => ({
  split: false,
  focused: 0,
}));

export const paneStore = (pane: number) => panes[pane];

/** Split view has one preview, at the window's right edge, so the right half holds it. */
export const previewStore = () => panes[usePanes.getState().split ? 1 : 0];

export function usePreviewOpen(): boolean {
  const store = panes[usePanes((s) => s.split) ? 1 : 0];
  return useStore(store, (s) => s.previewOpen);
}

export function focusPane(pane: number) {
  if (usePanes.getState().focused !== pane) usePanes.setState({ focused: pane });
}

export function openPanes(): TabsStore[] {
  return (usePanes.getState().split ? panes : panes.slice(0, 1)).map((p) => p.getState());
}

export function paneAt(x: number, y: number): number {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-pane]");
  return el ? Number(el.dataset.pane) : usePanes.getState().focused;
}

export function findTab(id: number): { store: TabsStore; tab: TabState } | null {
  for (const store of openPanes()) {
    const tab = store.tabs.find((t) => t.id === id);
    if (tab) return { store, tab };
  }
  return null;
}

/** True if opening split view grew the window. Closing it shrinks the window back. */
let grewForSplit = false;

const setMaximized = (on: boolean) => invoke<boolean>("set_window_maximized", { on });

/** Opens a second pane on the right. The window grows to full screen first. */
export function openSplit() {
  if (usePanes.getState().split || splitAnimating) return;
  setSplitAnimating(true);
  void setMaximized(true)
    .catch(() => false)
    .then(async (grew) => {
      grewForSplit = grew;
      // The glide returns at once, but the frame settles later.
      if (grew) await new Promise((r) => setTimeout(r, dur("slow")));
      const el = document.querySelector<HTMLElement>('.pane[data-pane="0"]');
      const app = el?.parentElement;
      if (!el || !app || reducedMotion()) return dosplit();
      const cover = coverWith(app, [el]);
      flushSync(dosplit);
      await waveReveal(app, cover);
    })
    .finally(() => setSplitAnimating(false));
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Same easing as `wf-wave` in global.css. */
const WAVE_EASE = "cubic-bezier(0.45, 0, 0.25, 1)";

function coverWith(app: HTMLElement, panes: HTMLElement[]) {
  const cover = document.createElement("div");
  cover.className = "pane-ghost";
  cover.style.inset = "0";
  app.appendChild(cover);
  for (const pane of panes) paneGhost(pane, cover);
  return cover;
}

/**
 * Move the loading wave across the window once. `cover` shows the new layout behind the wave
 * and clips away with it.
 */
async function waveReveal(app: HTMLElement, cover: HTMLElement) {
  const wave = document.createElement("div");
  wave.className = "pane-wave";
  app.appendChild(wave);
  // Slow wave: 1.5 times the longest page motion.
  const opts = { duration: dur("long") * 1.5, easing: WAVE_EASE, fill: "forwards" as const };
  await Promise.all([
    cover.animate([{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(0 0 0 100%)" }], opts).finished,
    // The middle follows the clip edge from the left of the window to the right.
    wave.animate(
      [
        { transform: "translateX(-50%)", opacity: 0 },
        { opacity: 1, offset: 0.15 },
        { opacity: 1, offset: 0.85 },
        { transform: "translateX(200%)", opacity: 0 },
      ],
      opts
    ).finished,
  ]).catch(() => {});
  cover.remove();
  wave.remove();
}

function dosplit() {
  const src = panes[usePanes.getState().focused].getState();
  const tab = src.tabs.find((t) => t.id === src.activeId) ?? src.tabs[0];
  const { previewOpen, preview } = src;
  panes[1].setState({ ...blankPane(), navPaneHidden: src.navPaneHidden, previewOpen, preview });
  panes[0].setState({ previewOpen: false, preview: null });
  // Copy the history entries. Scroll and selection are saved per entry object (see
  // `savedViews`), so shared entries would mix up the two panes.
  const copy = portableTab(tab);
  const history = copy.history.map((l) => {
    const own = { ...l };
    const view = savedViews.get(l);
    if (view) savedViews.set(own, view);
    return own;
  });
  panes[1].getState().adopt({ ...copy, history });
  usePanes.setState({ split: true, focused: 1 });
}

function paneGhost(el: HTMLElement, app: HTMLElement) {
  const a = app.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.classList.add("pane-ghost");
  ghost.removeAttribute("data-pane");
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  for (const n of ghost.querySelectorAll("[id]")) n.removeAttribute("id");
  ghost.style.left = `${r.left - a.left}px`;
  ghost.style.top = `${r.top - a.top}px`;
  ghost.style.width = `${r.width}px`;
  ghost.style.height = `${r.height}px`;
  app.appendChild(ghost);
  return ghost;
}

/**
 * Return to one pane and keep pane `keep`. Turning split off keeps the left pane. Closing the
 * last tab of a half keeps the other pane.
 */
export function closeSplit(keep = 0) {
  if (!usePanes.getState().split || splitAnimating) return;
  const halves = [...document.querySelectorAll<HTMLElement>(".pane[data-pane]")];
  const app = halves[0]?.parentElement;
  if (halves.length !== 2 || !app || reducedMotion()) {
    unsplit(keep);
    return shrink();
  }
  setSplitAnimating(true);
  const cover = coverWith(app, halves);
  flushSync(() => unsplit(keep));
  void waveReveal(app, cover).finally(() => {
    setSplitAnimating(false);
    shrink();
  });
}

let splitAnimating = false;

export const isSplitAnimating = () => splitAnimating;

/** Page transitions wait while the halves move (see util/transition.ts). */
function setSplitAnimating(on: boolean) {
  splitAnimating = on;
  document.documentElement.classList.toggle("split-animating", on);
}

function shrink() {
  if (grewForSplit) void setMaximized(false).catch(() => {});
  grewForSplit = false;
}

function unsplit(keep: number) {
  // Apply a queued update before the merge. It belongs to the half it was made for.
  flushTransitions();
  const { tabs, activeId, search, deepSearch, navPaneHidden, previewOpen, preview } = panes[1].getState();
  if (keep === 1) {
    // Skip tabs that are closing. They would be removed from the right half.
    const kept = tabs.filter((t) => !isTabClosing(t.id));
    panes[0].setState({ tabs: kept, activeId, search, deepSearch, navPaneHidden });
  }
  // The right half holds the preview in split view. It stays open whichever half is kept.
  panes[0].setState({ previewOpen, preview });
  usePanes.setState({ split: false, focused: 0 });
  panes[1].setState(blankPane());
}

/** Put back the tabs saved at the last quit, in one pane. */
export function restoreTabs(saved: PortableTab[], active: number) {
  const tabs = saved.map(fromPortable);
  panes[0].setState({ tabs, activeId: tabs[Math.max(0, Math.min(active, tabs.length - 1))].id });
}

export function toggleSplit() {
  if (usePanes.getState().split) closeSplit();
  else openSplit();
}

export const PaneContext = createContext<number | null>(null);

export function usePane(): number {
  const own = useContext(PaneContext);
  const focused = usePanes((s) => (own === null ? s.focused : -1));
  return own ?? focused;
}

function useTabsHook<T>(selector: (s: TabsStore) => T): T {
  return useStore(panes[usePane()], selector);
}

/** Read the tabs of this pane. `getState()` returns the focused pane, where clicks and keys land. */
export const useTabs = Object.assign(useTabsHook, {
  getState: (): TabsStore => panes[usePanes.getState().focused].getState(),
});

/** For effects that must not follow focus. */
export function usePaneStore(): StoreApi<TabsStore> {
  return panes[usePane()];
}

export function useActiveTab(): TabState {
  return useTabs((s) => s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0]);
}
