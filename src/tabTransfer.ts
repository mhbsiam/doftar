import { create } from "zustand";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api } from "./ipc";
import { focusPane, paneStore, usePanes } from "./stores/tabs";
import type { PortableTab } from "./types";

// Tab move between windows. The source window finds the window under the pointer. It sends
// "tab:hover" and "tab:drop" to it. The target answers "tab:drop-reply" with a strip slot or
// null. Then the source sends "tab:drop-commit" and removes its copy. A late reply is ignored,
// so a tab is never in two windows.

const win = getCurrentWebviewWindow();
const self = win.label;

/** Distance above or below the tab strip that still counts as on the strip. */
const SLACK = 12;
/** Time in ms before a hover marker clears if the source window is silent. */
const HOVER_TTL = 600;

interface Point {
  x: number;
  y: number;
}

interface DropMessage extends Point {
  nonce: string;
  from: string;
}

interface Slot {
  pane: number;
  index: number;
}

interface DropReply {
  nonce: string;
  slot: Slot | null;
}

interface DropCommit {
  nonce: string;
  tab: PortableTab;
  slot: Slot;
}


export interface InsertMarker {
  x: number;
  top: number;
  height: number;
}

export const useIncomingTab = create<{ marker: InsertMarker | null }>(() => ({ marker: null }));

export function slotAt(p: Point): { pane: number; index: number; marker: InsertMarker } | null {
  // A split has one strip per half. Use the one under the point.
  const bars = Array.from(document.querySelectorAll<HTMLElement>(".titlebar"));
  const barEl = bars.find((b) => {
    const r = b.getBoundingClientRect();
    return p.x >= r.left && p.x <= r.right;
  });
  const bar = barEl?.getBoundingClientRect();
  const list = barEl?.querySelector(".tablist");
  const pane = Number(barEl?.closest<HTMLElement>("[data-pane]")?.dataset.pane ?? 0);
  if (!bar || !list) return null;
  if (p.y < bar.top - SLACK || p.y > bar.bottom + SLACK) return null;
  const rects = Array.from(list.children).map((el) => el.getBoundingClientRect());
  const listRect = list.getBoundingClientRect();
  const index = rects.filter((r) => r.left + r.width / 2 < p.x).length;
  const gap = rects.length > 1 ? rects[1].left - rects[0].right : 0;
  const x =
    rects.length === 0
      ? listRect.left
      : index < rects.length
        ? rects[index].left - gap / 2
        : rects[rects.length - 1].right + gap / 2;
  return { pane, index, marker: { x, top: listRect.top + 6, height: listRect.height - 12 } };
}

let started = false;

export function startTabTransfer() {
  if (started) return;
  started = true;
  let ttl: ReturnType<typeof setTimeout> | null = null;
  const setMarker = (marker: InsertMarker | null) => {
    if (ttl) clearTimeout(ttl);
    ttl = marker ? setTimeout(() => useIncomingTab.setState({ marker: null }), HOVER_TTL) : null;
    useIncomingTab.setState({ marker });
  };

  void win.listen<Point | null>("tab:hover", ({ payload }) => {
    setMarker(payload ? slotAt(payload)?.marker ?? null : null);
  });

  void win.listen<DropMessage>("tab:drop", ({ payload }) => {
    setMarker(null);
    const slot = slotAt(payload);
    void emitTo<DropReply>(payload.from, "tab:drop-reply", {
      nonce: payload.nonce,
      slot: slot && { pane: slot.pane, index: slot.index },
    }).catch(() => {});
  });

  const taken = new Set<string>();
  void win.listen<DropCommit>("tab:drop-commit", ({ payload }) => {
    if (taken.has(payload.nonce)) return;
    taken.add(payload.nonce);
    // The split can close after the reply.
    const pane = usePanes.getState().split ? payload.slot.pane : 0;
    paneStore(pane).getState().insertTab(payload.tab, payload.slot.index);
    focusPane(pane);
    void win.setFocus().catch(() => {});
  });
}


/** Returns another window of this app under a screen point, with coordinates in that window. */
async function windowAt(screenX: number, screenY: number) {
  const hit = await api.tabWindowAt(screenX, screenY).catch(() => null);
  return hit && hit.label !== self ? hit : null;
}

let hoverGen = 0;
let hoverBusy = false;
let hoverNext: Point | null = null;
let hoverLabel: string | null = null;

const sendHover = (label: string, p: Point | null) =>
  void emitTo(label, "tab:hover", p).catch(() => {});

export function trackTabHover(screenX: number, screenY: number) {
  hoverNext = { x: screenX, y: screenY };
  if (!hoverBusy) void pumpHover();
}

async function pumpHover() {
  hoverBusy = true;
  try {
    while (hoverNext) {
      const at = hoverNext;
      hoverNext = null;
      const gen = hoverGen;
      const hit = await windowAt(at.x, at.y);
      if (gen !== hoverGen) continue;
      const label = hit?.label ?? null;
      if (hoverLabel && hoverLabel !== label) sendHover(hoverLabel, null);
      hoverLabel = label;
      if (hit) sendHover(hit.label, { x: hit.x, y: hit.y });
    }
  } finally {
    hoverBusy = false;
  }
}

export function endTabHover() {
  hoverGen++;
  hoverNext = null;
  if (hoverLabel) sendHover(hoverLabel, null);
  hoverLabel = null;
}

/** Offer `tab` to the window whose tab strip is at the screen point. Returns true if it took the tab. */
export async function dropTabAt(tab: PortableTab, screenX: number, screenY: number) {
  endTabHover();
  const hit = await windowAt(screenX, screenY);
  if (!hit) return false;
  const nonce = `${self}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  // Settle once. The first of the reply and the timeout wins.
  let settle: (slot: Slot | null) => void = () => {};
  const reply = new Promise<Slot | null>((resolve) => (settle = resolve));
  // Listen before sending, so a fast reply is not missed.
  const unlisten = await win
    .listen<DropReply>("tab:drop-reply", ({ payload }) => {
      if (payload.nonce === nonce) settle(payload.slot);
    })
    .catch(() => null);
  if (!unlisten) return false;
  const timer = setTimeout(() => settle(null), 1500);
  try {
    await emitTo<DropMessage>(hit.label, "tab:drop", { nonce, from: self, x: hit.x, y: hit.y });
    const slot = await reply;
    if (!slot) return false;
    await emitTo<DropCommit>(hit.label, "tab:drop-commit", { nonce, tab, slot });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    unlisten();
  }
}
