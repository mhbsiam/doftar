import { create } from "zustand";
import { api } from "../ipc";
import { useSettings } from "./settings";

export interface TerminalApp {
  name: string;
  /** The application bundle's path. */
  path: string;
}

interface TerminalsStore {
  /** Supported terminals found on this Mac (Terminal, iTerm2, Warp, Ghostty, WezTerm, Zentty). */
  detected: TerminalApp[];
  load: () => Promise<void>;
}

export const useTerminals = create<TerminalsStore>((set) => ({
  detected: [],
  load: async () => {
    const apps = await api.terminalApps().catch(() => []);
    set({ detected: apps.map(({ name, path }) => ({ name, path })) });
  },
}));

export function appName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.app$/i, "");
}

/** Detected terminals, then any added with "Choose another app…". */
export function terminalList(detected: TerminalApp[], extras: string[]): TerminalApp[] {
  const list = [...detected];
  for (const p of extras) {
    if (!list.some((t) => t.path === p)) list.push({ name: appName(p), path: p });
  }
  return list;
}

/** The terminal "Open in Terminal" uses: the last one picked, else Terminal. */
export function defaultOf(list: TerminalApp[], chosen: string | null): TerminalApp | null {
  return list.find((t) => t.path === chosen) ?? list[0] ?? null;
}

export function currentTerminals() {
  const { terminalApp, terminalExtras } = useSettings.getState();
  const list = terminalList(useTerminals.getState().detected, terminalExtras);
  return { list, def: defaultOf(list, terminalApp) };
}

/** The same, for components that should update when the choice changes. */
export function useTerminalChoices() {
  const detected = useTerminals((s) => s.detected);
  const chosen = useSettings((s) => s.terminalApp);
  const extras = useSettings((s) => s.terminalExtras);
  const list = terminalList(detected, extras);
  return { list, def: defaultOf(list, chosen) };
}

let started = false;

/** Finds the installed terminals and keeps File > Open in … named after the default. */
export function startTerminals() {
  if (started) return;
  started = true;
  const push = () => void api.setTerminalLabel(currentTerminals().def?.name ?? "Terminal").catch(() => {});
  void useTerminals.getState().load().then(push);
  useSettings.subscribe((s, prev) => {
    if (s.terminalApp !== prev.terminalApp || s.terminalExtras !== prev.terminalExtras) push();
  });
}
