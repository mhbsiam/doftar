import { getPaneEntries } from "../actions";
import { itemDomId } from "../hooks/useListNav";
import { runTransition, setViewSwitcher } from "./transition";
import { visibleRect } from "./itemRect";

/**
 * Switching between Details and Icons view carries each file's icon from its
 * row to its tile (and back). The icons on screen are given a
 * view-transition-name before the switch and again after it, and the browser
 * moves each old one into its new place while the rest of the listing fades,
 * as for any page change. Only a screenful is named, since names must be
 * unique and the lists are virtualized; the rest fades with the page.
 */

const MAX_NAMED = 120;
/** Long enough for the transition, which ends within about half a second. */
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

function morph(update: () => void) {
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

/** Makes view switches carry icons across. */
export function startViewMorph() {
  setViewSwitcher(morph);
}
