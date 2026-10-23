import type React from "react";
import { flushSync } from "react-dom";
import { focusPane, paneStore, portableTab, usePanes, useTabs } from "./stores/tabs";
import { moveTabToNewWindow, releaseMovedTab } from "./actions";
import { dropTabAt, endTabHover, slotAt, trackTabHover } from "./tabTransfer";
import { SPRING, dur } from "./util/motion";

/** How far the pointer travels before a press becomes a drag. */
const THRESHOLD = 5;
/** How far past the tab strip a tab is pulled before it comes loose. */
const TEAR = 40;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Drags tab `id` along the strip to reorder it, or out of the strip to move it
 * into a new window, like a browser. Call from the tab's pointerdown.
 */
export function beginTabDrag(e: React.PointerEvent<HTMLElement>, id: number) {
  if (e.button !== 0 || (e.target as HTMLElement).closest(".tab-close")) return;
  const el = e.currentTarget;
  const list = el.parentElement;
  const bar = el.closest(".titlebar");
  if (!list || !bar) return;
  const startX = e.clientX;
  const startY = e.clientY;
  const pointerId = e.pointerId;

  let dragging = false;
  let detached = false;
  let els: HTMLElement[] = [];
  let lefts: number[] = [];
  let widths: number[] = [];
  let from = -1;
  let target = -1;
  let step = 0;
  let listRect = list.getBoundingClientRect();
  let barRect = bar.getBoundingClientRect();
  let ghost: HTMLElement | null = null;

  const begin = () => {
    dragging = true;
    els = Array.from(list.children) as HTMLElement[];
    from = target = els.indexOf(el);
    const rects = els.map((x) => x.getBoundingClientRect());
    lefts = rects.map((r) => r.left);
    widths = rects.map((r) => r.width);
    // Siblings make room by the dragged tab's width plus the gap between tabs.
    const gap = rects.length > 1 ? rects[1].left - rects[0].right : 0;
    step = widths[from] + gap;
    listRect = list.getBoundingClientRect();
    barRect = bar.getBoundingClientRect();
    try {
      el.setPointerCapture(pointerId);
    } catch {
    }
    list.classList.add("tab-dragging");
    el.classList.add("tab-lifted");
  };

  const shiftSiblings = (to: number) => {
    els.forEach((x, i) => {
      if (i === from) return;
      let s = 0;
      if (from < to && i > from && i <= to) s = -step;
      else if (from > to && i < from && i >= to) s = step;
      x.style.transform = s ? `translateX(${s}px)` : "";
    });
  };

  const showGhost = (x: number, y: number) => {
    if (!ghost) {
      ghost = el.cloneNode(true) as HTMLElement;
      ghost.classList.add("tab-ghost", "active");
      ghost.classList.remove("tab-lifted");
      ghost.removeAttribute("data-drop");
      ghost.style.transform = "";
      ghost.style.width = `${widths[from]}px`;
      document.body.appendChild(ghost);
    }
    ghost.style.left = `${x - (startX - lefts[from])}px`;
    ghost.style.top = `${y - (startY - barRect.top) + 4}px`;
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    const dx = ev.clientX - startX;
    if (!dragging) {
      if (Math.hypot(dx, ev.clientY - startY) < THRESHOLD) return;
      begin();
    }
    // Even a window's only tab can come loose: it may be dropped into another window.
    // Pulling it sideways past this pane's strip frees it for the other half.
    const loose =
      ev.clientY > barRect.bottom + TEAR ||
      ev.clientY < barRect.top - TEAR ||
      ev.clientX < barRect.left - TEAR ||
      ev.clientX > barRect.right + TEAR;
    if (loose !== detached) {
      detached = loose;
      el.classList.toggle("tab-detached", loose);
      if (!loose) {
        ghost?.remove();
        ghost = null;
        endTabHover();
      }
    }
    if (detached) {
      el.style.transform = "";
      target = from;
      shiftSiblings(from);
      showGhost(ev.clientX, ev.clientY);
      trackTabHover(ev.screenX, ev.screenY);
      return;
    }
    const min = listRect.left - lefts[from];
    const max = listRect.right - (lefts[from] + widths[from]);
    const x = Math.max(min, Math.min(max, dx));
    el.style.transform = `translateX(${x}px)`;
    const center = lefts[from] + x + widths[from] / 2;
    target = els.reduce(
      (n, _, i) => (i !== from && lefts[i] + widths[i] / 2 < center ? n + 1 : n),
      0
    );
    shiftSiblings(target);
  };

  const finish = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    if (!dragging) return;
    endTabHover();
    ghost?.remove();
    list.classList.remove("tab-dragging");
    el.classList.remove("tab-lifted", "tab-detached");
    if (detached && ev.type === "pointerup") {
      els.forEach((x) => (x.style.transform = ""));
      const source = useTabs.getState();
      const tab = source.tabs.find((t) => t.id === id);
      if (!tab) return;
      // Dropped on the other half's strip: the tab moves across.
      const slot = slotAt({ x: ev.clientX, y: ev.clientY });
      if (slot && slot.pane !== source.pane) {
        paneStore(slot.pane).getState().insertTab(portableTab(tab), slot.index);
        focusPane(slot.pane);
        paneStore(source.pane).getState().closeTab(id);
        return;
      }
      // Put a new window's tab under the pointer, where it was grabbed.
      const grabX = listRect.left + (startX - lefts[from]);
      const at = { x: ev.screenX - grabX, y: ev.screenY - startY };
      void dropTabAt(portableTab(tab), ev.screenX, ev.screenY).then((taken) => {
        if (taken) releaseMovedTab(id);
        // A lone tab dropped nowhere just stays where it was.
        else if (source.tabs.length > 1 || usePanes.getState().split) void moveTabToNewWindow(id, at);
      });
      return;
    }
    const before = el.getBoundingClientRect().left;
    els.forEach((x) => (x.style.transform = ""));
    if (target !== from && ev.type === "pointerup") {
      flushSync(() => useTabs.getState().moveTab(id, target));
    }
    const delta = before - el.getBoundingClientRect().left;
    if (Math.abs(delta) > 0.5 && !reducedMotion()) {
      el.animate([{ transform: `translateX(${delta}px)` }, { transform: "none" }], {
        duration: dur("slow"),
        easing: SPRING,
      });
    }
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
}
