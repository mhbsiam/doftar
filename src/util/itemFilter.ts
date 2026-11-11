import { extsOfKind, fileKind, isFolder, type FileKind } from "./kinds";
import type { FileEntry } from "../types";

export type KindGroup = "image" | "video" | "audio" | "document" | "code" | "archive";
export type DateRange = "today" | "week" | "month" | "year";

export interface ItemFilter {
  kind: KindGroup | null;
  modified: DateRange | null;
}

export const KIND_GROUPS: [KindGroup, string][] = [
  ["image", "Images"],
  ["video", "Videos"],
  ["audio", "Music and audio"],
  ["document", "Documents"],
  ["code", "Code"],
  ["archive", "Archives"],
];

export const DATE_RANGES: [DateRange, string][] = [
  ["today", "Today"],
  ["week", "Last 7 days"],
  ["month", "Last 30 days"],
  ["year", "This year"],
];

const DOCUMENT_KINDS = new Set<FileKind>(["pdf", "doc", "sheet", "slides", "text"]);

const DAY_MS = 24 * 60 * 60 * 1000;

function since(range: DateRange, now: Date): number {
  switch (range) {
    case "today":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    case "week":
      return now.getTime() - 7 * DAY_MS;
    case "month":
      return now.getTime() - 30 * DAY_MS;
    case "year":
      return new Date(now.getFullYear(), 0, 1).getTime();
  }
}

export function itemFilterActive(f: ItemFilter | null | undefined): f is ItemFilter {
  return !!f && (f.kind !== null || f.modified !== null);
}

export function matchesItemFilter(e: FileEntry, f: ItemFilter, now: Date): boolean {
  if (f.modified !== null && e.modifiedMs < since(f.modified, now)) return false;
  if (f.kind === null) return true;
  // A kind is a kind of file. Folders never match.
  if (isFolder(e)) return false;
  const k = fileKind(e.ext.toLowerCase());
  return f.kind === "document" ? DOCUMENT_KINDS.has(k) : k === f.kind;
}

/** The filter in the form a subfolder search takes. It applies it before capping the results. */
export function searchOnly(f: ItemFilter, now: Date): { exts: string[] | null; modifiedSince: number | null } {
  const kinds: FileKind[] = f.kind === "document" ? [...DOCUMENT_KINDS] : f.kind ? [f.kind] : [];
  return {
    exts: f.kind ? kinds.flatMap(extsOfKind) : null,
    modifiedSince: f.modified ? since(f.modified, now) : null,
  };
}

/** Changed in the last day. Marked in the file views. */
export function isFresh(modifiedMs: number, now: number): boolean {
  return now - modifiedMs < DAY_MS && modifiedMs <= now;
}

/**
 * A name pattern as people type it: `*` is any run, `?` is one character, commas separate alternatives.
 * A pattern with no wildcard matches names that contain it. Letter case is ignored.
 */
export function nameMatcher(pattern: string): ((name: string) => boolean) | null {
  const parts = pattern.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const tests = parts.map((p) => {
    if (!/[*?]/.test(p)) {
      const needle = p.toLowerCase();
      return (name: string) => name.toLowerCase().includes(needle);
    }
    const body = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    const re = new RegExp(`^${body}$`, "i");
    return (name: string) => re.test(name);
  });
  return (name) => tests.some((t) => t(name));
}
