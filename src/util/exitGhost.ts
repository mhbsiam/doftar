import { useLayoutEffect, useRef } from "react";
import { EASE_IN, dur } from "./motion";

/**
 * Menus and dialogs leave the way things leave elsewhere: a copy of each is
 * left where it stood and accelerates away while the real one is already
 * gone, so focus, keys and clicks go back to the window at once. The copy is
 * inert and animated by opacity and transform alone.
 */

export type ExitKind = "menu" | "dialog";

/** Younger than this, a removal is React Strict Mode probing, not a close. */
const MIN_LIFE_MS = 80;
/** Past its animation by this long, a copy that never finished is removed. */
const GRACE_MS = 400;

const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function ghostOf(root: Element): HTMLElement {
  const ghost = root.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
  ghost.setAttribute("aria-hidden", "true");
  ghost.toggleAttribute("inert", true);
  ghost.classList.add("exit-ghost");
  return ghost;
}

/** Leaves a copy of each of `roots` that animates out and removes itself. */
export function leave(roots: (Element | null | undefined)[], kind: ExitKind) {
  if (reducedMotion()) return;
  const ms = kind === "menu" ? dur("fast") : dur("base");
  const timing: KeyframeAnimationOptions = {
    duration: ms,
    easing: EASE_IN,
    fill: "forwards",
  };
  for (const root of roots) {
    if (!root || !root.isConnected || !root.parentNode) continue;
    const ghost = ghostOf(root);
    // Beside the original, so it inherits the same fonts and colours.
    root.parentNode.appendChild(ghost);
    const gone = () => ghost.remove();
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], timing).finished.then(gone, gone);
    setTimeout(gone, ms + GRACE_MS);
    if (kind === "menu") {
      // The blurred surface only fades; the short slide runs on the list inside.
      ghost.firstElementChild?.animate(
        [{ transform: "none" }, { transform: "translateY(-0.214rem)" }],
        timing
      );
    } else {
      ghost.querySelector(".dialog")?.animate(
        [
          { transform: "none" },
          { transform: "translateY(0.429rem) scale(0.98)" },
        ],
        timing
      );
    }
  }
}

/**
 * Calls `leave` for the elements `roots` returns when the calling component
 * unmounts. `roots` runs while they are still attached.
 */
export function useExitGhost(
  roots: () => (Element | null | undefined)[],
  kind: ExitKind
) {
  const latest = useRef(roots);
  latest.current = roots;
  useLayoutEffect(() => {
    const born = performance.now();
    return () => {
      if (performance.now() - born < MIN_LIFE_MS) return;
      leave(latest.current(), kind);
    };
  }, [kind]);
}
