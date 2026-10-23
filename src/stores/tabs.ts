import { createContext, useContext } from "react";
import { flushSync } from "react-dom";
import { create, createStore, useStore, type StoreApi } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { clearRenameDraft } from "../util/renameDraft";
import type { Location, PortableTab, Tag, TagFilter } from "../types";
import { runTransition as runPageTransition } from "../util/transition";
import { EASE_IN, dur } from "../util/motion";
import { animateTabClose, isTabClosing, tabClosed } from "../util/tabClose";

export interface TabState {
  id: number;
  location: Location;
  history: Location[];
  historyIndex: number;
  selection: string[];
  anchor: string | null;
  renaming: string | null;
  /** Scroll offset to return to once the folder's rows are in, then cleared. */
  restoreScroll: number | null;
  /** Narrows this folder to tagged items; cleared on leaving it. */
  tagFilter: TagFilter | null;
}

/** What a history entry looked like when it was left. */
interface SavedView {
  scrollTop: number;
  selection: string[];
  anchor: string | null;
  tagFilter: TagFilter | null;
}

// Keyed by the history entry itself (each visit is its own object), so this
// needs no bookkeeping as history is truncated or grows.
const savedViews = new WeakMap<Location, SavedView>();

const readScroll = (pane: number) =>
  document.querySelector<HTMLElement>(`.pane[data-pane="${pane}"] .content`)?.scrollTop ?? 0;

/** Notes the active tab's scroll and selection before it moves to another entry or tab. */
function rememberHere(pane: number, t: TabState | undefined) {
  const entry = t?.history[t.historyIndex];
  if (!t || !entry) return;
  savedViews.set(entry, {
    scrollTop: readScroll(pane),
    selection: t.selection,
    anchor: t.anchor,
    tagFilter: t.tagFilter,
  });
}

export interface TabsStore {
  /** Which half of the window these tabs live in (0 left, 1 right). */
  pane: number;
  tabs: TabState[];
  activeId: number;
  refreshTick: number;
  search: string;
  deepSearch: string | null;
  newTab: (loc?: Location) => void;
  closeTab: (id: number) => void;
  clearRestoreScroll: () => void;
  setActive: (id: number) => void;
  navigate: (loc: Location) => void;
  go: (delta: number) => void;
  goUp: () => void;
  setSelection: (paths: string[], anchor?: string | null) => void;
  setTagFilter: (filter: TagFilter | null) => void;
  setRenaming: (path: string | null) => void;
  /** Drops selection/anchor/renaming entries that are no longer listed. */
  pruneSelection: (listed: Set<string>) => void;
  setSearch: (s: string) => void;
  setDeepSearch: (folder: string | null) => void;
  reveal: (file: string) => void;
  bumpRefresh: () => void;
  leave: (prefix: string) => void;
  /** Moves tab `id` to position `to` in the strip. */
  moveTab: (id: number, to: number) => void;
  /** Replaces this window's tabs with one restored from another window. */
  adopt: (tab: PortableTab) => void;
  /** Adds a tab dragged in from another window at position `at` and opens it. */
  insertTab: (tab: PortableTab, at: number) => void;
  listingCount: number;
  selectionBytes: number;
  /** The tags in the open folder, with how many items carry each. */
  folderTags: { tag: Tag; count: number }[];
  navPaneHidden: boolean;
  setListingCount: (n: number) => void;
  setSelectionBytes: (n: number) => void;
  setFolderTags: (tags: { tag: Tag; count: number }[]) => void;
  toggleNavPane: () => void;
}

/** Tab windows close with their last tab; the main window keeps a fresh one. */
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
  };
}

export function portableTab(t: TabState): PortableTab {
  return { history: t.history, historyIndex: t.historyIndex, selection: t.selection, anchor: t.anchor };
}

let nextId = 1;

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
  };
}

export function sameLocation(a: Location, b: Location): boolean {
  if (a.kind === "path" && b.kind === "path") return a.path === b.path;
  if (a.kind === "tags" && b.kind === "tags") return a.tag === b.tag;
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
  if (loc.path === "/") return "Computer";
  const parts = loc.path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? loc.path;
}

