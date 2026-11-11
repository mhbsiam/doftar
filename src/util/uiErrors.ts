import { api } from "../ipc";

/** Per minute, so a failure that repeats can't push the first error out of the log, and can't silence a later one. */
const MAX_REPORTS = 20;
const REFILL_MS = 60_000;
let left = MAX_REPORTS;
let refillAt = 0;

export function describeError(err: unknown): string {
  // WebKit's `stack` holds the frames only, without the message.
  if (err instanceof Error) return `${err}\n${err.stack ?? ""}`.trim();
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

export function logUiError(kind: string, err: unknown) {
  const now = Date.now();
  if (now >= refillAt) {
    left = MAX_REPORTS;
    refillAt = now + REFILL_MS;
  }
  if (left <= 0) return;
  left--;
  void api.logUiError(kind, describeError(err)).catch(() => {});
}

/** Catches what no component can: errors in event handlers, timers and promises. */
export function startUiErrorLog() {
  window.addEventListener("error", (e) => {
    // WebKit's notice about a skipped layout pass, not a fault.
    if (e.message.includes("ResizeObserver loop")) return;
    logUiError("error", e.error ?? e.message);
  });
  window.addEventListener("unhandledrejection", (e) => logUiError("unhandled rejection", e.reason));
}
