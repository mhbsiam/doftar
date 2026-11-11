import { create } from "zustand";

/** Files still being written. A path stays for a moment after each write. */
interface WritingStore {
  paths: Record<string, true>;
  mark: (path: string) => void;
}

const HOLD_MS = 5_000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const useWriting = create<WritingStore>((set, get) => ({
  paths: {},
  mark: (path) => {
    const old = timers.get(path);
    if (old) clearTimeout(old);
    timers.set(
      path,
      setTimeout(() => {
        timers.delete(path);
        const { [path]: _, ...rest } = get().paths;
        set({ paths: rest });
      }, HOLD_MS)
    );
    if (!get().paths[path]) set({ paths: { ...get().paths, [path]: true } });
  },
}));
