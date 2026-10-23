import type { FileEntry, Tag, TagFilter } from "../types";

/** Finder's label colours by number (0 is no colour). */
export const TAG_COLORS: Record<number, string> = {
  1: "#8e8e93",
  2: "#34c759",
  3: "#af52de",
  4: "#0a84ff",
  5: "#ffcc00",
  6: "#ff3b30",
  7: "#ff9500",
};

/** The colour tags, in Finder's menu order. */
export const COLOR_TAGS: Tag[] = [
  { name: "Red", color: 6 },
  { name: "Orange", color: 7 },
  { name: "Yellow", color: 5 },
  { name: "Green", color: 2 },
  { name: "Blue", color: 4 },
  { name: "Purple", color: 3 },
  { name: "Gray", color: 1 },
];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Finder compares tag names without regard to case. */
export const tagKey = (name: string) => name.toLowerCase();

export const isColorTag = (t: Tag) => COLOR_TAGS.some((c) => tagKey(c.name) === tagKey(t.name));

export function hasTag(e: FileEntry, name: string): boolean {
  const k = tagKey(name);
  return !!e.tags?.some((t) => tagKey(t.name) === k);
}

export function matchesTagFilter(e: FileEntry, f: TagFilter): boolean {
  if (f.any) return !!e.tags?.length;
  return f.names.some((n) => hasTag(e, n));
}

export function tagFilterActive(f: TagFilter | null | undefined): f is TagFilter {
  return !!f && (f.any || f.names.length > 0);
}

/** Colour tags first in menu order, then the rest by name. */
export function compareTags(a: Tag, b: Tag): number {
  const ia = COLOR_TAGS.findIndex((c) => tagKey(c.name) === tagKey(a.name));
  const ib = COLOR_TAGS.findIndex((c) => tagKey(c.name) === tagKey(b.name));
  if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  return collator.compare(a.name, b.name);
}

export function sameTags(a: Tag[] | undefined, b: Tag[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((t, i) => t.name === y[i].name && t.color === y[i].color);
}

/** The distinct tags on `entries`, with how many items carry each, in tag order. */
export function tagsIn(entries: FileEntry[]): { tag: Tag; count: number }[] {
  const seen = new Map<string, { tag: Tag; count: number }>();
  for (const e of entries) {
    for (const t of e.tags ?? []) {
      const k = tagKey(t.name);
      const s = seen.get(k);
      if (s) s.count++;
      else seen.set(k, { tag: t, count: 1 });
    }
  }
  return [...seen.values()].sort((a, b) => compareTags(a.tag, b.tag));
}

/** The colours to draw for an item: its coloured tags, newest last, at most `max`. */
export function tagDots(tags: Tag[] | undefined, max = 3): number[] {
  const colors: number[] = [];
  for (const t of tags ?? []) if (t.color > 0 && !colors.includes(t.color)) colors.push(t.color);
  return colors.slice(-max);
}

/** Whether every, some or none of `entries` carry the tag. */
export function tagState(entries: FileEntry[], name: string): "on" | "mixed" | "off" {
  const n = entries.filter((e) => hasTag(e, name)).length;
  return n === 0 ? "off" : n === entries.length ? "on" : "mixed";
}
