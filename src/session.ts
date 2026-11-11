import { getCurrentWindow, LogicalPosition, LogicalSize, availableMonitors } from "@tauri-apps/api/window";
import { api } from "./ipc";
import { paneStore, portableTab, restoreTabs, usePanes } from "./stores/tabs";
import { isTabClosing } from "./util/tabClose";
import type { PortableTab } from "./types";
import { parseSession, type Frame, type Session } from "./util/session";

// The main window's tabs and frame, saved for the next launch. It always opens in one pane. Tab windows are not kept.
const KEY = "doftar-session";
const HISTORY_KEEP = 30;

const inTrash = (path: string) => /\/\.Trash(es)?(\/|$)/.test(path);

/** The window stays hidden until restore ends. An offline network drive can block a check for minutes. */
const CHECK_MS = 1500;

/** Drop tabs whose folder is gone, in the Trash, or does not answer in time. */
async function liveTabs(tabs: PortableTab[]): Promise<PortableTab[]> {
  const ok = await Promise.all(
    tabs.map((t) => {
      const loc = t.history[t.historyIndex];
      if (loc.kind !== "path") return true;
      if (inTrash(loc.path)) return false;
      const late = new Promise<boolean>((r) => setTimeout(() => r(false), CHECK_MS));
      return Promise.race([api.isFolder(loc.path).catch(() => false), late]);
    })
  );
  return tabs.filter((_, i) => ok[i]);
}

let frame: Frame | undefined;

/** Call before the window shows, so it opens where it was. */
export async function restoreSession() {
  const saved = parseSession(readStorage());
  if (!saved) return;
  frame = saved.frame;
  const panes = await Promise.all(saved.panes.map(liveTabs));
  // An active tab that was dropped falls back to the nearest one.
  if (panes[0]?.length) restoreTabs(panes[0], saved.active[0] ?? 0);
  if (frame && (await onScreen(frame))) {
    const win = getCurrentWindow();
    await win.setSize(new LogicalSize(frame.width, frame.height)).catch(() => {});
    await win.setPosition(new LogicalPosition(frame.x, frame.y)).catch(() => {});
  }
}

/** True if the frame's top left corner is on a connected display. */
async function onScreen(f: Frame): Promise<boolean> {
  const monitors = await availableMonitors().catch(() => []);
  return monitors.some((m) => {
    const s = m.scaleFactor;
    const x = m.position.x / s;
    const y = m.position.y / s;
    return f.x >= x && f.y >= y && f.x < x + m.size.width / s && f.y < y + m.size.height / s;
  });
}

function readStorage(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function trimHistory(t: PortableTab): PortableTab {
  const start = Math.max(0, t.historyIndex - HISTORY_KEEP + 1);
  return { ...t, history: t.history.slice(start, start + HISTORY_KEEP), historyIndex: t.historyIndex - start };
}

export function snapshotSession(): Session {
  // In split view the right pane's tabs follow the left pane's, and the left pane's open tab stays open.
  const halves = usePanes.getState().split ? [0, 1] : [0];
  const tabs = halves.flatMap((i) => paneStore(i).getState().tabs).filter((t) => !isTabClosing(t.id));
  const activeId = paneStore(0).getState().activeId;
  return {
    panes: [tabs.map((t) => trimHistory(portableTab(t)))],
    active: [Math.max(0, tabs.findIndex((t) => t.id === activeId))],
    frame,
  };
}

let timer: ReturnType<typeof setTimeout> | null = null;

export function saveSessionNow() {
  if (timer) clearTimeout(timer);
  timer = null;
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshotSession()));
  } catch {
    // Storage full or blocked: the next launch opens on Home.
  }
}

const saveSoon = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(saveSessionNow, 400);
};

/** Main window only. Saves after each change to the tabs, the split or the frame. */
export function startSessionSave() {
  const win = getCurrentWindow();
  if (win.label !== "main") return;
  for (const pane of [0, 1]) {
    paneStore(pane).subscribe((s, prev) => {
      if (s.tabs !== prev.tabs || s.activeId !== prev.activeId) saveSoon();
    });
  }
  usePanes.subscribe(saveSoon);
  const readFrame = async () => {
    // Split view may grow the window. The next launch is one pane, so it keeps the size from before.
    if (usePanes.getState().split || document.documentElement.classList.contains("split-animating")) return;
    if ((await win.isFullscreen().catch(() => false)) || (await win.isMinimized().catch(() => false))) return;
    const scale = await win.scaleFactor();
    const pos = (await win.outerPosition()).toLogical(scale);
    const size = (await win.innerSize()).toLogical(scale);
    frame = { x: pos.x, y: pos.y, width: size.width, height: size.height };
    saveSoon();
  };
  void win.onMoved(() => void readFrame());
  void win.onResized(() => void readFrame());
  window.addEventListener("beforeunload", saveSessionNow);
}
