import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ContentFilter, GroupBy, SortKey, Tag, ViewMode } from "../types";
import type { FolderColorId } from "../util/folderColors";
import { applyTextScale } from "../util/textScale";
import { runTransition, runViewSwitch } from "../util/transition";

export type ThemePref = "system" | "light" | "dark";

export interface ViewPrefs {
  viewMode: ViewMode;
  sortKey: SortKey;
  sortAsc: boolean;
  groupBy: GroupBy;
}

interface SettingsStore {
  theme: ThemePref;
  textScale: number;
  folderColor: FolderColorId;
  folderColors: Record<string, FolderColorId>;
  /** Colors saved by path before they were keyed by file id; migrated at startup. */
  legacyFolderColors: Record<string, FolderColorId>;
  /** Per-folder view overrides, by file id; unset fields follow the defaults above. */
  folderViews: Record<string, Partial<ViewPrefs>>;
  setFolderView: (fileId: string, patch: Partial<ViewPrefs>) => void;
  clearFolderView: (fileId: string) => void;
  /** Makes `prefs` the default and drops every per-folder override. */
  applyViewToAll: (prefs: ViewPrefs) => void;
  setFolderColor: (fileIds: string[], id: FolderColorId | null) => void;
  viewMode: ViewMode;
  sortKey: SortKey;
  sortAsc: boolean;
  groupBy: GroupBy;
  showHidden: boolean;
  showCheckboxes: boolean;
  filter: ContentFilter;
  collapsedSections: string[];
  toggleSection: (key: string) => void;
  hiddenCloudDrives: string[];
  /** Tags made here with "New Tag…", offered in the Tags menu. */
  customTags: Tag[];
  addCustomTag: (tag: Tag) => void;
  /** The terminal "Open in Terminal" uses (an app path); null means Terminal. */
  terminalApp: string | null;
  /** Terminals added with "Choose another app…", beyond the detected ones. */
  terminalExtras: string[];
  /**
   * Whether to make thumbnails for files on USB, network and other mounted
   * volumes. Off, a private drive leaves no previews on this Mac at all.
   */
  externalThumbnails: boolean;
  hideCloudDrive: (path: string) => void;
  unhideCloudDrive: (path: string) => void;
  unhideCloudDrives: () => void;
  set: (patch: Partial<SettingsStore>) => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set, get) => ({
      theme: "system",
      textScale: 1,
      folderColor: "teal",
      folderColors: {},
      legacyFolderColors: {},
      folderViews: {},
      viewMode: "details",
      sortKey: "name",
      sortAsc: true,
      groupBy: "none",
      showHidden: false,
      showCheckboxes: true,
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
      applyViewToAll: (prefs) =>
        runTransition("fade", () => {
          set({ ...prefs, folderViews: {} });
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
      externalThumbnails: true,
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
      version: 4,
      migrate: (state, version) => {
        const s = state as Partial<SettingsStore>;
        if (version < 1 && s.theme === "light") s.theme = "system";
        if (version < 2 && s.folderColor === "yellow") s.folderColor = "teal";
        if (version < 4) s.showCheckboxes = true;
        if (version < 3) {
          s.legacyFolderColors = s.folderColors ?? {};
          s.folderColors = {};
        }
        return s as SettingsStore;
      },
    }
  )
);
