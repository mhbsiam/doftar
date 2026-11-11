import { useLayoutEffect, useRef } from "react";
import { EASE_IN, dur } from "./motion";

/**
 * Menus and dialogs leave with a copy. The copy stays where the original was and accelerates away.
 * The real one is gone at once, so focus, keys and clicks return to the window.
 * The copy is inert and animates only opacity and transform.
 */

export type ExitKind = "menu" | "dialog";

/** A removal younger than this is React Strict Mode probing, not a close. */
const MIN_LIFE_MS = 80;
/** Remove a copy that is still there this long after its animation. */
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
    // Put it beside the original, so it inherits the same fonts and colors.
    root.parentNode.appendChild(ghost);
    const gone = () => ghost.remove();
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], timing).finished.then(gone, gone);
    setTimeout(gone, ms + GRACE_MS);
    if (kind === "menu") {
      // Shrinks back toward the transform-origin copied from the open menu.
      ghost.animate([{ transform: "none" }, { transform: "scale(0.96)" }], timing);
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
 * Calls `leave` for the elements `roots` returns when the component unmounts.
 * `roots` runs while they are still attached.
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
