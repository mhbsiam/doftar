import { getPaneEntries } from "../actions";
import { itemDomId } from "../hooks/useListNav";
import { runTransition, setViewSwitcher } from "./transition";
import { visibleRect } from "./itemRect";
import { ON_LINUX } from "./platform";

/**
 * A switch between List and Icons view carries each file icon from its row to its tile, and back.
 * The icons on screen get a view-transition-name before the switch and again after it.
 * The browser moves each old icon to its new place while the rest of the listing fades.
 * Only one screenful gets names, because names must be unique and the lists are virtualized.
 * The rest fades with the page.
 *
 * View transitions are off on Linux (WebKitGTK never runs their update callback; see
 * util/transition.ts). There the carry is a manual FLIP: the icons on screen are measured before
 * the switch, measured again at their new place, and each one is animated from its old rect.
 */

const MAX_NAMED = 120;
/** Longer than the transition, which ends within about half a second. */
const CLEAR_AFTER_MS = 1200;
const CLASS = "wf-icon";

/** The icons in view, as `pane|path` → icon. */
function listedIcons(): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>();
  for (const pane of [0, 1]) {
    const entries = getPaneEntries(pane);
    if (entries.length === 0) continue;
    const prefix = itemDomId(0, pane).slice(0, -1);
    for (const item of document.querySelectorAll<HTMLElement>(`[id^="${prefix}"]`)) {
      const entry = entries[Number(item.id.slice(prefix.length))];
      const icon = item.querySelector<HTMLElement>(".thumb, img, svg");
      if (!entry || !icon || !visibleRect(icon)) continue;
      out.set(`${pane}|${entry.path}`, icon);
      if (out.size >= MAX_NAMED) return out;
    }
  }
  return out;
}

function name(icon: HTMLElement, id: string) {
  icon.style.viewTransitionName = id;
  icon.style.setProperty("view-transition-class", CLASS);
}

let clearTimer: ReturnType<typeof setTimeout> | undefined;

function clearNames() {
  clearTimeout(clearTimer);
  for (const el of document.querySelectorAll<HTMLElement>("[style*='view-transition-name']")) {
    el.style.viewTransitionName = "";
    el.style.removeProperty("view-transition-class");
  }
}

function morphNamed(update: () => void) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const supported = "startViewTransition" in document && CSS.supports("view-transition-name", "x");
  let named: Map<string, string> | null = null;
  if (supported && !reduced) {
    clearNames();
    named = new Map();
    let n = 0;
    for (const [key, icon] of listedIcons()) {
      const id = `wf-icon-${n++}`;
      named.set(key, id);
      name(icon, id);
    }
  }
  runTransition("fade", update, false, () => {
    if (!named) return;
    for (const [key, icon] of listedIcons()) {
      const id = named.get(key);
      if (id) name(icon, id);
    }
    clearTimer = setTimeout(clearNames, CLEAR_AFTER_MS);
  });
}

/** The icons in view, as `pane|path` → rect, measured while the page is at rest. */
function measureIcons(): Map<string, DOMRect> {
  const out = new Map<string, DOMRect>();
  for (const [key, icon] of listedIcons()) out.set(key, icon.getBoundingClientRect());
  return out;
}

/** The standard motion duration, read from the stylesheet so the two stay in step. */
function springDurationMs(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--dur-slow");
  const ms = parseFloat(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : 340;
}

function flipIcons(before: Map<string, DOMRect>) {
  const duration = springDurationMs();
  for (const [key, icon] of listedIcons()) {
    const old = before.get(key);
    if (!old) continue;
    const now = icon.getBoundingClientRect();
    const dx = old.left + old.width / 2 - (now.left + now.width / 2);
    const dy = old.top + old.height / 2 - (now.top + now.height / 2);
    const scale = now.width > 0 && old.width > 0 ? old.width / now.width : 1;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(scale - 1) < 0.02) continue;
    try {
      icon.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
          { transform: "none" },
        ],
        { duration, easing: "cubic-bezier(0.25, 1, 0.5, 1)" },
      );
    } catch {
      // Without the Animation interface there is no carry; the page fade covers it.
    }
  }
}

/** Linux: measure, switch, then animate each icon from its old place. */
function morphFlip(update: () => void) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const before = !reduced ? measureIcons() : null;
  const root = document.documentElement;
  if (before) {
    // The page holds still while the icons carry it: html.vt-morphing rules in
    // global.css hold the fallback page fade off for one frame.
    root.classList.add("vt-morphing");
    // A hidden window gets no animation frames, so the hold must not stick.
    setTimeout(() => root.classList.remove("vt-morphing"), 600);
  }
  runTransition("fade", update, false, () => {
    if (!before) return;
    // Measure at rest, then let the page fade in under the flying icons.
    requestAnimationFrame(() => {
      flipIcons(before);
      root.classList.remove("vt-morphing");
    });
  });
}

export function startViewMorph() {
  setViewSwitcher(ON_LINUX ? morphFlip : morphNamed);
}