const makePane = (pane: number) => createStore<TabsStore>()((set, get) => {
  const activeTab = () => get().tabs.find((t) => t.id === get().activeId);
  const rememberView = (t: TabState | undefined) => rememberHere(pane, t);
  // Only this pane's listing slides; the other half stays still.
  const runTransition: typeof runPageTransition = (kind, update, wait) => {
    document.documentElement.dataset.vtPane = String(pane);
    runPageTransition(kind, update, wait);
  };

  const applyNavigate = (loc: Location, select?: string): boolean => {
    let changed = false;
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== s.activeId) return t;
        const cur = t.history[t.historyIndex];
        if (sameLocation(loc, cur)) {
          // Already here (e.g. revealing a search result that lives in this
          // folder): still honour the requested selection.
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
          // Tabs still winding down are on their way out and remove themselves.
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

    closeTab: (id) => {
      if (isTabClosing(id)) return;
      // Tabs already winding down are as good as gone: they neither count
      // towards the last tab nor take over from this one.
      const { activeId } = get();
      const tabs = get().tabs.filter((t) => !isTabClosing(t.id));
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      // The only tab is replaced by a fresh one, so there is nothing to wind down.
      if (tabs.length <= 1) {
        // Closing a split half's last tab closes that half.
        if (usePanes.getState().split) return closeSplit(1 - pane);
        if (!isMainWindow) return void getCurrentWindow().close();
        return closeNow(id);
      }

      // Closing the open tab: switch pages now, in step with the tab winding
      // down, rather than after it is gone. Closing a background tab leaves
      // the page alone.
      const next = id === activeId ? (tabs[idx + 1] ?? tabs[idx - 1]) : null;
      const collapse = animateTabClose(id);
      if (next) {
        runTransition(
          idx + 1 < tabs.length ? "forward" : "back",
          () => {
            const back = savedViews.get(next.history[next.historyIndex]);
            set((s) => ({
              activeId: next.id,
              search: "",
              deepSearch: null,
              tabs: s.tabs.map((t) =>
                t.id === next.id ? { ...t, restoreScroll: back ? back.scrollTop : null } : t
              ),
            }));
          },
          true
        );
      }
      void collapse.then(() => {
        set((s) => ({ tabs: s.tabs.filter((t) => t.id !== id) }));
        tabClosed(id);
      });
    },

    setActive: (id) => {
      const { tabs, activeId } = get();
      if (id === activeId) return;
      const from = tabs.findIndex((t) => t.id === activeId);
      const to = tabs.findIndex((t) => t.id === id);
      rememberView(tabs[from]);
      runTransition(to > from ? "forward" : "back", () => {
        // The tab being left keeps its own entry; the one coming back scrolls
        // to where it was.
        const back = savedViews.get(tabs[to].history[tabs[to].historyIndex]);
        set((s) => ({
          activeId: id,
          search: "",
          deepSearch: null,
          tabs: s.tabs.map((t) =>
            t.id === id ? { ...t, restoreScroll: back ? back.scrollTop : null } : t
          ),
        }));
      }, true);
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
            // Coming back to an entry: restore where the list was scrolled and
            // what was selected.
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

    reveal: (file) => {
      const dir = parentOf(file);
      if (dir === null) return;
      rememberView(activeTab());
      runTransition("forward", () => applyNavigate({ kind: "path", path: dir }, file), true);
    },

    leave: (prefix) =>
      set((s) => ({
        tabs: s.tabs.map((t) => {
          const inside =
            t.location.kind === "path" &&
            (t.location.path === prefix || t.location.path.startsWith(prefix + "/"));
          if (!inside) return t;
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
          };
        }),
      })),

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
    setSelectionBytes: (selectionBytes) => set({ selectionBytes }),
    setFolderTags: (folderTags) =>
      set((s) =>
        s.folderTags.length === 0 && folderTags.length === 0 ? s : { folderTags }
      ),
    toggleNavPane: () => set((s) => ({ navPaneHidden: !s.navPaneHidden })),
  };
});

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
    folderTags: [],
    navPaneHidden: false,
  };
}

// The window shows one pane, or two side by side. Each pane has its own tabs;
// commands, shortcuts and menus act on the focused one.
const panes: StoreApi<TabsStore>[] = [makePane(0), makePane(1)];

export const usePanes = create<{ split: boolean; focused: number }>(() => ({
  split: false,
  focused: 0,
}));

export const paneStore = (pane: number) => panes[pane];

export function focusPane(pane: number) {
  if (usePanes.getState().focused !== pane) usePanes.setState({ focused: pane });
}

/** The panes on screen, left to right. */
export function openPanes(): TabsStore[] {
  return (usePanes.getState().split ? panes : panes.slice(0, 1)).map((p) => p.getState());
}

/** The pane holding the element at a point (0 when it's in none). */
export function paneAt(x: number, y: number): number {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-pane]");
  return el ? Number(el.dataset.pane) : usePanes.getState().focused;
}

