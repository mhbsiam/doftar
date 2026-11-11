import { flushSync } from "react-dom";

export type TransitionKind = "forward" | "back" | "fade" | "reveal";

interface Job {
  kind: TransitionKind;
  update: () => boolean | void;
  wait: boolean;
  /** Runs after the update reaches the page, inside the transition. */
  after?: () => void;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (cb: () => void | Promise<void>) => {
    ready: Promise<void>;
    updateCallbackDone: Promise<void>;
    finished: Promise<void>;
  };
};

const SETTLE_CAP_MS = 80;

const pending: Job[] = [];
let armed = false;
let token = 0;
let settle: (() => void) | null = null;
/** Settles when the update of the armed transition is on screen. */
let live: Promise<void> = Promise.resolve();

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function notifySettled() {
  settle?.();
}

function drain() {
  for (const job of pending.splice(0)) job.update();
}

/** Applies the queued updates now, before their transition. The transition then has none. */
export function flushTransitions() {
  drain();
}

export function runTransition(
  kind: TransitionKind,
  update: Job["update"],
  wait = false,
  after?: Job["after"]
): Promise<void> {
  pending.push({ kind, update, wait, after });
  if (armed) return live;

  const doc = document as ViewTransitionDocument;
  // While the split halves move, a snapshot would draw the arriving page at rest,
  // apart from its pane. See setSplitAnimating in stores/tabs.ts.
  if (!doc.startViewTransition || reducedMotion() || document.documentElement.classList.contains("split-animating")) {
    drain();
    return Promise.resolve();
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
    live = t.updateCallbackDone.catch(() => {});
    void t.finished
      .catch(() => {})
      .finally(() => {
        if (token === mine) {
          delete root.dataset.vt;
          delete root.dataset.vtPane;
        }
      });
    return live;
  } catch {
    armed = false;
    delete root.dataset.vt;
    delete root.dataset.vtPane;
    drain();
    return Promise.resolve();
  }
}

/**
 * Runs `update` under a circle that spreads from the center of `from` (else the window center)
 * until it covers the window. For theme and accent changes. See `html[data-vt="reveal"]` in global.css.
 */
export function runReveal(update: () => void, from?: Element | null): Promise<void> {
  const r = from?.getBoundingClientRect();
  const w = window.innerWidth;
  const h = window.innerHeight;
  const x = r ? r.left + r.width / 2 : w / 2;
  const y = r ? r.top + r.height / 2 : h / 2;
  const style = document.documentElement.style;
  style.setProperty("--vt-x", `${x}px`);
  style.setProperty("--vt-y", `${y}px`);
  style.setProperty("--vt-r", `${Math.ceil(Math.hypot(Math.max(x, w - x), Math.max(y, h - y)))}px`);
  return runTransition("reveal", update);
}

type ViewSwitcher = (update: () => void) => void;
let switcher: ViewSwitcher | null = null;

/** Lets another module carry icons across a view switch. See viewMorph.ts. */
export function setViewSwitcher(fn: ViewSwitcher) {
  switcher = fn;
}

export function runViewSwitch(update: () => void) {
  if (switcher) switcher(update);
  else runTransition("fade", update);
}
