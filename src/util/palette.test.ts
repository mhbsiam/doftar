import { describe, expect, it } from "vitest";
import { PALETTE_COMMANDS, keysOf, matchScore, visitBonus } from "./palette";

describe("matchScore", () => {
  it("needs every character, in order", () => {
    expect(matchScore("trash", "Move to Trash")).toBeGreaterThan(0);
    expect(matchScore("mtt", "Move to Trash")).toBeGreaterThan(0);
    expect(matchScore("hsart", "Move to Trash")).toBe(-1);
    expect(matchScore("", "anything")).toBe(0);
  });

  it("ranks word starts and runs above scattered letters", () => {
    expect(matchScore("new", "New tab")).toBeGreaterThan(matchScore("new", "Show or hide navigation pane"));
    expect(matchScore("split", "Split view")).toBeGreaterThan(matchScore("split", "Show or hide item check boxes"));
    expect(matchScore("down", "Downloads")).toBeGreaterThan(matchScore("down", "Open selection ⌘↓ down"));
  });
});

describe("PALETTE_COMMANDS", () => {
  it("uses each menu id once", () => {
    const ids = PALETTE_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("visitBonus", () => {
  const now = 1_000 * 24 * 3600 * 1000;
  it("grows with visits and stops at 12", () => {
    expect(visitBonus(8, now, now)).toBeGreaterThan(visitBonus(1, now, now));
    expect(visitBonus(10_000, now, now)).toBe(12);
  });
  it("halves for a folder not opened in a month, and counts a missing number as one visit", () => {
    const old = now - 31 * 24 * 3600 * 1000;
    expect(visitBonus(8, old, now)).toBe(visitBonus(8, now, now) / 2);
    expect(visitBonus(undefined, now, now)).toBe(visitBonus(1, now, now));
  });
});

describe("keysOf", () => {
  it("gives a menu the shortcut of the same command", () => {
    expect(keysOf("duplicate")).toBe("⌘D");
    expect(keysOf("compress")).toBeUndefined();
  });
});
