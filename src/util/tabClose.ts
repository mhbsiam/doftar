import { EASE_IN, SPRING, dur } from "./motion";

const closing = new Set<number>();
/** Undo steps for the temporary styles, run once the tab has left the DOM. */
const cleanups = new Map<number, Array<() => void>>();

export const isTabClosing = (id: number) => closing.has(id);

// Wider than the tab so its shadow isn't clipped.
const FULL = "inset(-8px -8px -8px -8px)";

/**
 * Winds a tab down without animating layout. The closing tab is lifted out of
 * the row, which moves its neighbours to their final places in one layout
 * pass; each neighbour then plays from where it was to where it is, using only
 * transform and clip-path (compositing and paint, no per-frame layout). That
 * stays smooth however many tabs are open.
 *
 * Resolves once the tab is gone from view; the caller then removes it from the
 * store. Resolves at once if there is nothing to animate.
 */
export function animateTabClose(id: number): Promise<void> {
  const el = document.querySelector<HTMLElement>(`.tab[data-tab-id="${id}"]`);
  const list = el?.parentElement;
  if (!el || !list || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return Promise.resolve();
  }
  closing.add(id);
  document.documentElement.classList.add("tab-closing");

  const ms = dur("long");
  const plus = el.closest(".titlebar")?.querySelector<HTMLElement>(".new-tab");
  const movers = Array.from(list.children).filter((c): c is HTMLElement => c !== el && c instanceof HTMLElement);
  const first = new Map<HTMLElement, DOMRect>();
  for (const m of movers) first.set(m, m.getBoundingClientRect());
  const plusFirst = plus?.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const listRect = list.getBoundingClientRect();

  // Lift the closing tab out of the row, pinned where it was.
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
  // Without a previous tab, the next one loses its separating margin.
  const next = el.nextElementSibling;
  if (!el.previousElementSibling && next instanceof HTMLElement) {
    setStyle(next, { marginLeft: "0px" });
  }

  const animations: Animation[] = [];
  const slide = (target: HTMLElement, from: DOMRect) => {
    const to = target.getBoundingClientRect();
    const dx = from.left - to.left;
    // A neighbour that grew into the space is revealed rather than stretched.
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

  // The closing tab narrows toward its left edge as it fades, the reverse of
  // how a new tab opens.
  const own = el.animate(
    [
      { clipPath: FULL, transform: "none", opacity: 1 },
      {
        clipPath: "inset(-8px calc(100% + 8px) -8px -8px)",
        transform: "translateX(-0.857rem)",
        opacity: 0,
      },
    ],
    { duration: ms, easing: EASE_IN, fill: "forwards" }
  );
  animations.push(own);

  // Styles stay until the tab has actually been removed (see `tabClosed`):
  // undoing them earlier would put the tab back in the row for a frame.
  cleanups.set(id, restore);
  return Promise.allSettled(animations.map((a) => a.finished)).then(() => undefined);
}

/** Call once the tab has been removed (or the close abandoned). */
export function tabClosed(id: number) {
  closing.delete(id);
  const undo = cleanups.get(id);
  cleanups.delete(id);
  // After the removal has painted, drop the temporary styles on what remains.
  if (undo) requestAnimationFrame(() => undo.reverse().forEach((f) => f()));
  if (closing.size === 0) document.documentElement.classList.remove("tab-closing");
}
