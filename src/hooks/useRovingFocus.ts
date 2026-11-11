import { useEffect, useRef, type FocusEvent, type KeyboardEvent, type RefObject } from "react";

/**
 * Roving tabindex for a group of buttons (ARIA toolbar or tree pattern).
 * The group is one Tab stop. Arrow keys, Home and End move between items.
 * The hook scans the items again when buttons appear, disappear or change their disabled state.
 * This way Tab never lands on an item that cannot take focus.
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

  // React bubbles events from portals (Fluent menus, tooltips) through the component tree.
  // Act only on events that start inside the DOM of the group.
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
    // Start from the last focused item, so a control inside a row still moves along the group.
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
