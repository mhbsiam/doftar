import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ContentFilter, GroupBy, SortKey, Tag, ViewMode } from "../types";
import type { FolderColorId } from "../util/folderColors";
import { dateFormat, type ClockStyle, type DateStyle } from "../util/format";
import { applyTextScale } from "../util/textScale";
import { DEFAULT_LIST_COLUMNS, type ColumnKey, type ColumnWidths } from "../util/listColumns";
import { runTransition, runViewSwitch } from "../util/transition";

export type ThemePref = "system" | "light" | "dark";
export type WindowButtons = "macos" | "windows";

export interface SavedSearch {
  root: string;
  query: string;
  contents: boolean;
}

export const sameSearch = (a: SavedSearch, b: SavedSearch) =>
  a.root === b.root && a.query === b.query && a.contents === b.contents;

export interface ViewPrefs {
  viewMode: ViewMode;
  sortKey: SortKey;
  sortAsc: boolean;
  groupBy: GroupBy;
  /** One of ICON_SIZES. */
  iconSize: number;
  /** List view column widths in rem, set by dragging a header edge. */
  colWidths?: ColumnWidths;
}

interface SettingsStore {
  theme: ThemePref;
  textScale: number;
  /** macOS traffic lights at the top left, or Windows caption buttons at the top right. */
  windowButtons: WindowButtons;
  folderColor: FolderColorId;
  /** Accent palette for selection, buttons and links. null follows `folderColor`. */
  selectionColor: FolderColorId | null;
  folderColors: Record<string, FolderColorId>;
  /** Colors saved by path in old versions. Migrated at startup. */
  legacyFolderColors: Record<string, FolderColorId>;
  /** Per-folder view overrides by file id. Unset fields use the defaults above. */
  folderViews: Record<string, Partial<ViewPrefs>>;
  setFolderView: (fileId: string, patch: Partial<ViewPrefs>) => void;
  clearFolderView: (fileId: string) => void;
  /** Make `prefs` the default. Drop all per-folder overrides except `keep`. */
  applyViewToAll: (prefs: ViewPrefs, keep?: Record<string, Partial<ViewPrefs>>) => void;
  setFolderColor: (fileIds: string[], id: FolderColorId | null) => void;
  viewMode: ViewMode;
  sortKey: SortKey;
  sortAsc: boolean;
  groupBy: GroupBy;
  iconSize: number;
  showHidden: boolean;
  /** Optional list view columns that are shown. */
  listColumns: ColumnKey[];
  /** Subfolder search also matches text inside files Spotlight has indexed. */
  searchContents: boolean;
  /** Searches pinned in the sidebar, oldest first. */
  savedSearches: SavedSearch[];
  showCheckboxes: boolean;
  /** Read both sides after a copy or move to another drive and compare checksums. About twice as slow. */
  verifyCopies: boolean;
  /** Icons view shows each file's size under its name. */
  gridItemInfo: boolean;
  filter: ContentFilter;
  collapsedSections: string[];
  toggleSection: (key: string) => void;
  hiddenCloudDrives: string[];
  hiddenQuickAccess: string[];
  hideQuickAccess: (name: string) => void;
  unhideQuickAccess: () => void;
  /** Hidden pages: "disk", "tags", "skills", "repos". */
  hiddenPlaces: string[];
  hidePlace: (kind: string) => void;
  unhidePlaces: () => void;
  customTags: Tag[];
  addCustomTag: (tag: Tag) => void;
  /** App path of the terminal for "Open in Terminal". null means Terminal. */
  terminalApp: string | null;
  /** Terminals added with "Choose another app…". */
  terminalExtras: string[];
  /** App path of the editor for "Open in". null means the first one found. */
  editorApp: string | null;
  /** Editors added with "Choose another editor…". */
  editorExtras: string[];
  /** Make thumbnails for files on external volumes. If off, a private drive leaves no previews. */
  externalThumbnails: boolean;
  previewWidth: number;
  /** Height of the info section in rem. 0 shows only the name, kind and date. */
  previewInfoHeight: number;
  /** Show min, max and missing count under each column name in data tables. */
  columnStats: boolean;
  dateStyle: DateStyle;
  clock: ClockStyle;
  /** TERMS_VERSION of the terms last agreed to. null until agreed. */
  termsAccepted: string | null;
  hideCloudDrive: (path: string) => void;
  unhideCloudDrive: (path: string) => void;
  unhideCloudDrives: () => void;
  set: (patch: Partial<SettingsStore>) => void;
}

export const DEFAULT_PREVIEW_REM = 24;

