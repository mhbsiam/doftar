import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { paneAt, paneStore, parentOf } from "../stores/tabs";
import { useUI } from "../stores/ui";
import { useDrag } from "../stores/drag";
import {
  clearDragEntries,
  dropOn,
  hoverTarget,
  resetHover,
  resolveAt,
  setDragEntries,
  type DropSpec,
} from "../drag";
import { api } from "../ipc";

export function useDragDrop() {
  useEffect(() => {
    let paths: string[] = [];
    const toCss = (p: { x: number; y: number }) => ({
      x: p.x / window.devicePixelRatio,
      y: p.y / window.devicePixelRatio,
    });
    // The folder open in the pane under the pointer.
    const folderSpec = (pane: number): DropSpec | null => {
      const tabs = paneStore(pane).getState();
      const active = tabs.tabs.find((t) => t.id === tabs.activeId);
      return active && active.location.kind === "path"
        ? { kind: "path", path: active.location.path }
        : null;
    };
    const end = () => {
      useUI.getState().setDragOver(null);
      useDrag.getState().end();
      resetHover();
      paths = [];
    };

    const promise = getCurrentWebview().onDragDropEvent((ev) => {
      const p = ev.payload;
      if (p.type === "leave") {
        end();
        clearDragEntries();
        return;
      }
      if (p.type === "enter") {
        paths = p.paths;
        // Drop targets such as Favorites need to know which paths are folders.
        void api.statEntries(paths).then((entries) => {
          if (paths === p.paths) setDragEntries(entries);
        });
      }
      const at = toCss(p.position);
      const target = resolveAt(at.x, at.y);
      const pane = paneAt(at.x, at.y);

      if (p.type === "drop") {
        const dropped = p.paths;
        end();
        const spec = target?.spec ?? folderSpec(pane);
        if (spec && dropped.length > 0) {
          const items =
            spec.kind === "path"
              ? dropped.filter((x) => parentOf(x) !== spec.path)
              : dropped;
          if (items.length > 0) dropOn(spec, items, true);
        }
        clearDragEntries();
        return;
      }

      const store = useDrag.getState();
      if (!store.active) store.start(paths, at.x, at.y, false);
      hoverTarget(target, paths, true);
      useUI.getState().setDragOver(!target && folderSpec(pane) !== null ? pane : null);
    });
    return () => {
      end();
      void promise.then((unlisten) => unlisten());
    };
  }, []);
}
