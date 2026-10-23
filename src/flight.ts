import { findTab, openPanes } from "./stores/tabs";
import { EASE, dur } from "./util/motion";
import { iconOf, liftIcon, visibleRect } from "./util/itemRect";
import type { Rect } from "./types";

/**
 * Items moved, trashed or brought back fly where they go: a copy of each
 * icon arcs from its row to the Trash, a folder, a tab or a breadcrumb, or
 * from there into the row it lands in. The copies are clones in a fixed
 * layer over the window, animated by transform and opacity alone, so the
 * listing underneath carries on as usual.
 */

/** Where things fly to or from. */
export type Place = { kind: "trash" } | { kind: "path"; path: string };

/** A copy of an icon taken while it was on screen, to fly from later. */
export interface Launch {
  node: Element;
  rect: Rect;
}

/** More than this many fly as this many, the first carrying the count. */
const MAX_FLYING = 5;
const STAGGER_MS = 40;
/** How long an arriving item's row has to show up before it is left be. */
const ARRIVE_WAIT_MS = 1200;
/** Eases away and settles long, so the arc reads as a throw. */
const THROW = "cubic-bezier(0.45, 0, 0.2, 1)";

/** Paths flying out of or into a listing, whose rows don't animate as well. */
const flying = new Set<string>();

/** Whether `path`'s row is leaving or arriving by flight. */
export function isFlying(path: string): boolean {
  return flying.has(path);
}

function mark(path: string, ms: number) {
  flying.add(path);
  setTimeout(() => flying.delete(path), ms);
}

/**
 * Marks `paths` as leaving or arriving by flight for a while, so their rows
 * come and go without animating as well.
 */
export function markFlying(paths: string[], ms = ARRIVE_WAIT_MS + 2000) {
  for (const p of paths) mark(p, ms);
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function layer(): HTMLElement {
  let el = document.getElementById("flight-layer");
  if (!el) {
    el = document.createElement("div");
    el.id = "flight-layer";
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
  }
  return el;
}

/** The folder the tab with id `id` shows. */
function tabFolder(id: number): string | null {
  const tab = findTab(id)?.tab;
  return tab && tab.location.kind === "path" ? tab.location.path : null;
}

/** Whether a listing on screen shows `folder`, so items arriving there can be seen. */
export function shownIn(folder: string): boolean {
  return openPanes().some((p) => {
    const tab = p.tabs.find((t) => t.id === p.activeId);
    return tab?.location.kind === "path" && tab.location.path === folder;
  });
}

/**
 * What stands for `place` on screen: the Trash in the navigation pane, or a
 * folder's tile or row, navigation entry, tab or breadcrumb, whichever is in
 * view first.
 */
function placeElement(place: Place): Element | null {
  const all = (q: string) => [...document.querySelectorAll<HTMLElement>(q)];
  const iconIn = (el: HTMLElement) => el.querySelector(".thumb, img, svg") ?? el;
  let found: Element[];
  if (place.kind === "trash") {
    found = all('[data-drop="nav|trash"] .navicon');
  } else {
    const p = CSS.escape(place.path);
    found = [
      ...all(`[data-drop="row|path:${p}"]`).map(iconIn),
      ...all(`[data-drop="nav|path:${p}"] .navicon`),
      ...all("[data-tab-id]")
        .filter((t) => tabFolder(Number(t.dataset.tabId)) === place.path)
        .map(iconIn),
      ...all(`[data-drop="crumb|path:${p}"]`),
    ];
  }
  return found.find((el) => visibleRect(el)) ?? null;
}

const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/**
 * Keyframes carrying a clone laid out at `base` from `from` to `to` along an
 * arc that bows upwards, growing or shrinking to `to`'s size (times
 * `endScale`) on the way.
 */
function arc(base: Rect, from: Rect, to: Rect, endScale = 1): Keyframe[] {
  const a = centre(from);
  const b = centre(to);
  const o = centre(base);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  // Bow sideways from the straight line, on whichever side is up.
  let nx = -dy / dist;
  let ny = dx / dist;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const bow = Math.min(140, dist * 0.28);
  const cx = a.x + dx / 2 + nx * bow;
  const cy = a.y + dy / 2 + ny * bow;
  const size = (r: Rect) => Math.max(r.w, r.h);
  const s0 = size(from) / size(base);
  const s1 = (size(to) / size(base)) * endScale;
  const frames: Keyframe[] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * a.x + 2 * u * t * cx + t * t * b.x;
    const y = u * u * a.y + 2 * u * t * cy + t * t * b.y;
    const s = s0 + (s1 - s0) * t;
    frames.push({
      offset: t,
      transform: `translate(${x - o.x}px, ${y - o.y}px) scale(${s})`,
    });
  }
  return frames;
}

/** How long a flight over `from` → `to` takes: longer for longer trips. */
function durationFor(from: Rect, to: Rect): number {
  const a = centre(from);
  const b = centre(to);
  const k = dur("slow") / 340;
  const ms = (300 + Math.hypot(b.x - a.x, b.y - a.y) * 0.45) * k;
  return Math.min(dur("long") * 1.35, Math.max(dur("slow"), ms));
}

/** A copy of `node` laid out at `at` in the flight layer. */
function cloneAt(node: Element, at: Rect, count = 0): HTMLElement {
  const box = document.createElement("div");
  box.className = "flight";
  Object.assign(box.style, {
    left: `${at.x}px`,
    top: `${at.y}px`,
    width: `${at.w}px`,
    height: `${at.h}px`,
  });
  const copy = node.cloneNode(true) as Element;
  copy.removeAttribute("id");
  copy.removeAttribute("data-lifted");
  box.appendChild(copy);
  if (count > 1) {
    const badge = document.createElement("span");
    badge.className = "flight-count";
    badge.textContent = String(count);
    box.appendChild(badge);
  }
  layer().appendChild(box);
  return box;
}

