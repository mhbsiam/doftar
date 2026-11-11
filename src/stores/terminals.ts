import { create } from "zustand";
import { api } from "../ipc";
import { useSettings } from "./settings";

export interface TerminalApp {
  name: string;
  path: string;
}

interface TerminalsStore {
  detected: TerminalApp[];
  editors: TerminalApp[];
  load: () => Promise<void>;
}

export const useTerminals = create<TerminalsStore>((set) => ({
  detected: [],
  editors: [],
  load: async () => {
    const [apps, editors] = await Promise.all([
      api.terminalApps().catch(() => []),
      api.editorApps().catch(() => []),
    ]);
    const pick = (l: TerminalApp[]) => l.map(({ name, path }) => ({ name, path }));
    set({ detected: pick(apps), editors: pick(editors) });
  },
}));

export function appName(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.app$/i, "");
}

/** Detected apps plus added apps, minus `skip`. Old settings can hold editors as terminals. */
export function terminalList(
  detected: TerminalApp[],
  extras: string[],
  skip: TerminalApp[] = []
): TerminalApp[] {
  const list = [...detected];
  for (const p of extras) {
    if (!list.some((t) => t.path === p)) list.push({ name: appName(p), path: p });
  }
  return list.filter((t) => !skip.some((e) => e.path === t.path));
}

export function defaultOf(list: TerminalApp[], chosen: string | null): TerminalApp | null {
  return list.find((t) => t.path === chosen) ?? list[0] ?? null;
}

export function currentTerminals() {
  const { terminalApp, terminalExtras } = useSettings.getState();
  const { detected, editors } = useTerminals.getState();
  const list = terminalList(detected, terminalExtras, editors);
  return { list, def: defaultOf(list, terminalApp) };
}

export function useTerminalChoices() {
  const detected = useTerminals((s) => s.detected);
  const editors = useTerminals((s) => s.editors);
  const chosen = useSettings((s) => s.terminalApp);
  const extras = useSettings((s) => s.terminalExtras);
  const list = terminalList(detected, extras, editors);
  return { list, def: defaultOf(list, chosen) };
}

export function currentEditors() {
  const { editorApp, editorExtras } = useSettings.getState();
  const list = terminalList(useTerminals.getState().editors, editorExtras);
  return { list, def: defaultOf(list, editorApp) };
}

/** Words that open an app in a folder: editor command-line tools, and names for terminals. */
const APP_WORDS: Record<string, string> = {
  code: "Visual Studio Code",
  "code-insiders": "Visual Studio Code - Insiders",
  cursor: "Cursor",
  zed: "Zed",
  windsurf: "Windsurf",
  surf: "Windsurf",
  antigravity: "Antigravity",
  agy: "Antigravity",
  subl: "Sublime Text",
  nova: "Nova",
  bbedit: "BBEdit",
  terminal: "Terminal",
  warp: "Warp",
};

/**
 * `code .`, `zed src` or `warp .`: an installed app and the one plain path it was given.
 * Flags, `~`, quotes and shell syntax give null, so the terminal runs them.
 */
export function appCommand(command: string, apps: TerminalApp[]): { app: TerminalApp; arg: string } | null {
  const m = /^(\S+)\s+(?!-)([^\s~;|&<>$`*?(){}'"\\]+)$/.exec(command.trim());
  const app = m && apps.find((a) => a.name === APP_WORDS[m[1].toLowerCase()]);
  return m && app ? { app, arg: m[2] } : null;
}

export function useEditorChoices() {
  const detected = useTerminals((s) => s.editors);
  const chosen = useSettings((s) => s.editorApp);
  const extras = useSettings((s) => s.editorExtras);
  const list = terminalList(detected, extras);
  return { list, def: defaultOf(list, chosen) };
}

let started = false;

/** Find the installed terminals. Name File > Open in … after the default. */
export function startTerminals() {
  if (started) return;
  started = true;
  const push = () => void api.setTerminalLabel(currentTerminals().def?.name ?? "Terminal").catch(() => {});
  void useTerminals.getState().load().then(push);
  useSettings.subscribe((s, prev) => {
    if (s.terminalApp !== prev.terminalApp || s.terminalExtras !== prev.terminalExtras) push();
  });
}
