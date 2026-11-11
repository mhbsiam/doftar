import { itemDomId } from "../hooks/useListNav";
import { useTabs } from "../stores/tabs";
import { getPaneEntries } from "../actions";
import type { Rect } from "../types";

/** The thumbnail or icon of `path` in a listing: the focused pane first, then the other half of a split. */
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

/** Where `el` is drawn. Null if it is not on screen: no size, or its center is outside its scroller or the window. */
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
 * Where the thumbnail or icon of `path` is drawn in a listing. Null if it is not on screen.
 * Flying items start and end here.
 */
export function itemRect(path: string): Rect | null {
  const icon = iconOf(path);
  return icon && visibleRect(icon);
}

/**
 * Hides the icon of `path` while a copy flies, so it never shows twice. Returns a function that shows it again.
 * A row that the list redraws meanwhile comes back by itself. This is harmless.
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
