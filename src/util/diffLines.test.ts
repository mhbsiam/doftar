import { describe, expect, it } from "vitest";
import { diffLines, splitLines } from "./diffLines";

const pic = (a: string, b: string) =>
  diffLines(splitLines(a), splitLines(b)).rows.map((r) =>
    r.kind === "same" ? ` ${r.left!.text}` : `${r.left ? "-" + r.left.text : " "}|${r.right ? "+" + r.right.text : " "}`
  );

describe("diffLines", () => {
  it("keeps identical files as one same row per line", () => {
    expect(pic("a\nb\n", "a\nb\n")).toEqual([" a", " b"]);
  });
  it("pairs a changed line, and lists extra lines on one side", () => {
    expect(pic("a\nb\nc", "a\nB\nc\nd")).toEqual([" a", "-b|+B", " c", " |+d"]);
  });
  it("numbers lines by their own file", () => {
    const { rows } = diffLines(["x", "y"], ["y"]);
    expect(rows).toEqual([
      { kind: "change", left: { n: 1, text: "x" }, right: null },
      { kind: "same", left: { n: 2, text: "y" }, right: { n: 1, text: "y" } },
    ]);
  });
  it("handles an empty side", () => {
    expect(pic("", "a")).toEqual([" |+a"]);
    expect(diffLines([], [])).toEqual({ rows: [], exact: true });
  });
  it("finds the minimal edit on a long shifted file", () => {
    const a = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const b = ["new", ...a.slice(0, 250), ...a.slice(251)];
    const { rows, exact } = diffLines(a, b);
    expect(exact).toBe(true);
    expect(rows.filter((r) => r.kind === "change")).toHaveLength(2);
  });
  it("stays exact with changes scattered between shared lines", () => {
    const a = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
    const b = a.map((l, i) => (i % 10 === 5 ? `${l} edited` : l));
    const { rows, exact } = diffLines(a, b);
    expect(exact).toBe(true);
    expect(rows).toHaveLength(2000);
    expect(rows.filter((r) => r.kind === "change")).toHaveLength(200);
  });
  it("shows files too different to align as one change between their shared ends", () => {
    const a = ["top", ...Array.from({ length: 5000 }, (_, i) => `a${i}`), "end"];
    const b = ["top", ...Array.from({ length: 5000 }, (_, i) => `b${i}`), "end"];
    const { rows, exact } = diffLines(a, b);
    expect(exact).toBe(false);
    expect(rows).toHaveLength(5002);
    expect(rows[0].kind).toBe("same");
    expect(rows[1]).toEqual({ kind: "change", left: { n: 2, text: "a0" }, right: { n: 2, text: "b0" } });
    expect(rows[5001]).toEqual({ kind: "same", left: { n: 5002, text: "end" }, right: { n: 5002, text: "end" } });
  });
});
