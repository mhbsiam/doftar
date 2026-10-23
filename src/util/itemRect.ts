import { itemDomId } from "../hooks/useListNav";
import { useTabs } from "../stores/tabs";
import { getPaneEntries } from "../actions";
import type { Rect } from "../types";

/**
 * `path`'s thumbnail or icon in a listing: the focused pane's first, then
 * the other half of a split.
 */
export function iconOf(path: string): HTMLElement | null {
  const focused = useTabs.getState().pane;
  for (const pane of [focused, 1 - focused]) {
    const index = getPaneEntries(pane).findIndex((e) => e.path === path);
    if (index < 0) continue;
    const item = document.getElementById(itemDomId(index, pane));
    const icon = item?.querySelector<HTMLElement>(".thumb, img, svg");
    if (icon) return icon;
  }
  return null;
}

function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return null;
}

/**
 * Where `el` is drawn, or null when it isn't on screen: no size, or its
 * centre scrolled out of its scroller or the window.
 */
export function visibleRect(el: Element): Rect | null {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return null;
  const view = el instanceof HTMLElement ? scrollerOf(el)?.getBoundingClientRect() : undefined;
  if (view && (cx < view.left || cx > view.right || cy < view.top || cy > view.bottom)) {
    return null;
  }
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/**
 * Where `path`'s thumbnail or icon is drawn in a listing, or null when it
 * isn't on screen (scrolled away, or a row the list hasn't drawn). Things
 * that fly to or from an item start and end here.
 */
export function itemRect(path: string): Rect | null {
  const icon = iconOf(path);
  return icon && visibleRect(icon);
}

/**
 * Hides `path`'s icon while a copy of it is in flight, so it never shows
 * twice; returns what puts it back. A row the list redraws meanwhile comes
 * back by itself, which is harmless.
 */
export function liftItem(path: string): () => void {
  const icon = iconOf(path);
  return icon ? liftIcon(icon) : () => {};
}

export function liftIcon(icon: HTMLElement): () => void {
  icon.dataset.lifted = "";
  return () => {
    delete icon.dataset.lifted;
  };
}
