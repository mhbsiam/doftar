import type { Location, PortableTab } from "../types";

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Session {
  /** One pane. A list, so sessions saved in split view still load. */
  panes: PortableTab[][];
  /** Index of the open tab in each pane. */
  active: number[];
  frame?: Frame;
}

const isLocation = (l: unknown): l is Location => {
  if (!l || typeof l !== "object") return false;
  const x = l as Record<string, unknown>;
  if (x.kind === "path") return typeof x.path === "string" && x.path.startsWith("/");
  if (x.kind === "compare") return typeof x.a === "string" && typeof x.b === "string";
  return ["home", "disk", "tags", "screenshots", "skills", "repos"].includes(x.kind as string);
};

/** Keep well-formed tabs only. The saved copy may be from an older version or hand-edited. */
export function parseSession(raw: string | null): Session | null {
  if (!raw) return null;
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!r || typeof r !== "object" || !Array.isArray(r.panes)) return null;
  const panes = r.panes.slice(0, 1).map((list: unknown) =>
    (Array.isArray(list) ? list : []).flatMap((t: unknown): PortableTab[] => {
      const p = t as Partial<PortableTab> | null;
      if (!p || !Array.isArray(p.history) || !p.history.every(isLocation) || p.history.length === 0) return [];
      const historyIndex = typeof p.historyIndex === "number" ? Math.max(0, Math.min(p.historyIndex, p.history.length - 1)) : 0;
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
      return [{
        history: p.history,
        historyIndex,
        selection: strings(p.selection),
        anchor: typeof p.anchor === "string" ? p.anchor : null,
        columns: p.columns === true,
      }];
    })
  );
  const f = r.frame as Partial<Frame> | undefined;
  const frame =
    f && [f.x, f.y, f.width, f.height].every((n) => typeof n === "number" && Number.isFinite(n))
      ? (f as Frame)
      : undefined;
  return {
    panes,
    active: Array.isArray(r.active) ? r.active.map((n) => (typeof n === "number" ? n : 0)) : [],
    frame,
  };
}

