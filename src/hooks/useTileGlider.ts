import { useLayoutEffect, useRef, type RefObject } from "react";
import { itemDomId } from "./useListNav";
import { usePane } from "../stores/tabs";
import type { VirtualWindow } from "./useVirtual";

/** After a resize, the glider follows the tiles without easing for this long. */
const RESIZE_QUIET_MS = 150;

/**
 * Icons view selection fill: one block that glides between tiles when a single selection moves.
 * `.glider` does the same between rows in List view.
 * It uses the position of the selected tile, so it follows any grid wrap.
 * It appears in place when it has nothing to glide from.
 * It follows the tiles without easing during a resize.
 */
export function useTileGlider(
  listRef: RefObject<HTMLElement | null>,
  gliderRef: RefObject<HTMLElement | null>,
  index: number,
  win: VirtualWindow
) {
  const pane = usePane();
  const shown = useRef(false);
  const resizing = useRef(false);

  const place = useRef(() => {});
  place.current = () => {
    const glider = gliderRef.current;
    if (!glider) return;
    const tile = index >= 0 ? document.getElementById(itemDomId(index, pane)) : null;
    if (!tile || !(tile instanceof HTMLElement)) {
      glider.classList.remove("on");
      shown.current = false;
      return;
    }
    glider.classList.toggle("instant", !shown.current || resizing.current);
    glider.style.width = `${tile.offsetWidth}px`;
    glider.style.height = `${tile.offsetHeight}px`;
    glider.style.transform = `translate(${tile.offsetLeft}px, ${tile.offsetTop}px)`;
    glider.classList.add("on");
    shown.current = true;
  };

  useLayoutEffect(() => {
    place.current();
  }, [index, win.first, win.last, win.cols, win.layout]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let width = list.clientWidth;
    const observer = new ResizeObserver(() => {
      if (list.clientWidth === width) return;
      width = list.clientWidth;
      resizing.current = true;
      place.current();
      clearTimeout(timer);
      timer = setTimeout(() => {
        resizing.current = false;
      }, RESIZE_QUIET_MS);
    });
    observer.observe(list);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [listRef]);
}
