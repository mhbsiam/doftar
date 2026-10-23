import { useEffect } from "react";
import { prefetchListing } from "../stores/prefetch";
import { useTabs } from "../stores/tabs";

const HOVER_MS = 100;
const DROP_PATH = /\|path:(.+)$/;

/**
 * Prefetches a folder's listing once the pointer rests on something that opens
 * it: a sidebar item, breadcrumb, folder row or tile, or a Home tile. The
 * first few carry a `data-drop="…|path:<folder>"` attribute and Home tiles a
 * `data-prefetch="<folder>"`, so one listener covers them all.
 */
export function useHoverPrefetch() {
  useEffect(() => {
    let current: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const home = target?.closest<HTMLElement>("[data-prefetch]");
      const drop = home ? null : target?.closest<HTMLElement>("[data-drop]");
      const m = drop ? DROP_PATH.exec(drop.dataset.drop ?? "") : null;
      const path = home?.dataset.prefetch ?? (m ? m[1] : null);
      if (path === current) return;
      current = path;
      if (timer) clearTimeout(timer);
      timer = null;
      if (!path || document.body.classList.contains("dragging-files")) return;
      timer = setTimeout(() => {
        const tabs = useTabs.getState();
        const tab = tabs.tabs.find((t) => t.id === tabs.activeId);
        if (tab?.location.kind === "path" && tab.location.path === path) return;
        prefetchListing(path);
      }, HOVER_MS);
    };
    const onLeave = () => {
      current = null;
      if (timer) clearTimeout(timer);
      timer = null;
    };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseleave", onLeave);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseleave", onLeave);
      if (timer) clearTimeout(timer);
    };
  }, []);
}
