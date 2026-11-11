import { useLayoutEffect, useRef } from "react";
import { SPRING, dur } from "../util/motion";
import { TAG_COLORS, tagDots } from "../util/tags";
import type { Tag } from "../types";

export function TagDot({ color }: { color: number }) {
  return (
    <span
      className={`tag-dot${color > 0 ? "" : " none"}`}
      style={color > 0 ? { background: TAG_COLORS[color] } : undefined}
      aria-hidden
    />
  );
}

export function TagDots({ tags }: { tags: Tag[] | undefined }) {
  const colors = tagDots(tags);
  const box = useRef<HTMLSpanElement>(null);
  const seen = useRef<number[] | null>(null);
  // A dot for a newly added tag grows in. Dots on first mount, such as after scrolling, just show.
  useLayoutEffect(() => {
    const was = seen.current;
    seen.current = colors;
    if (!was || !box.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    box.current.querySelectorAll(".tag-dot").forEach((el, i) => {
      if (was.includes(colors[i])) return;
      el.animate([{ transform: "scale(0)" }, { transform: "none" }], { duration: dur("slow"), easing: SPRING });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colors.join()]);
  if (colors.length === 0) return null;
  const names = (tags ?? []).map((t) => t.name).join(", ");
  return (
    <span ref={box} className="tag-dots" title={names} role="img" aria-label={`Tags: ${names}`}>
      {colors.map((c) => (
        <span key={c} className="tag-dot" style={{ background: TAG_COLORS[c] }} />
      ))}
    </span>
  );
}
