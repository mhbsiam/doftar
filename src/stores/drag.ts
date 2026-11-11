import { create } from "zustand";
import { usePane } from "./tabs";

interface DragStore {
  active: boolean;
  ghost: boolean;
  paths: string[];
  overKey: string | null;
  /** Delay in ms before the target under the pointer opens. 0 if it does not open. */
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

export function useDropHover(key: string | undefined): boolean {
  const pane = usePane();
  return useDrag((s) => key !== undefined && s.overKey === `${key}#${pane}`);
}

/** Delay in ms before `key` opens in this pane. 0 if it is not the target. */
export function useDropSpring(key: string | undefined): number {
  const pane = usePane();
  return useDrag((s) =>
    key !== undefined && s.overKey === `${key}#${pane}` ? s.springMs : 0
  );
}
