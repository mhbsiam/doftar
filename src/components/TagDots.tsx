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

/** An item's coloured tags as overlapping dots, newest on top. */
export function TagDots({ tags }: { tags: Tag[] | undefined }) {
  const colors = tagDots(tags);
  if (colors.length === 0) return null;
  const names = (tags ?? []).map((t) => t.name).join(", ");
  return (
    <span className="tag-dots" title={names} role="img" aria-label={`Tags: ${names}`}>
      {colors.map((c) => (
        <span key={c} className="tag-dot" style={{ background: TAG_COLORS[c] }} />
      ))}
    </span>
  );
}
