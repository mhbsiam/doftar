import { describe, expect, it } from "vitest";
import { isFresh, matchesItemFilter, nameMatcher } from "./itemFilter";
import type { FileEntry } from "../types";

const now = new Date(2026, 9, 25, 15, 0);
const DAY = 24 * 60 * 60 * 1000;

function entry(name: string, modifiedMs: number, isDir = false): FileEntry {
  return {
    name,
    path: `/x/${name}`,
    isDir,
    isHidden: false,
    isSymlink: false,
    isPackage: false,
    size: 0,
    modifiedMs,
    createdMs: 0,
    ext: isDir ? "" : (name.split(".").pop() ?? ""),
  };
}

describe("matchesItemFilter", () => {
  it("matches kinds, with documents spanning PDFs, office files and text", () => {
    const f = { kind: "document" as const, modified: null };
    expect(matchesItemFilter(entry("a.pdf", 0), f, now)).toBe(true);
    expect(matchesItemFilter(entry("a.XLSX", 0), f, now)).toBe(true);
    expect(matchesItemFilter(entry("a.png", 0), f, now)).toBe(false);
    expect(matchesItemFilter(entry("a.png", 0), { kind: "image", modified: null }, now)).toBe(true);
  });

  it("leaves folders out of a kind but not out of a date range", () => {
    const dir = entry("Photos", now.getTime() - DAY, true);
    expect(matchesItemFilter(dir, { kind: "image", modified: null }, now)).toBe(false);
    expect(matchesItemFilter(dir, { kind: null, modified: "week" }, now)).toBe(true);
  });

  it("counts today from local midnight and the year from 1 January", () => {
    const today = { kind: null, modified: "today" as const };
    expect(matchesItemFilter(entry("a", new Date(2026, 9, 25, 0, 1).getTime()), today, now)).toBe(true);
    expect(matchesItemFilter(entry("a", new Date(2026, 9, 24, 23, 59).getTime()), today, now)).toBe(false);
    const year = { kind: null, modified: "year" as const };
    expect(matchesItemFilter(entry("a", new Date(2026, 0, 1).getTime()), year, now)).toBe(true);
    expect(matchesItemFilter(entry("a", new Date(2025, 11, 31).getTime()), year, now)).toBe(false);
  });

  it("combines kind and date", () => {
    const f = { kind: "image" as const, modified: "month" as const };
    expect(matchesItemFilter(entry("a.jpg", now.getTime() - 3 * DAY), f, now)).toBe(true);
    expect(matchesItemFilter(entry("a.jpg", now.getTime() - 40 * DAY), f, now)).toBe(false);
  });
});

describe("isFresh", () => {
  it("is true only within the last day, never for future times", () => {
    const t = now.getTime();
    expect(isFresh(t - DAY + 1000, t)).toBe(true);
    expect(isFresh(t - DAY - 1000, t)).toBe(false);
    expect(isFresh(t + 60_000, t)).toBe(false);
  });
});

describe("nameMatcher", () => {
  it("matches wildcards against the whole name, ignoring case", () => {
    const m = nameMatcher("*.CSV, report-??")!;
    expect(m("a.csv")).toBe(true);
    expect(m("report-01")).toBe(true);
    expect(m("report-001")).toBe(false);
    expect(m("a.csv.bak")).toBe(false);
  });
  it("treats a pattern with no wildcard as text the name contains", () => {
    expect(nameMatcher("draft")!("My Draft (2).txt")).toBe(true);
  });
  it("takes regex characters literally", () => {
    const m = nameMatcher("a+b(1).*")!;
    expect(m("a+b(1).txt")).toBe(true);
    expect(m("aab1.txt")).toBe(false);
  });
  it("is null for an empty pattern", () => {
    expect(nameMatcher(" , ")).toBeNull();
  });
});
