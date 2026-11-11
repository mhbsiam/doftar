import { matchScore } from "./palette";

export interface DraftParts {
  /** Absolute folder to list. */
  dir: string;
  /** The typed text up to and including the last slash, kept as typed (so "~/" stays "~/"). */
  typedDir: string;
  /** The partial name after the last slash. */
  prefix: string;
}

/** Split an address bar draft into the folder to list and the name being typed. */
export function splitDraft(draft: string, home: string, cwd: string): DraftParts | null {
  const slash = draft.lastIndexOf("/");
  const typedDir = draft.slice(0, slash + 1);
  const prefix = draft.slice(slash + 1);
  if (draft === "~" || prefix === "." || prefix === "..") return null;
  let dir: string;
  if (typedDir === "") dir = cwd;
  else if (typedDir.startsWith("~/")) dir = `${home}/${typedDir.slice(2)}`;
  else if (typedDir.startsWith("/")) dir = typedDir;
  else dir = `${cwd}/${typedDir}`;
  dir = dir.replace(/\/+$/, "") || "/";
  return { dir, typedDir, prefix };
}

/** Names that start with `prefix` first (A to Z), then fuzzy matches. */
export function rankNames(prefix: string, names: string[], limit = 8): string[] {
  const p = prefix.toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(p)).sort((a, b) => a.localeCompare(b));
  if (starts.length >= limit || !p) return starts.slice(0, limit);
  const rest = names
    .filter((n) => !n.toLowerCase().startsWith(p))
    .map((n) => ({ n, score: matchScore(prefix, n) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.n);
  return [...starts, ...rest].slice(0, limit);
}

/** Longest start shared by all names, ignoring case. Keeps the case of the first name. */
export function commonPrefix(names: string[]): string {
  if (names.length === 0) return "";
  let end = names[0].length;
  for (const n of names) {
    let i = 0;
    while (i < end && i < n.length && n[i].toLowerCase() === names[0][i].toLowerCase()) i++;
    end = i;
  }
  return names[0].slice(0, end);
}

/**
 * What Tab does: one match completes it with a trailing slash. Several extend the draft to their
 * shared start. Null when Tab adds nothing.
 */
export function tabComplete(parts: DraftParts, names: string[]): string | null {
  const p = parts.prefix.toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(p));
  if (starts.length === 1) return `${parts.typedDir}${starts[0]}/`;
  const shared = commonPrefix(starts);
  return shared.length > parts.prefix.length ? `${parts.typedDir}${shared}` : null;
}
