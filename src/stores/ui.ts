import type React from "react";
import { create } from "zustand";
import type { Conflict, FileEntry, Resolutions } from "../types";

export interface SwatchSpec {
  key: string;
  label: string;
  color: string;
  state: "on" | "mixed" | "off";
  onSelect: () => void;
}

export interface MenuItemSpec {
  key: string;
  label?: string;
  /** Shows a row of color dots in place of an item. `label` names the row. */
  swatches?: SwatchSpec[];
  icon?: React.ReactElement;
  disabled?: boolean;
  checked?: boolean;
  /** The keyboard shortcut, shown muted after the label. */
  keys?: string;
  dividerBefore?: boolean;
  items?: MenuItemSpec[];
  onSelect?: () => void;
}

export interface CommandSpec {
  key: string;
  label: string;
  icon?: React.ReactElement;
  disabled?: boolean;
  /** Set apart at the end of the row, and red on hover. */
  danger?: boolean;
  onSelect?: () => void;
}

export interface ConfirmSpec {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  hideCancel?: boolean;
  alt?: { label: string; onSelect: () => void };
  onConfirm: () => void;
  onCancel?: () => void;
}

export interface ConflictSpec {
  conflicts: Conflict[];
  resolve: (resolutions: Resolutions | null) => void;
  /** Changes per request, to reset the per-item state of the dialog. */
  id: number;
}

let nextConflictId = 1;

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  message: string;
  action?: ToastAction;
  /** Errors interrupt assistive technology. Other tones are polite. */
  tone?: "error";
}

let nextToastId = 1;

interface UIStore {
  toasts: Toast[];
  pushToast: (message: string, action?: ToastAction, tone?: Toast["tone"]) => void;
  dismissToast: (id: number) => void;
  confirm: ConfirmSpec | null;
  conflictSpec: ConflictSpec | null;
  properties: FileEntry[] | null;
  newTagFor: FileEntry[] | null;
  batchRename: FileEntry[] | null;
  selectPatternOpen: boolean;
  /** The items a Move to… or Copy to… dialog will send. */
  sendTo: { paths: string[]; mode: "move" | "copy" } | null;
  /** `archive`: the root is an archive file, and the panel lists what it holds. */
  folderTree: { root: string; pane: number; archive?: boolean } | null;
  shortcutsOpen: boolean;
  settingsOpen: boolean;
  helpOpen: boolean;
  paletteOpen: boolean;
  /** Activity menu of the command bar: clipboard history and undoable actions. */
  clipHistoryOpen: boolean;
  contextMenu: { x: number; y: number; items: MenuItemSpec[]; commands: CommandSpec[] } | null;
  /** The pane that files from outside are dragged over. */
  dragOver: number | null;
  openConfirm: (spec: ConfirmSpec) => void;
  closeConfirm: () => void;
  openConflicts: (spec: Omit<ConflictSpec, "id">) => void;
  closeConflicts: () => void;
  openProperties: (entries: FileEntry | FileEntry[]) => void;
  closeProperties: () => void;
  openNewTag: (entries: FileEntry[]) => void;
  closeNewTag: () => void;
  openBatchRename: (entries: FileEntry[]) => void;
  closeBatchRename: () => void;
  setSelectPatternOpen: (open: boolean) => void;
  openSendTo: (paths: string[], mode: "move" | "copy") => void;
  closeSendTo: () => void;
  openFolderTree: (root: string, pane: number, archive?: boolean) => void;
  closeFolderTree: () => void;
  setShortcutsOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setClipHistoryOpen: (open: boolean) => void;
  openContextMenu: (x: number, y: number, items: MenuItemSpec[], commands?: CommandSpec[]) => void;
  closeContextMenu: () => void;
  setDragOver: (pane: number | null) => void;
}

export type ActiveModal =
  | "confirm"
  | "conflicts"
  | "properties"
  | "newTag"
  | "batchRename"
  | "selectPattern"
  | "sendTo"
  | "shortcuts"
  | "settings"
  | "help"
  | "palette"
  | "menu";

export function activeModal(s: UIStore = useUI.getState()): ActiveModal | null {
  if (s.confirm) return "confirm";
  if (s.conflictSpec) return "conflicts";
  if (s.properties) return "properties";
  if (s.newTagFor) return "newTag";
  if (s.batchRename) return "batchRename";
  if (s.selectPatternOpen) return "selectPattern";
  if (s.sendTo) return "sendTo";
  if (s.shortcutsOpen) return "shortcuts";
  if (s.settingsOpen) return "settings";
  if (s.helpOpen) return "help";
  if (s.paletteOpen) return "palette";
  if (s.contextMenu) return "menu";
  return null;
}

export const useUI = create<UIStore>((set) => ({
  toasts: [],
  pushToast: (message, action, tone) =>
    set((s) => ({
      toasts:
        !action && s.toasts.some((t) => t.message === message)
          ? s.toasts
          : [...s.toasts.slice(-2), { id: nextToastId++, message, action, tone }],
    })),
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  confirm: null,
  conflictSpec: null,
  properties: null,
  newTagFor: null,
  batchRename: null,
  selectPatternOpen: false,
  sendTo: null,
  folderTree: null,
  shortcutsOpen: false,
  settingsOpen: false,
  helpOpen: false,
  paletteOpen: false,
  clipHistoryOpen: false,
  contextMenu: null,
  dragOver: null,
  openConfirm: (spec) =>
    set((s) => {
      // Do not leave the caller of a replaced confirm waiting.
      s.confirm?.onCancel?.();
      return { confirm: spec };
    }),
  closeConfirm: () => set({ confirm: null }),
  openConflicts: (spec) =>
    set((s) => {
      // Only one transfer resolves conflicts. A new one cancels the old one, so its promise does not hang.
      s.conflictSpec?.resolve(null);
      return { conflictSpec: { ...spec, id: nextConflictId++ } };
    }),
  closeConflicts: () => set({ conflictSpec: null }),
  openProperties: (entries) =>
    set({ properties: Array.isArray(entries) ? entries : [entries] }),
  closeProperties: () => set({ properties: null }),
  openNewTag: (newTagFor) => set({ newTagFor }),
  closeNewTag: () => set({ newTagFor: null }),
  setSelectPatternOpen: (selectPatternOpen) => set({ selectPatternOpen }),
  openSendTo: (paths, mode) => set({ sendTo: { paths, mode } }),
  closeSendTo: () => set({ sendTo: null }),
  openBatchRename: (batchRename) => set({ batchRename }),
  closeBatchRename: () => set({ batchRename: null }),
  openFolderTree: (root, pane, archive) => set({ folderTree: { root, pane, archive } }),
  closeFolderTree: () => set({ folderTree: null }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setClipHistoryOpen: (clipHistoryOpen) => set({ clipHistoryOpen }),
  openContextMenu: (x, y, items, commands = []) =>
    set({ contextMenu: { x, y, items, commands } }),
  closeContextMenu: () => set({ contextMenu: null }),
  setDragOver: (dragOver) => set({ dragOver }),
}));
