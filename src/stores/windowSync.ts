import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { StoreApi, UseBoundStore } from "zustand";
import { useSettings } from "./settings";
import { useAppData } from "./appdata";
import { useClipboard } from "./clipboard";
import { applyTextScale } from "../util/textScale";

// Every window runs its own copy of the stores. Shared state is mirrored to
// the other windows as it changes, so a favorite added in one window shows in
// the others and their saves never write back an older copy.

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
  /** Changes that are this window's own catching up, not edits to share. */
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

/** The fields of a store's state, leaving out its actions. */
function dataKeys<T extends object>(store: UseBoundStore<StoreApi<T>>): (keyof T & string)[] {
  const state = store.getState();
  return (Object.keys(state) as (keyof T & string)[]).filter((k) => typeof state[k] !== "function");
}

let started = false;

export function startWindowSync() {
  if (started) return;
  started = true;
  // Every setting is shared: a field left off a hand-kept list would be
  // written back stale by whichever window saved last.
  mirror("settings", useSettings, dataKeys(useSettings), (next, prev) => {
    if (next.textScale !== prev.textScale) applyTextScale(next.textScale);
  });
  // A new window reading favorites and recents from disk must not send that
  // copy over the live one in the windows already open.
  mirror("appdata", useAppData, ["favorites", "recents", "trashOrigins"], undefined, (s, prev) => s.ready && !prev.ready);
  mirror("clipboard", useClipboard, ["op", "paths", "changeCount", "cutAt"]);
}
