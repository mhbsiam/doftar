import { flushSync } from "react-dom";
import { ON_LINUX } from "./platform";

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
/** Long enough for the slowest fallback entrance (a closing tab: --dur-long plus its delay). */
const FALLBACK_CLEAR_MS = 700;
/** The global color cross-fade stand-in for the theme reveal. */
const REVEAL_FADE_MS = 320;

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

  // WebKitGTK accepts startViewTransition but never runs the update callback, so
  // navigations and theme changes queued there would never apply; on some builds
  // the transition also crashes the web process and takes the window down. Rather
  // than lose the motion, Linux takes the fallback: the arriving page slides or
  // fades in through the html.vt-fallback rules in global.css, and a theme reveal
  // becomes a short global color cross-fade.
  if (ON_LINUX) return runFallback();
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
 * The no-view-transition path. Applies the queued updates in one flush, holds the
 * returned promise until a waiting listing has settled (same contract as the view
 * transition's `updateCallbackDone`), and lets the html.vt-fallback rules in
 * global.css animate the arriving page.
 */
function runFallback(): Promise<void> {
  const jobs = pending.splice(0);
  if (jobs.length === 0) return Promise.resolve();
  const root = document.documentElement;
  const mine = ++token;
  const kind = jobs[jobs.length - 1].kind;
  const settled = jobs.some((j) => j.wait)
    ? new Promise<void>((resolve) => {
        settle = resolve;
        setTimeout(resolve, SETTLE_CAP_MS);
      })
    : null;
  // The reveal animates the change of theme itself, so the color transition must
  // be armed before the new colors land, or there is no old state to move from.
  if (kind === "reveal") armRevealFallback();
  root.classList.add("vt-fallback");
  root.dataset.vt = kind;
  const clear = () =>
    setTimeout(() => {
      if (token !== mine) return;
      root.classList.remove("vt-fallback");
      delete root.dataset.vt;
      delete root.dataset.vtPane;
    }, FALLBACK_CLEAR_MS);
  let changed = false;
  try {
    flushSync(() => {
      for (const job of jobs) if (job.update() !== false) changed = true;
    });
    for (const job of jobs) job.after?.();
  } catch (e) {
    // A throwing update must not leave the markers on: every later navigation would
    // replay the entrance animation until reload.
    settle = null;
    clear();
    throw e;
  }
  const done = settled && changed ? settled : Promise.resolve();
  return done.finally(() => {
    settle = null;
    // Leave the markers on until the entrance animation has played out, so a
    // paint in between does not cut it short. A newer transition re-arms them.
    clear();
  });
}

/**
 * The circle reveal spreads a snapshot of the new theme, which needs view
 * transitions. Without them the theme change still animates: a short transition
 * on the colors of every element cross-fades the whole window to the new look.
 */
function armRevealFallback() {
  if (document.getElementById("vt-reveal-fallback")) return;
  const style = document.createElement("style");
  style.id = "vt-reveal-fallback";
  style.textContent = `.vt-reveal-anim, .vt-reveal-anim *, .vt-reveal-anim *::before, .vt-reveal-anim *::after {
    transition: background-color ${REVEAL_FADE_MS}ms var(--ease-out),
      color ${REVEAL_FADE_MS}ms var(--ease-out),
      border-color ${REVEAL_FADE_MS}ms var(--ease-out),
      fill ${REVEAL_FADE_MS}ms var(--ease-out) !important;
  }`;
  document.head.appendChild(style);
  document.documentElement.classList.add("vt-reveal-anim");
  setTimeout(() => {
    style.remove();
    document.documentElement.classList.remove("vt-reveal-anim");
  }, REVEAL_FADE_MS + 120);
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
