import { flushSync } from "react-dom";

export type TransitionKind = "forward" | "back" | "fade";

interface Job {
  kind: TransitionKind;
  update: () => boolean | void;
  wait: boolean;
  /** Runs once the update has reached the page, inside the transition. */
  after?: () => void;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (cb: () => void | Promise<void>) => {
    ready: Promise<void>;
    updateCallbackDone: Promise<void>;
    finished: Promise<void>;
  };
};

const SETTLE_CAP_MS = 160;

const pending: Job[] = [];
let armed = false;
let token = 0;
let settle: (() => void) | null = null;

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function notifySettled() {
  settle?.();
}

function drain() {
  for (const job of pending.splice(0)) job.update();
}

export function runTransition(
  kind: TransitionKind,
  update: Job["update"],
  wait = false,
  after?: Job["after"]
) {
  pending.push({ kind, update, wait, after });
  if (armed) return;

  const doc = document as ViewTransitionDocument;
  if (!doc.startViewTransition || reducedMotion()) {
    drain();
    return;
  }

  const root = document.documentElement;
  const mine = ++token;
  armed = true;
  root.dataset.vt = kind;
  try {
    const t = doc.startViewTransition(async () => {
      armed = false;
      const jobs = pending.splice(0);
      if (jobs.length === 0) return;
      root.dataset.vt = jobs[jobs.length - 1].kind;
      const settled = jobs.some((j) => j.wait)
        ? new Promise<void>((resolve) => {
            settle = resolve;
            setTimeout(resolve, SETTLE_CAP_MS);
          })
        : null;
      let changed = false;
      flushSync(() => {
        for (const job of jobs) if (job.update() !== false) changed = true;
      });
      for (const job of jobs) job.after?.();
      if (settled && changed) await settled;
      settle = null;
    });
    void t.ready.catch(() => {});
    void t.updateCallbackDone.catch(() => {});
    void t.finished
      .catch(() => {})
      .finally(() => {
        if (token === mine) {
          delete root.dataset.vt;
          delete root.dataset.vtPane;
        }
      });
  } catch {
    armed = false;
    delete root.dataset.vt;
    delete root.dataset.vtPane;
    drain();
  }
}

type ViewSwitcher = (update: () => void) => void;
let switcher: ViewSwitcher | null = null;

/** Lets another module carry icons across a switch of view (see viewMorph.ts). */
export function setViewSwitcher(fn: ViewSwitcher) {
  switcher = fn;
}

/** Runs `update`, which switches between Details and Icons view. */
export function runViewSwitch(update: () => void) {
  if (switcher) switcher(update);
  else runTransition("fade", update);
}
