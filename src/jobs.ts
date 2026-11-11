import { api } from "./ipc";
import { useJobs } from "./stores/jobs";
import type { OpResult, Progress } from "./types";

// Start job ids at a random number, not 1. The backend has one job registry for all windows.
// Job commands do not name their window. Equal ids in two windows, or after a reload, replace and cancel jobs.
let nextJobId = Math.floor(Math.random() * 2 ** 32) * 2 ** 20 + 1;

export function runJob<T = OpResult>(
  title: string,
  run: (jobId: number, onProgress: (p: Progress) => void) => Promise<T>,
  /** Copies and moves can pause. Jobs that run a system tool cannot. */
  pausable = false,
  /** The folder the job fills, if it has one. */
  dest?: string
): Promise<T> {
  const id = nextJobId++;
  useJobs.getState().add(id, title, pausable, dest);
  return run(id, (p) => useJobs.getState().update(id, p)).finally(() =>
    useJobs.getState().remove(id)
  );
}

export function pauseJob(id: number, paused: boolean) {
  void api.pauseJob(id, paused).catch(() => {});
}

export function cancelJob(id: number) {
  useJobs.getState().setCancelling(id);
  void api.cancelJob(id).catch(() => {});
}
