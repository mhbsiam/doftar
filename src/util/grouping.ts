import { isFolder, typeLabel } from "./kinds";
import { compareTags } from "./tags";
import type { FileEntry, GroupBy, SortKey } from "../types";
import type { Group } from "./layout";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortEntries(list: FileEntry[], sortKey: SortKey, sortAsc: boolean): FileEntry[] {
  const dir = sortAsc ? 1 : -1;
  const arr = [...list];
  arr.sort((a, b) => {
    const fa = isFolder(a);
    if (fa !== isFolder(b)) return fa ? -1 : 1;
    let c = 0;
    switch (sortKey) {
      case "name":
        c = collator.compare(a.name, b.name);
        break;
      case "modified":
        c = a.modifiedMs - b.modifiedMs;
        break;
      case "created":
        c = a.createdMs - b.createdMs;
        break;
      case "size":
        c = a.size - b.size;
        break;
      case "type":
        c = collator.compare(a.ext || "", b.ext || "");
        break;
    }
    if (c === 0 && sortKey !== "name") {
      c = collator.compare(a.name, b.name);
    }
    return c * dir;
  });
  return arr;
}

const DATE_LABELS = [
  "Today",
  "Yesterday",
  "Earlier this week",
  "Last week",
  "Earlier this month",
  "Last month",
  "Earlier this year",
  "A long time ago",
];

/**
 * The `DATE_LABELS` entry that time `ms` falls under, seen from `now`.
 * Day boundaries are local midnights counted by calendar date, because a day with a clock change is not 24 hours.
 */
export function dateBucket(ms: number, now: Date): number {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const midnight = (dayOfMonth: number) => new Date(y, m, dayOfMonth).getTime();
  const weekStart = d - now.getDay();
  if (ms >= midnight(d)) return 0;
  if (ms >= midnight(d - 1)) return 1;
  if (ms >= midnight(weekStart)) return 2;
  if (ms >= midnight(weekStart - 7)) return 3;
  if (ms >= midnight(1)) return 4;
  if (ms >= new Date(y, m - 1, 1).getTime()) return 5;
  if (ms >= new Date(y, 0, 1).getTime()) return 6;
  return 7;
}

function nameKey(name: string): string {
  const first = name.normalize("NFD").replace(/[̀-ͯ]/g, "").charAt(0).toUpperCase();
  return /[\p{L}]/u.test(first) ? first : "#";
}

interface Keyed {
  key: string;
  label: string;
  rank: number;
}

/**
 * Reorders sorted entries so each group is contiguous. Order inside a group stays.
 * Returns the group boundaries.
 */
export function groupEntries(
  sorted: FileEntry[],
  by: GroupBy,
  sortKey: SortKey,
  sortAsc: boolean
): { entries: FileEntry[]; groups: Group[] | null } {
  if (by === "none" || sorted.length === 0) return { entries: sorted, groups: null };

  const keyed = new Map<string, Keyed>();
  const keyOf = (e: FileEntry): Keyed => {
    let key: string;
    let label: string;
    let rank = 0;
    if (by === "name") {
      key = label = nameKey(e.name);
    } else if (by === "type") {
      key = label = typeLabel(e);
    } else if (by === "tags") {
      // An item with several tags goes under the tag that sorts first.
      const first = e.tags?.length ? [...e.tags].sort(compareTags)[0] : null;
      key = first ? first.name.toLowerCase() : "";
      label = first ? first.name : "No tags";
    } else {
      rank = dateBucket(e.createdMs, now);
      key = String(rank);
      label = DATE_LABELS[rank];
    }
    let k = keyed.get(key);
    if (!k) {
      k = { key, label, rank };
      keyed.set(key, k);
    }
    return k;
  };
  const now = new Date();
  const tagged = sorted.map((e) => ({ e, k: keyOf(e) }));

  if (by === "tags") {
    const order = [...keyed.values()].sort((a, b) => {
      if ((a.key === "") !== (b.key === "")) return a.key === "" ? 1 : -1;
      return compareTags({ name: a.label, color: 0 }, { name: b.label, color: 0 });
    });
    order.forEach((k, i) => (k.rank = i));
  } else if (by !== "created") {
    const dir = (by === "name" ? sortKey === "name" : sortKey === "type") && !sortAsc ? -1 : 1;
    const order = [...keyed.values()].sort((a, b) => {
      if (by === "name" && (a.key === "#") !== (b.key === "#")) {
        return (a.key === "#" ? -1 : 1) * dir;
      }
      return collator.compare(a.label, b.label) * dir;
    });
    order.forEach((k, i) => (k.rank = i));
  }

  tagged.sort((a, b) => a.k.rank - b.k.rank);

  const entries: FileEntry[] = [];
  const groups: Group[] = [];
  for (const { e, k } of tagged) {
    const g = groups[groups.length - 1];
    if (g && g.key === k.key) g.count++;
    else groups.push({ key: k.key, label: k.label, start: entries.length, count: 1 });
    entries.push(e);
  }
  return { entries, groups };
}
