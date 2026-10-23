import { create } from "zustand";
import type { Progress } from "../types";

const SHOW_AFTER_MS = 400;

export interface JobInfo {
  id: number;
  title: string;
  shown: boolean;
  cancelling: boolean;
  progress: Progress | null;
  rate: number;
  lastAt: number;
  lastBytes: number;
}

interface JobsStore {
  jobs: JobInfo[];
  add: (id: number, title: string) => void;
  update: (id: number, progress: Progress) => void;
  setCancelling: (id: number) => void;
  remove: (id: number) => void;
}

const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useJobs = create<JobsStore>((set) => ({
  jobs: [],
  add: (id, title) => {
    timers.set(
      id,
      setTimeout(() => {
        set((s) => ({
          jobs: s.jobs.map((j) => (j.id === id ? { ...j, shown: true } : j)),
        }));
      }, SHOW_AFTER_MS)
    );
    set((s) => ({
      jobs: [
        ...s.jobs,
        {
          id,
          title,
          shown: false,
          cancelling: false,
          progress: null,
          rate: 0,
          lastAt: performance.now(),
          lastBytes: 0,
        },
      ],
    }));
  },
  update: (id, progress) =>
    set((s) => ({
      jobs: s.jobs.map((j) => {
        if (j.id !== id) return j;
        const now = performance.now();
        const dt = (now - j.lastAt) / 1000;
        let rate = j.rate;
        if (dt >= 0.25 && progress.bytesDone >= j.lastBytes) {
          const inst = (progress.bytesDone - j.lastBytes) / dt;
          rate = j.rate === 0 ? inst : j.rate * 0.7 + inst * 0.3;
          return { ...j, progress, rate, lastAt: now, lastBytes: progress.bytesDone };
        }
        return { ...j, progress };
      }),
    })),
  setCancelling: (id) =>
    set((s) => ({
      jobs: s.jobs.map((j) => (j.id === id ? { ...j, cancelling: true } : j)),
    })),
  remove: (id) => {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
  },
}));