export const useSettings = create<SettingsStore>()(
  persist(
    (set, get) => ({
      theme: "system",
      textScale: 1,
      windowButtons: "macos",
      folderColor: "teal",
      selectionColor: null,
      folderColors: {},
      legacyFolderColors: {},
      folderViews: {},
      viewMode: "details",
      sortKey: "name",
      sortAsc: true,
      groupBy: "none",
      iconSize: 72,
      showHidden: false,
      listColumns: DEFAULT_LIST_COLUMNS,
      searchContents: false,
      savedSearches: [],
      showCheckboxes: true,
      verifyCopies: false,
      gridItemInfo: false,
      previewWidth: DEFAULT_PREVIEW_REM,
      previewInfoHeight: 0,
      filter: "all",
      collapsedSections: [],
      toggleSection: (key) =>
        set((s) => ({
          collapsedSections: s.collapsedSections.includes(key)
            ? s.collapsedSections.filter((k) => k !== key)
            : [...s.collapsedSections, key],
        })),
      setFolderView: (fileId, patch) => {
        const apply = () => {
          set((s) => ({
            folderViews: { ...s.folderViews, [fileId]: { ...s.folderViews[fileId], ...patch } },
          }));
        };
        const cur = get().folderViews[fileId]?.viewMode ?? get().viewMode;
        if (patch.viewMode !== undefined && patch.viewMode !== cur) {
          runViewSwitch(apply);
        } else {
          apply();
        }
      },
      clearFolderView: (fileId) =>
        set((s) => {
          if (!s.folderViews[fileId]) return s;
          const next = { ...s.folderViews };
          delete next[fileId];
          return { folderViews: next };
        }),
      applyViewToAll: (prefs, keep = {}) =>
        runTransition("fade", () => {
          set({ ...prefs, folderViews: keep });
        }),
      setFolderColor: (fileIds, id) =>
        set((s) => {
          const next = { ...s.folderColors };
          for (const f of fileIds) {
            if (id) next[f] = id;
            else delete next[f];
          }
          return { folderColors: next };
        }),
      hiddenCloudDrives: [],
      hiddenQuickAccess: ["Movies", "Music", "Pictures"],
      hideQuickAccess: (name) =>
        set((s) => ({
          hiddenQuickAccess: s.hiddenQuickAccess.includes(name)
            ? s.hiddenQuickAccess
            : [...s.hiddenQuickAccess, name],
        })),
      unhideQuickAccess: () => set({ hiddenQuickAccess: [] }),
      hiddenPlaces: [],
      hidePlace: (kind) =>
        set((s) => ({
          hiddenPlaces: s.hiddenPlaces.includes(kind) ? s.hiddenPlaces : [...s.hiddenPlaces, kind],
        })),
      unhidePlaces: () => set({ hiddenPlaces: [] }),
      customTags: [],
      addCustomTag: (tag) =>
        set((s) => ({
          customTags: [
            ...s.customTags.filter((t) => t.name.toLowerCase() !== tag.name.toLowerCase()),
            tag,
          ],
        })),
      terminalApp: null,
      terminalExtras: [],
      editorApp: null,
      editorExtras: [],
      externalThumbnails: true,
      columnStats: true,
      dateStyle: "mdy",
      clock: "12",
      termsAccepted: null,
      hideCloudDrive: (path) =>
        set((s) => ({
          hiddenCloudDrives: s.hiddenCloudDrives.includes(path)
            ? s.hiddenCloudDrives
            : [...s.hiddenCloudDrives, path],
        })),
      unhideCloudDrive: (path) =>
        set((s) => ({ hiddenCloudDrives: s.hiddenCloudDrives.filter((p) => p !== path) })),
      unhideCloudDrives: () => set({ hiddenCloudDrives: [] }),
      set: (patch) => {
        if (patch.textScale !== undefined) applyTextScale(patch.textScale);
        if (patch.viewMode !== undefined && patch.viewMode !== get().viewMode) {
          runViewSwitch(() => {
            set(patch);
          });
          return;
        }
        set(patch);
      },
    }),
    {
      name: "doftar-settings",
      version: 7,
      // The preview bar's width is not remembered. See togglePreview.
      partialize: ({ previewWidth: _, ...saved }) => saved,
      migrate: (state, version) => {
        const s = state as Partial<SettingsStore>;
        if (version < 7) delete s.previewWidth;
        if (version < 1 && s.theme === "light") s.theme = "system";
        if (version < 2 && s.folderColor === "yellow") s.folderColor = "teal";
        if (version < 4) s.showCheckboxes = true;
        if (version < 6) s.hiddenQuickAccess = ["Movies", "Music", "Pictures"];
        if (version < 3) {
          s.legacyFolderColors = s.folderColors ?? {};
          s.folderColors = {};
        }
        return s as SettingsStore;
      },
    }
  )
);

// Set here, not in a React effect, so the first render uses it.
const syncDateFormat = (s: SettingsStore) => {
  dateFormat.date = s.dateStyle;
  dateFormat.clock = s.clock;
};
syncDateFormat(useSettings.getState());
useSettings.subscribe(syncDateFormat);

export const useDateFormat = () => useSettings((s) => `${s.dateStyle}${s.clock}`);
