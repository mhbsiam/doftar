import { create } from "zustand";
import { usePane } from "./tabs";

interface DragStore {
  active: boolean;
  ghost: boolean;
  paths: string[];
  overKey: string | null;
  /**
   * How long the target under the pointer waits before it springs open
   * (a folder's row or tile, a tab), in ms; 0 when it won't. The target
   * draws a ring filling over that time.
   */
  springMs: number;
  blocked: boolean;
  label: string;
  copy: boolean;
  x: number;
  y: number;
  start: (paths: string[], x: number, y: number, ghost?: boolean) => void;
  move: (x: number, y: number) => void;
  setOver: (
    over: Partial<Pick<DragStore, "overKey" | "springMs" | "blocked" | "label" | "copy">>
  ) => void;
  end: () => void;
}

export const useDrag = create<DragStore>((set) => ({
  active: false,
  ghost: false,
  paths: [],
  overKey: null,
  springMs: 0,
  blocked: false,
  label: "",
  copy: false,
  x: 0,
  y: 0,
  start: (paths, x, y, ghost = true) =>
    set({
      active: true,
      ghost,
      paths,
      x,
      y,
      overKey: null,
      springMs: 0,
      blocked: false,
      label: "",
      copy: false,
    }),
  move: (x, y) => set({ x, y }),
  setOver: (over) => set(over),
  end: () =>
    set({
      active: false,
      ghost: false,
      paths: [],
      overKey: null,
      springMs: 0,
      blocked: false,
      label: "",
      copy: false,
    }),
}));

/** Whether `key` in this component's pane is the drop target under the pointer. */
export function useDropHover(key: string | undefined): boolean {
  const pane = usePane();
  return useDrag((s) => key !== undefined && s.overKey === `${key}#${pane}`);
}

/**
 * The dwell before `key` in this pane springs open under a drag, in ms, or 0
 * when it is not the target or won't open. Goes back to 0 once it has opened.
 */
export function useDropSpring(key: string | undefined): number {
  const pane = usePane();
  return useDrag((s) =>
    key !== undefined && s.overKey === `${key}#${pane}` ? s.springMs : 0
  );
}
