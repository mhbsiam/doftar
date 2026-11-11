import { findTab, openPanes } from "./stores/tabs";
import { EASE, dur } from "./util/motion";
import { iconOf, liftIcon, visibleRect } from "./util/itemRect";
import type { Rect } from "./types";

/**
 * Items that move fly. A clone of each icon arcs from its row to the target, or from a source
 * into its new row. Clones are in a fixed layer and animate by transform and opacity only.
 */

export type Place = { kind: "trash" } | { kind: "path"; path: string };

export interface Launch {
  node: Element;
  rect: Rect;
}

/** Fly at most this many items. The first one shows the count. */
const MAX_FLYING = 5;
const STAGGER_MS = 40;
const ARRIVE_WAIT_MS = 1200;
const THROW = "cubic-bezier(0.45, 0, 0.2, 1)";

/** Paths whose rows must not animate, because they fly. */
const flying = new Set<string>();

export function isFlying(path: string): boolean {
  return flying.has(path);
}

function mark(path: string, ms: number) {
  flying.add(path);
  setTimeout(() => flying.delete(path), ms);
}

/** Stop the row animation of `paths` for `ms`, because they fly. */
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

function tabFolder(id: number): string | null {
  const tab = findTab(id)?.tab;
  return tab && tab.location.kind === "path" ? tab.location.path : null;
}

export function shownIn(folder: string): boolean {
  return openPanes().some((p) => {
    const tab = p.tabs.find((t) => t.id === p.activeId);
    return tab?.location.kind === "path" && tab.location.path === folder;
  });
}

/**
 * Returns the on-screen element for `place`: the Trash, or the first visible row, nav entry,
 * tab or breadcrumb of the folder.
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
  // A closed navigation pane is still laid out, but clipped and inert.
  return found.find((el) => !el.closest("[inert]") && visibleRect(el)) ?? null;
}

const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/**
 * Keyframes for a clone at `base` that arcs upward from `from` to `to`. It scales to the size
 * of `to` times `endScale`.
 */
function arc(base: Rect, from: Rect, to: Rect, endScale = 1): Keyframe[] {
  const a = centre(from);
  const b = centre(to);
  const o = centre(base);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
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

function durationFor(from: Rect, to: Rect): number {
  const a = centre(from);
  const b = centre(to);
  const k = dur("slow") / 340;
  const ms = (300 + Math.hypot(b.x - a.x, b.y - a.y) * 0.45) * k;
  return Math.min(dur("long") * 1.35, Math.max(dur("slow"), ms));
}

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

/** The target swells as items land. With Reduce Motion it blinks. */
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
 * Fly the icons of `paths` to `place`. `leaving` means the items leave their listing (move or
 * Trash), so the rows go without a fade and the icons hide at once. Returns true if
 * anything flew.
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
      // The row normally goes first. If it stays (the move failed), show the icon again.
      mark(p, delay + d + 1000);
      setTimeout(liftIcon(icon), delay + d + 1000);
    }
    const box = cloneAt(icon, rect, i === 0 ? paths.length : 0);
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
  for (const { p, icon } of launches.slice(MAX_FLYING)) {
    if (leaving) {
      mark(p, 2000);
      setTimeout(liftIcon(icon), 2000);
    }
  }
  setTimeout(() => bump(target), landed);
  return true;
}

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
 * Fly each of `items` into its row when the listing draws it at `path`. The source is an icon
 * copy or an on-screen place. Call before the items arrive, so the rows do not animate.
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
      // Use the landing size, so a thumbnail stays sharp as it grows.
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

/** Shrink the drag ghost into `target` after a drop. */
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
