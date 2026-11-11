import { create } from "zustand";
import type { Progress } from "../types";

const SHOW_AFTER_MS = 400;

export interface JobInfo {
  id: number;
  title: string;
  shown: boolean;
  cancelling: boolean;
  pausable: boolean;
  /** The folder a copy or move fills. Its icon shows the progress. */
  dest?: string;
  progress: Progress | null;
  rate: number;
  lastAt: number;
  lastBytes: number;
}

interface JobsStore {
  jobs: JobInfo[];
  add: (id: number, title: string, pausable?: boolean, dest?: string) => void;
  update: (id: number, progress: Progress) => void;
  setCancelling: (id: number) => void;
  remove: (id: number) => void;
}

const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useJobs = create<JobsStore>((set) => ({
  jobs: [],
  add: (id, title, pausable = false, dest) => {
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
          pausable,
          dest,
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
        // A pause is not a slow copy. Start the rate again from the resume.
        if (progress.paused) return { ...j, progress, rate: 0, lastAt: now, lastBytes: progress.bytesDone };
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

/** Steps of the progress ring on a destination folder. Coarse, so its icon redraws a few dozen times. */
export const RING_STEPS = 40;

/** How far the job that fills `path` is, in `RING_STEPS`. -1 when none is shown. */
export function ringOf(jobs: JobInfo[], path: string): number {
  const p = jobs.find((j) => j.shown && j.dest === path)?.progress;
  if (p === undefined) return -1;
  return p && p.bytesTotal > 0 && !p.scanning ? Math.round(Math.min(1, p.bytesDone / p.bytesTotal) * RING_STEPS) : 0;
}
