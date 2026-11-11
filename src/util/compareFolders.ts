import type { FileEntry } from "../types";

/** Clocks on network drives and FAT disks round modification times. */
const SLACK_MS = 2000;

/**
 * The items of `a` that `b` lacks (names match without regard to case), or files newer than the file of `b`.
 * Folders on both sides count as the same. Their contents are not compared.
 */
export function missingOrNewer(a: FileEntry[], b: FileEntry[]): string[] {
  const other = new Map(b.map((e) => [e.name.toLowerCase(), e]));
  return a
    .filter((e) => {
      const twin = other.get(e.name.toLowerCase());
      if (!twin) return true;
      return !e.isDir && !twin.isDir && e.modifiedMs > twin.modifiedMs + SLACK_MS;
    })
    .map((e) => e.path);
}
