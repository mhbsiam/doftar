import { useEffect, useRef, type FocusEvent, type KeyboardEvent, type RefObject } from "react";

/**
 * Roving tabindex for a group of buttons (ARIA toolbar / tree pattern): the
 * group is one Tab stop, and the arrow keys, Home and End move between its
 * items. Items are re-scanned whenever buttons appear, disappear or change
 * their disabled state, so the Tab stop never lands on something unfocusable.
 */
export function useRovingFocus(
  ref: RefObject<HTMLElement>,
  opts: { selector: string; vertical?: boolean }
) {
  const { selector, vertical = false } = opts;
  const current = useRef<HTMLElement | null>(null);

  const items = () =>
    ref.current
      ? Array.from(ref.current.querySelectorAll<HTMLElement>(selector)).filter(
          (el) => !(el as HTMLButtonElement).disabled
        )
      : [];

  const sync = () => {
    const list = items();
    if (!current.current || !list.includes(current.current)) current.current = list[0] ?? null;
    for (const el of list) el.tabIndex = el === current.current ? 0 : -1;
  };

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selector]);

  // React bubbles events out of portals (Fluent menus, tooltips) through the
  // component tree, so only act on events that start inside the group's DOM.
  const inside = (e: { target: EventTarget }) =>
    !!ref.current?.contains(e.target as Node);

  const onFocus = (e: FocusEvent) => {
    if (!inside(e)) return;
    const target = e.target as HTMLElement;
    if (items().includes(target) && current.current !== target) {
      current.current = target;
      sync();
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!inside(e) || e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
    const next = vertical ? "ArrowDown" : "ArrowRight";
    const prev = vertical ? "ArrowUp" : "ArrowLeft";
    if (![next, prev, "Home", "End"].includes(e.key)) return;
    const list = items();
    if (list.length === 0) return;
    // Relative to the last focused item, so a secondary control inside a row
    // (focused by other means) still moves along the group.
    const at = Math.max(0, list.indexOf(current.current as HTMLElement));
    const to =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? list.length - 1
          : (at + (e.key === next ? 1 : -1) + list.length) % list.length;
    e.preventDefault();
    list[to].focus();
  };

  return { onFocus, onKeyDown };
}