/** Finds a tab in whichever pane holds it. */
export function findTab(id: number): { store: TabsStore; tab: TabState } | null {
  for (const store of openPanes()) {
    const tab = store.tabs.find((t) => t.id === id);
    if (tab) return { store, tab };
  }
  return null;
}

/** Whether opening split view grew the window, so closing it shrinks it back. */
let grewForSplit = false;

const setMaximized = (on: boolean) => invoke<boolean>("set_window_maximized", { on });

/** Opens a second pane on the right, showing what the focused one shows. */
export function openSplit() {
  if (usePanes.getState().split || closingSplit) return;
  const src = panes[usePanes.getState().focused].getState();
  const tab = src.tabs.find((t) => t.id === src.activeId) ?? src.tabs[0];
  panes[1].setState({ ...blankPane(), navPaneHidden: src.navPaneHidden });
  // Its own copies of the history entries, starting from what the left pane
  // remembered: each pane's scroll and selection are kept per entry object
  // (see `savedViews`), so shared entries would mix the two up.
  const copy = portableTab(tab);
  const history = copy.history.map((l) => {
    const own = { ...l };
    const view = savedViews.get(l);
    if (view) savedViews.set(own, view);
    return own;
  });
  panes[1].getState().adopt({ ...copy, history });
  usePanes.setState({ split: true, focused: 1 });
  // Two explorers need the room: fill the screen unless it already does.
  void setMaximized(true)
    .then((grew) => (grewForSplit = grew))
    .catch(() => {});
}

/**
 * Goes back to one pane, keeping pane `keep`. Turning split view off keeps the
 * left one, so the right half slides away; closing a half's last tab keeps the other.
 */
export function closeSplit(keep = 0) {
  if (!usePanes.getState().split || closingSplit) return;
  const el = document.querySelector<HTMLElement>(`.pane[data-pane="${1 - keep}"]`);
  const app = el?.parentElement;
  if (!el || !app || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return unsplit(keep);
  }
  // The half going away leaves as a still copy of itself laid over the kept
  // one, which takes the whole width at once underneath: one reflow, then
  // only a transform and a fade, so nothing is laid out per frame.
  closingSplit = true;
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
  flushSync(() => unsplit(keep));
  // Off its outer edge: the right half goes right, the left half left.
  const dx = (keep === 0 ? 1 : -1) * r.width;
  const slide = ghost.animate(
    [
      { transform: "none", opacity: 1 },
      { transform: `translateX(${dx}px)`, opacity: 0.6 },
    ],
    { duration: dur("slow"), easing: EASE_IN, fill: "forwards" }
  );
  void slide.finished
    .catch(() => {})
    .then(() => {
      closingSplit = false;
      ghost.remove();
    });
}

let closingSplit = false;

function unsplit(keep: number) {
  if (keep === 1) {
    const { tabs, activeId, search, deepSearch, navPaneHidden } = panes[1].getState();
    // A tab still winding down would be removed from the right half, not this one.
    const kept = tabs.filter((t) => !isTabClosing(t.id));
    panes[0].setState({ tabs: kept, activeId, search, deepSearch, navPaneHidden });
  }
  usePanes.setState({ split: false, focused: 0 });
  panes[1].setState(blankPane());
  if (grewForSplit) void setMaximized(false).catch(() => {});
  grewForSplit = false;
}

export function toggleSplit() {
  if (usePanes.getState().split) closeSplit();
  else openSplit();
}

/** Set by each pane for everything rendered inside it. */
export const PaneContext = createContext<number | null>(null);

/** The pane this component is in; outside any pane, the focused one. */
export function usePane(): number {
  const own = useContext(PaneContext);
  const focused = usePanes((s) => (own === null ? s.focused : -1));
  return own ?? focused;
}

function useTabsHook<T>(selector: (s: TabsStore) => T): T {
  return useStore(panes[usePane()], selector);
}

/**
 * Reads this pane's tabs in a component. `getState()` is the focused pane's,
 * which is where clicks and keys land: pressing in a pane focuses it first.
 */
export const useTabs = Object.assign(useTabsHook, {
  getState: (): TabsStore => panes[usePanes.getState().focused].getState(),
});

/** This component's pane's store, for effects that must not follow focus. */
export function usePaneStore(): StoreApi<TabsStore> {
  return panes[usePane()];
}

export function useActiveTab(): TabState {
  return useTabs((s) => s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0]);
}
