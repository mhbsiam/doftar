/**
 * Stands in for Tauri so components run in a plain browser.
 * A command answers with what a test sets through `reply`, called with the arguments if it is a function, or null.
 */
const replies: Record<string, unknown> = { file_ids: [] };

export function reply(cmd: string, value: unknown) {
  replies[cmd] = value;
}

Object.assign(window, {
  __TAURI_INTERNALS__: {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    invoke: async (cmd: string, args: unknown) => {
      const r = replies[cmd];
      return (typeof r === "function" ? r(args) : r) ?? null;
    },
    transformCallback: () => 0,
    unregisterCallback: () => {},
    convertFileSrc: (path: string) => path,
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
});
