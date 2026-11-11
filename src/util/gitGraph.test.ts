import { describe, expect, it } from "vitest";
import { layoutGraph } from "./gitGraph";

describe("layoutGraph", () => {
  it("keeps a straight history in one lane", () => {
    const rows = layoutGraph([
      { id: "c", parents: ["b"] },
      { id: "b", parents: ["a"] },
      { id: "a", parents: [] },
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.width)).toEqual([1, 1, 1]);
    expect(rows[2].out).toEqual([]);
  });

  it("opens a lane for a merged branch and closes it at the fork", () => {
    const rows = layoutGraph([
      { id: "m", parents: ["b", "c"] },
      { id: "b", parents: ["a"] },
      { id: "c", parents: ["a"] },
      { id: "a", parents: [] },
    ]);
    expect(rows[0]).toMatchObject({ lane: 0, out: [0, 1], through: [] });
    expect(rows[1]).toMatchObject({ lane: 0, into: [0], out: [0], through: [{ from: 1, to: 1 }] });
    // c joins a's lane, so lane 1 ends here.
    expect(rows[2]).toMatchObject({ lane: 1, into: [1], out: [0], through: [{ from: 0, to: 0 }] });
    expect(rows[3]).toMatchObject({ lane: 0, into: [0], width: 1 });
  });

  it("starts a new lane for a second branch tip", () => {
    const rows = layoutGraph([
      { id: "x", parents: ["a"] },
      { id: "y", parents: ["a"] },
      { id: "a", parents: [] },
    ]);
    // y opens lane 1 and folds straight back into a's lane.
    expect(rows[1]).toMatchObject({ lane: 1, out: [0], width: 2 });
    expect(rows[2]).toMatchObject({ lane: 0, into: [0], width: 1 });
  });
});
