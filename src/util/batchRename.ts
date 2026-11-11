import { validateName } from "./names";
import { formatFps } from "./format";
import type { MediaInfo, Step } from "../types";

export type RenameRule =
  | { mode: "replace"; find: string; replace: string; matchCase: boolean; regex?: boolean }
  | { mode: "add"; text: string; where: "before" | "after" }
  /** `base` may use {n}, {name}, {date}, {folder}, {camera}, {res} and {fps}. Without any, it becomes base_N. */
  | { mode: "number"; base: string; start: number }
  | { mode: "case"; to: "lower" | "upper" | "title" };

export interface RenameItem {
  name: string;
  folder: boolean;
  /** The folder that holds the item. Names clash only within one folder. */
  dir: string;
  /** For {date}. Today if missing. */
  modifiedMs?: number;
  /** For {camera}, {res} and {fps}. Each is empty if missing. */
  media?: MediaInfo | null;
}

/** "a.tar.gz" keeps ".tar.gz" whole, as copies do (`split_ext` in fsops.rs). */
function splitName(name: string, folder: boolean): [string, string] {
  let dot = name.lastIndexOf(".");
  if (folder || dot <= 0) return [name, ""];
  if (dot > 4 && name.slice(dot - 4, dot).toLowerCase() === ".tar") dot -= 4;
  return [name.slice(0, dot), name.slice(dot)];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The pattern a replace rule looks for. Null if a regular expression does not parse. */
function findPattern(rule: Extract<RenameRule, { mode: "replace" }>): RegExp | null {
  try {
    return new RegExp(rule.regex ? rule.find : escapeRegExp(rule.find), rule.matchCase ? "g" : "gi");
  } catch {
    return null;
  }
}

const TOKEN = /\{(n|name|date|folder|camera|res|fps)\}/g;

const ymd = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** `count` is the batch size. {n} pads every number to the widest one. */
export function renamed(item: RenameItem, rule: RenameRule, index: number, count = 1): string {
  const [stem, ext] = splitName(item.name, item.folder);
  switch (rule.mode) {
    case "replace": {
      const re = rule.find ? findPattern(rule) : null;
      if (!re) return item.name;
      // Literal text replaces literally. A regular expression may use $1.
      return (rule.regex ? stem.replace(re, rule.replace) : stem.replace(re, () => rule.replace)) + ext;
    }
    case "add":
      return (rule.where === "before" ? rule.text + stem : stem + rule.text) + ext;
    case "number": {
      const n = rule.start + index;
      const base = rule.base.trim();
      if (!base.match(TOKEN)) return `${base}_${n}${ext}`;
      const width = String(rule.start + Math.max(count, 1) - 1).length;
      const values: Record<string, string> = {
        n: String(n).padStart(width, "0"),
        name: stem,
        date: ymd(item.modifiedMs ?? Date.now()),
        folder: item.dir.split("/").filter(Boolean).pop() ?? "",
        camera: item.media?.camera ?? "",
        res: item.media?.width && item.media.height ? `${item.media.width}x${item.media.height}` : "",
        fps: item.media?.fps ? formatFps(item.media.fps) : "",
      };
      return base.replace(TOKEN, (_, t: string) => values[t]) + ext;
    }
    case "case":
      return (
        (rule.to === "lower"
          ? stem.toLowerCase()
          : rule.to === "upper"
            ? stem.toUpperCase()
            : stem.toLowerCase().replace(/(^|[\s_\-.(\[])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase())) +
        ext
      );
  }
}

export interface RenamePlan {
  names: string[];
  changed: number;
  /** Why the batch cannot run. Null if it can. */
  problem: string | null;
}

/**
 * The new names for `items` under `rule`, checked against each other and against `taken(dir)`.
 * `taken(dir)` is every name already in that folder.
 * Names match without regard to case, because Mac disks usually ignore it.
 */
export function planRename(
  items: RenameItem[],
  rule: RenameRule,
  taken: (dir: string) => Set<string>
): RenamePlan {
  const names = items.map((it, i) => renamed(it, rule, i, items.length));
  const plan = (problem: string | null): RenamePlan => ({
    names,
    changed: names.filter((n, i) => n !== items[i].name).length,
    problem,
  });
  if (rule.mode === "number" && !rule.base.trim()) return plan("Type a name");
  if (rule.mode === "replace" && rule.find && !findPattern(rule)) return plan("That pattern isn't a valid regular expression");
  const oldByDir = new Map<string, Set<string>>();
  // Names that selected items give up. Another selected item may take one, as in a swap.
  const freed = new Set<string>();
  for (const [i, it] of items.entries()) {
    const set = oldByDir.get(it.dir) ?? new Set<string>();
    set.add(it.name.toLowerCase());
    oldByDir.set(it.dir, set);
    if (names[i].toLowerCase() !== it.name.toLowerCase()) freed.add(`${it.dir}\0${it.name.toLowerCase()}`);
  }
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const name = names[i];
    const key = `${it.dir}\0${name.toLowerCase()}`;
    if (seen.has(key)) return plan(`Two items would both be named “${name}”`);
    seen.add(key);
    if (name === it.name) continue;
    const invalid = validateName(name);
    if (invalid) return plan(`“${it.name}”: ${invalid}`);
    const lower = name.toLowerCase();
    const there = taken(it.dir);
    // Only a change of case may reuse the name of the item itself,
    // unless a case-sensitive disk holds another item with that exact name.
    if (lower === it.name.toLowerCase()) {
      if (there.has(name)) return plan(`An item named “${name}” already exists`);
      continue;
    }
    if (oldByDir.get(it.dir)?.has(lower)) {
      if (freed.has(`${it.dir}\0${lower}`)) continue;
      return plan(`“${name}” is the current name of another selected item`);
    }
    if ([...there].some((n) => n.toLowerCase() === lower)) return plan(`An item named “${name}” already exists`);
  }
  return plan(null);
}

export interface RenameJob {
  /** Shown in errors. */
  name: string;
  from: string;
  to: string;
}

const dirPrefix = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

/**
 * Renames `jobs` with `rename`, which returns the step that undoes it. An item whose name another
 * item takes (a swap, or A→B with B→C) first steps aside under a hidden name. If its final rename
 * fails, it goes back to its old name. `steps` undo the batch when applied in order.
 */
export async function runRenames(
  jobs: RenameJob[],
  rename: (from: string, to: string) => Promise<Step>,
  tag: string
): Promise<{ steps: Step[]; moved: Map<string, string>; errors: string[] }> {
  const steps: Step[] = [];
  const moved = new Map<string, string>();
  const errors: string[] = [];
  const attempt = async (from: string, to: string, name: string, report = true) => {
    try {
      steps.push(await rename(from, to));
      return true;
    } catch (err) {
      if (report) errors.push(`${name}: ${String(err)}`);
      return false;
    }
  };
  const at = new Map(jobs.map((j) => [j.from, j.from]));
  for (const [i, j] of jobs.entries()) {
    if (!jobs.some((k) => k !== j && k.to.toLowerCase() === j.from.toLowerCase())) continue;
    const aside = `${dirPrefix(j.from)}.doftar-rename-${tag}-${i}`;
    if (await attempt(j.from, aside, j.name)) at.set(j.from, aside);
  }
  for (const j of jobs) {
    const now = at.get(j.from)!;
    if (await attempt(now, j.to, j.name)) moved.set(j.from, j.to);
    else if (now !== j.from && !(await attempt(now, j.from, j.name, false))) {
      errors.push(`${j.name} is now the hidden item “${now.slice(dirPrefix(now).length)}” in its folder`);
    }
  }
  // Undo applies steps in order, so the last rename must be undone first.
  return { steps: steps.reverse(), moved, errors };
}
