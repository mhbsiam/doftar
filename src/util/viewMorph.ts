import { getPaneEntries } from "../actions";
import { itemDomId } from "../hooks/useListNav";
import { runTransition, setViewSwitcher } from "./transition";
import { visibleRect } from "./itemRect";

/**
 * A switch between List and Icons view carries each file icon from its row to its tile, and back.
 * View transitions are off on Linux (WebKitGTK never runs their update callback; see
 * util/transition.ts), and the icon carry needs more than the page fade anyway. So the carry is a
 * manual FLIP: the icons on screen are measured before the switch, measured again at their new
 * place, and each one is animated from its old rect with the spring the listing itself uses.
 * Only one screenful is carried, because the lists are virtualized. The rest fades with the page.
 */

const MAX_CARRIED = 120;

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
      if (out.size >= MAX_CARRIED) return out;
    }
  }
  return out;
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

function morph(update: () => void) {
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
  setViewSwitcher(morph);
}
