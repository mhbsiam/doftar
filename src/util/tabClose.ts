import { SPRING, dur } from "./motion";

const closing = new Set<number>();
/** Undo steps for the temporary styles. Run them after the tab leaves the DOM. */
const cleanups = new Map<number, Array<() => void>>();

export const isTabClosing = (id: number) => closing.has(id);

// Wider than the tab, so its shadow is not clipped.
const FULL = "inset(-8px -8px -8px -8px)";

/**
 * Closes a tab with transform and clip-path only, so it stays smooth with many tabs.
 * Starts after `after` settles, because a page transition would freeze the animation.
 * Resolves when the tab is gone from view, or at once if nothing animates.
 * The caller then removes it from the store.
 */
export function animateTabClose(id: number, after: Promise<void> = Promise.resolve()): Promise<void> {
  closing.add(id);
  document.documentElement.classList.add("tab-closing");
  return after.then(() => collapse(id));
}

function collapse(id: number): Promise<void> {
  const el = document.querySelector<HTMLElement>(`.tab[data-tab-id="${id}"]`);
  const list = el?.parentElement;
  if (!el || !list || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return Promise.resolve();
  }

  const ms = dur("long");
  const plus = el.closest(".titlebar")?.querySelector<HTMLElement>(".new-tab");
  const movers = Array.from(list.children).filter((c): c is HTMLElement => c !== el && c instanceof HTMLElement);
  const first = new Map<HTMLElement, DOMRect>();
  for (const m of movers) first.set(m, m.getBoundingClientRect());
  const plusFirst = plus?.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const listRect = list.getBoundingClientRect();

  // Lift the closing tab out of the row. Pin it where it was.
  const restore: Array<() => void> = [];
  const setStyle = (target: HTMLElement, props: Partial<CSSStyleDeclaration>) => {
    const before: Partial<CSSStyleDeclaration> = {};
    for (const k of Object.keys(props) as Array<keyof CSSStyleDeclaration>) {
      (before as Record<string, unknown>)[k as string] = target.style[k as never];
    }
    Object.assign(target.style, props);
    restore.push(() => Object.assign(target.style, before));
  };
  setStyle(list, { position: "relative" });
  setStyle(el, {
    position: "absolute",
    left: `${rect.left - listRect.left}px`,
    top: `${rect.top - listRect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    zIndex: "0",
    pointerEvents: "none",
  });
  // Without a previous tab, the next tab loses its separating margin.
  const next = el.nextElementSibling;
  if (!el.previousElementSibling && next instanceof HTMLElement) {
    setStyle(next, { marginLeft: "0px" });
  }

  const animations: Animation[] = [];
  const slide = (target: HTMLElement, from: DOMRect) => {
    const to = target.getBoundingClientRect();
    const dx = from.left - to.left;
    // A neighbour that grew into the space is revealed, not stretched.
    const grown = Math.max(0, to.width - from.width);
    if (Math.abs(dx) < 0.5 && grown < 0.5) return;
    animations.push(
      target.animate(
        [
          { transform: `translateX(${dx}px)`, clipPath: `inset(-8px ${grown}px -8px -8px)` },
          { transform: "none", clipPath: FULL },
        ],
        { duration: ms, easing: SPRING }
      )
    );
  };
  for (const m of movers) slide(m, first.get(m)!);
  if (plus && plusFirst) {
    const dx = plusFirst.left - plus.getBoundingClientRect().left;
    if (Math.abs(dx) >= 0.5) {
      animations.push(
        plus.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], {
          duration: ms,
          easing: SPRING,
        })
      );
    }
  }

  // The closing tab narrows in place as it fades, on the same spring as its neighbours.
  // Its right edge then stays just ahead of what slides in.
  const own = el.animate(
    [
      { clipPath: FULL, opacity: 1 },
      { clipPath: "inset(-8px calc(100% + 8px) -8px -8px)", opacity: 0 },
    ],
    { duration: ms, easing: SPRING, fill: "forwards" }
  );
  animations.push(own);

  // Keep the styles until the tab is removed (see `tabClosed`).
  // An earlier undo puts the tab back in the row for one frame.
  cleanups.set(id, restore);
  return Promise.allSettled(animations.map((a) => a.finished)).then(() => undefined);
}

/** Call after the tab is removed or the close is cancelled. */
export function tabClosed(id: number) {
  closing.delete(id);
  const undo = cleanups.get(id);
  cleanups.delete(id);
  // After the removal paints, remove the temporary styles from the remaining tabs.
  if (undo) requestAnimationFrame(() => undo.reverse().forEach((f) => f()));
  if (closing.size === 0) document.documentElement.classList.remove("tab-closing");
}
