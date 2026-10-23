import { api } from "./ipc";
import { useJobs } from "./stores/jobs";
import type { OpResult, Progress } from "./types";

// The backend keeps every window's file operations in one registry by id,
// and a job's commands don't say which window started it; so each window
// (and each reload) counts from its own random start rather than from 1,
// or two windows' jobs would replace and cancel each other.
let nextJobId = Math.floor(Math.random() * 2 ** 32) * 2 ** 20 + 1;

export function runJob(
  title: string,
  run: (jobId: number, onProgress: (p: Progress) => void) => Promise<OpResult>
): Promise<OpResult> {
  const id = nextJobId++;
  useJobs.getState().add(id, title);
  return run(id, (p) => useJobs.getState().update(id, p)).finally(() =>
    useJobs.getState().remove(id)
  );
}

export function cancelJob(id: number) {
  useJobs.getState().setCancelling(id);
  void api.cancelJob(id).catch(() => {});
}
