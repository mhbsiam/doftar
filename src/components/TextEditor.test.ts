import { describe, expect, it } from "vitest";
import { detectIndent, joinRun } from "./TextEditor";

describe("joinRun", () => {
  it("joins a call made during a run, then runs again", async () => {
    const slot = { current: null as Promise<boolean> | null };
    let runs = 0;
    const run = () => Promise.resolve(++runs > 0);
    const notStale = () => false;
    await Promise.all([joinRun(slot, run, notStale), joinRun(slot, run, notStale)]);
    expect(runs).toBe(1);
    await joinRun(slot, run, notStale);
    expect(runs).toBe(2);
  });

  it("runs again for a joined call when the run missed something", async () => {
    const slot = { current: null as Promise<boolean> | null };
    let runs = 0;
    const run = () => Promise.resolve(++runs > 0);
    const stale = () => runs < 2;
    await Promise.all([joinRun(slot, run, stale), joinRun(slot, run, stale)]);
    expect(runs).toBe(2);
  });

  it("does not run again by itself, or after a failed run", async () => {
    const slot = { current: null as Promise<boolean> | null };
    let runs = 0;
    await joinRun(slot, () => Promise.resolve(++runs > 0), () => true);
    expect(runs).toBe(1);
    const fail = () => Promise.resolve(++runs < 0);
    await Promise.all([joinRun(slot, fail, () => true), joinRun(slot, fail, () => true)]);
    expect(runs).toBe(2);
  });
});

describe("detectIndent", () => {
  it("follows the file's own indentation", () => {
    expect(detectIndent("def f():\n    if x:\n        y\n", "/a.py")).toBe("    ");
    expect(detectIndent("a:\n  b:\n    c\n", "/a.yaml")).toBe("  ");
    expect(detectIndent("{\n\tx\n\ty\n  z\n}\n", "/a.c")).toBe("\t");
  });
  it("falls back by kind of file", () => {
    expect(detectIndent("", "/x/Makefile")).toBe("\t");
    expect(detectIndent("", "/a.ts")).toBe("  ");
    expect(detectIndent("plain", "/notes.txt")).toBe("    ");
  });
});
