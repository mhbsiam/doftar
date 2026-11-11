import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { StoreApi, UseBoundStore } from "zustand";
import { useSettings } from "./settings";
import { useAppData } from "./appdata";
import { useClipboard } from "./clipboard";
import { isRestoring, useHistory } from "./history";
import { applyTextScale } from "../util/textScale";

// Each window has its own stores. Shared state is mirrored to the other windows,
// so a save never writes back an old copy.

const self = getCurrentWindow().label;

interface SyncMessage {
  from: string;
  state: Record<string, unknown>;
}

function mirror<T extends object>(
  name: string,
  store: UseBoundStore<StoreApi<T>>,
  keys: readonly (keyof T & string)[],
  onApplied?: (next: T, prev: T) => void,
  /** True for this window's own load. It is not an edit to share. */
  isLoad?: (next: T, prev: T) => boolean
) {
  const event = `sync:${name}`;
  let applying = false;
  store.subscribe((s, prev) => {
    if (applying || isLoad?.(s, prev)) return;
    const changed = keys.filter((k) => s[k] !== prev[k]);
    if (changed.length === 0) return;
    const state = Object.fromEntries(changed.map((k) => [k, s[k]]));
    void emit(event, { from: self, state } satisfies SyncMessage).catch(() => {});
  });
  void listen<SyncMessage>(event, ({ payload }) => {
    if (payload.from === self) return;
    const prev = store.getState();
    applying = true;
    try {
      store.setState(payload.state as Partial<T>);
    } finally {
      applying = false;
    }
    onApplied?.(store.getState(), prev);
  });
}

function dataKeys<T extends object>(store: UseBoundStore<StoreApi<T>>): (keyof T & string)[] {
  const state = store.getState();
  return (Object.keys(state) as (keyof T & string)[]).filter((k) => typeof state[k] !== "function");
}

let started = false;

export function startWindowSync() {
  if (started) return;
  started = true;
  // Share all settings. A field missing from a list is written back old.
  mirror("settings", useSettings, dataKeys(useSettings), (next, prev) => {
    if (next.textScale !== prev.textScale) applyTextScale(next.textScale);
  });
  // A new window that reads favorites from disk must not overwrite the live copy.
  mirror("appdata", useAppData, ["favorites", "recents", "recentFolders", "trashOrigins"], undefined, (_, prev) => prev.phase === "loading");
  mirror("clipboard", useClipboard, ["op", "paths", "changeCount", "cutAt"]);
  // One undo history for the app. Each window saves all of it.
  // `busy` is shared, so two windows cannot undo at once.
  mirror("history", useHistory, ["undo", "redo", "log", "busy"], undefined, isRestoring);
  // A window that closes during an undo cannot clear `busy`.
  void listen<string>("window:destroyed", ({ payload: label }) => {
    if (useHistory.getState().busy === label) useHistory.getState().setBusy(null);
  });
}
