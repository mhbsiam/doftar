import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { DismissCircleRegular } from "@fluentui/react-icons";
import { useDrag } from "../stores/drag";
import { EntryIcon } from "./FileIcon";
import { baseName } from "../stores/tabs";
import { dragEntry } from "../drag";

export function DragGhost() {
  const active = useDrag((s) => s.active && s.ghost);
  const paths = useDrag((s) => s.paths);
  const label = useDrag((s) => s.label);
  const blocked = useDrag((s) => s.blocked);
  const copy = useDrag((s) => s.copy);
  const ref = useRef<HTMLDivElement | null>(null);
  const shown = active && paths.length > 0;

  // The ghost follows the pointer by a transform written straight to the
  // element at every move, so nothing re-renders between frames.
  useLayoutEffect(() => {
    if (!shown) return;
    const place = (x: number, y: number) => {
      if (ref.current) ref.current.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
    };
    const s = useDrag.getState();
    place(s.x, s.y);
    return useDrag.subscribe((next, prev) => {
      if (next.x !== prev.x || next.y !== prev.y) place(next.x, next.y);
    });
  }, [shown]);

  if (!shown) return null;

  const first = dragEntry(paths[0]);
  const name = baseName(paths[0]);
  return createPortal(
    <div ref={ref} className={`drag-ghost${blocked ? " blocked" : ""}`} aria-hidden>
      <div className="drag-chip">
        {first ? <EntryIcon entry={first} size={20} /> : null}
        <span className="drag-name">{name}</span>
        {paths.length > 1 && <span className="drag-count">{paths.length}</span>}
        {copy && !blocked && <span className="drag-plus">+</span>}
        {blocked && <DismissCircleRegular className="drag-no" />}
      </div>
      {label && <div className="drag-label">{label}</div>}
    </div>,
    document.body
  );
}
