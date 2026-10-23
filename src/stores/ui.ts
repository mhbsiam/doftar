import type React from "react";
import { create } from "zustand";
import type { Conflict, FileEntry, Resolutions } from "../types";

/** One colour dot in a row of them inside a menu, toggled on click. */
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
  /** Draws a row of colour dots instead of an item; `label` names the row. */
  swatches?: SwatchSpec[];
  icon?: React.ReactElement;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  dividerBefore?: boolean;
  items?: MenuItemSpec[];
  onSelect?: () => void;
}

export interface CommandSpec {
  key: string;
  label: string;
  icon?: React.ReactElement;
  disabled?: boolean;
  onSelect?: () => void;
}

export interface ConfirmSpec {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  hideCancel?: boolean;
  /** A second action offered beside the main one. */
  alt?: { label: string; onSelect: () => void };
  onConfirm: () => void;
  onCancel?: () => void;
}

export interface ConflictSpec {
  conflicts: Conflict[];
  resolve: (resolutions: Resolutions | null) => void;
  /** Changes per request so the dialog's per-item state resets. */
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
  /** Errors interrupt assistive tech; everything else is announced politely. */
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
  /** The "New Tag" dialog, and the items the new tag goes on. */
  newTagFor: FileEntry[] | null;
  contextMenu: { x: number; y: number; items: MenuItemSpec[]; commands: CommandSpec[] } | null;
  /** The pane whose listing files from outside are being dragged over. */
  dragOver: number | null;
  openConfirm: (spec: ConfirmSpec) => void;
  closeConfirm: () => void;
  openConflicts: (spec: Omit<ConflictSpec, "id">) => void;
  closeConflicts: () => void;
  openProperties: (entries: FileEntry | FileEntry[]) => void;
  closeProperties: () => void;
  openNewTag: (entries: FileEntry[]) => void;
  closeNewTag: () => void;
  openContextMenu: (x: number, y: number, items: MenuItemSpec[], commands?: CommandSpec[]) => void;
  closeContextMenu: () => void;
  setDragOver: (pane: number | null) => void;
}

export type ActiveModal = "confirm" | "conflicts" | "properties" | "newTag" | "menu";

export function activeModal(s: UIStore = useUI.getState()): ActiveModal | null {
  if (s.confirm) return "confirm";
  if (s.conflictSpec) return "conflicts";
  if (s.properties) return "properties";
  if (s.newTagFor) return "newTag";
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
  contextMenu: null,
  dragOver: null,
  openConfirm: (spec) =>
    set((s) => {
      // A confirm that gets replaced must not leave its caller waiting.
      s.confirm?.onCancel?.();
      return { confirm: spec };
    }),
  closeConfirm: () => set({ confirm: null }),
  openConflicts: (spec) =>
    set((s) => {
      // Only one transfer can be resolving conflicts; a newer one cancels the
      // older request rather than silently stranding its promise.
      s.conflictSpec?.resolve(null);
      return { conflictSpec: { ...spec, id: nextConflictId++ } };
    }),
  closeConflicts: () => set({ conflictSpec: null }),
  openProperties: (entries) =>
    set({ properties: Array.isArray(entries) ? entries : [entries] }),
  closeProperties: () => set({ properties: null }),
  openNewTag: (newTagFor) => set({ newTagFor }),
  closeNewTag: () => set({ newTagFor: null }),
  openContextMenu: (x, y, items, commands = []) =>
    set({ contextMenu: { x, y, items, commands } }),
  closeContextMenu: () => set({ contextMenu: null }),
  setDragOver: (dragOver) => set({ dragOver }),
}));