/** The target swells a touch as things land on it; just a blink with Reduce Motion. */
function bump(target: Element) {
  if (reducedMotion()) {
    target.animate([{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], { duration: 360 });
    return;
  }
  target.animate([{ scale: "1" }, { scale: "1.06" }, { scale: "1" }], {
    duration: dur("base"),
    easing: EASE,
  });
}

/** Copies of the icons of those `paths` on screen now, to fly later. */
export function capture(paths: string[]): Map<string, Launch> {
  const out = new Map<string, Launch>();
  for (const p of paths) {
    const icon = iconOf(p);
    const rect = icon && visibleRect(icon);
    if (icon && rect) out.set(p, { node: icon.cloneNode(true) as Element, rect });
  }
  return out;
}

/**
 * Flies the icons on screen among `paths` to `place`. `leaving` says the
 * items leave their listing (a move or the Trash, not a copy), so their
 * rows go without fading out as well and their icons hide at once. Returns
 * whether anything flew.
 */
export function flyTo(paths: string[], place: Place, leaving = true): boolean {
  const target = placeElement(place);
  const to = target && visibleRect(target);
  if (!target || !to) return false;
  if (reducedMotion()) {
    bump(target);
    return false;
  }
  const launches = paths.flatMap((p) => {
    const icon = iconOf(p);
    const rect = icon && visibleRect(icon);
    return icon && rect ? [{ p, icon, rect }] : [];
  });
  if (launches.length === 0) return false;
  let landed = Infinity;
  launches.slice(0, MAX_FLYING).forEach(({ p, icon, rect }, i) => {
    const d = durationFor(rect, to);
    const delay = i * STAGGER_MS;
    if (leaving) {
      // Its row is normally gone well before; one that stays (the move
      // failed) shows its icon again.
      mark(p, delay + d + 1000);
      setTimeout(liftIcon(icon), delay + d + 1000);
    }
    const box = cloneAt(icon, rect, i === 0 ? paths.length : 0);
    // Shrinks to a little under the target's size, fading as it gets there.
    const endScale = 0.7;
    const gone = () => box.remove();
    box
      .animate(arc(rect, rect, to, endScale), { duration: d, delay, easing: THROW, fill: "both" })
      .finished.then(gone, gone);
    box.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: d * 0.3,
      delay: delay + d * 0.7,
      fill: "both",
    });
    landed = Math.min(landed, delay + d * 0.85);
  });
  // The rest leave with their rows.
  for (const { p, icon } of launches.slice(MAX_FLYING)) {
    if (leaving) {
      mark(p, 2000);
      setTimeout(liftIcon(icon), 2000);
    }
  }
  setTimeout(() => bump(target), landed);
  return true;
}

/** Waits for `path`'s icon to be drawn in a listing, a frame at a time. */
function arrival(path: string): Promise<HTMLElement | null> {
  const until = performance.now() + ARRIVE_WAIT_MS;
  return new Promise((resolve) => {
    const look = () => {
      const icon = iconOf(path);
      if (icon && visibleRect(icon)) return resolve(icon);
      if (performance.now() > until) return resolve(null);
      requestAnimationFrame(look);
    };
    look();
  });
}

/**
 * Flies each of `items` into its row once the listing draws it at `path`:
 * from a copy of its icon taken where it was, or out of a place (the
 * Trash, a folder) on screen. Call before the items arrive, so their rows
 * come in without their own animation.
 */
export function flyIn(items: { path: string; from: Launch | Place }[]) {
  if (reducedMotion() || items.length === 0) return;
  const some = items.slice(0, MAX_FLYING);
  for (const { path } of some) mark(path, ARRIVE_WAIT_MS + 2000);
  some.forEach(({ path, from }, i) => {
    void arrival(path).then((icon) => {
      if (!icon) return;
      const to = visibleRect(icon);
      const source = "kind" in from ? placeElement(from) : null;
      const start = "kind" in from ? source && visibleRect(source) : from.rect;
      if (!to || !start) return;
      const release = liftIcon(icon);
      // Laid out at the landing size, so a thumbnail stays sharp as it grows.
      const box = cloneAt("kind" in from ? icon : from.node, to);
      const d = durationFor(start, to);
      const delay = i * STAGGER_MS;
      const done = () => {
        release();
        box.remove();
      };
      box
        .animate(arc(to, start, to), { duration: d, delay, easing: EASE, fill: "both" })
        .finished.then(done, done);
      if ("kind" in from) {
        box.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: d * 0.3,
          delay,
          fill: "both",
        });
      }
    });
  });
}

/**
 * The drag ghost, let go over `target`, shrinks into it instead of
 * vanishing where the pointer was.
 */
export function absorb(target: Element) {
  const chip = document.querySelector(".drag-ghost .drag-chip");
  const icon =
    target.querySelector(".navicon") ?? target.querySelector(".thumb, img, svg") ?? target;
  const from = chip && visibleRect(chip);
  const to = visibleRect(icon);
  if (!chip || !from || !to) return;
  if (reducedMotion()) {
    bump(icon);
    return;
  }
  const box = cloneAt(chip, from);
  const d = dur("base");
  const a = centre(from);
  const b = centre(to);
  const gone = () => box.remove();
  box
    .animate(
      [
        { transform: "none", opacity: 1 },
        { transform: `translate(${b.x - a.x}px, ${b.y - a.y}px) scale(0.2)`, opacity: 0 },
      ],
      { duration: d, easing: EASE, fill: "both" }
    )
    .finished.then(gone, gone);
  setTimeout(() => bump(icon), d * 0.7);
}
