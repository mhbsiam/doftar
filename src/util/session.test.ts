import { describe, expect, it } from "vitest";
import { parseSession } from "./session";

describe("parseSession", () => {
  it("keeps well-formed tabs and clamps indexes", () => {
    const s = parseSession(
      JSON.stringify({
        panes: [
          [{ history: [{ kind: "home" }, { kind: "path", path: "/tmp" }], historyIndex: 9, selection: ["/tmp/a", 3], anchor: null }],
          [{ history: [{ kind: "home" }], historyIndex: 0 }],
        ],
        active: [0],
        split: true,
        frame: { x: 1, y: 2, width: 800, height: 600 },
      })
    );
    expect(s?.panes[0][0].historyIndex).toBe(1);
    expect(s?.panes[0][0].selection).toEqual(["/tmp/a"]);
    expect(s?.frame).toEqual({ x: 1, y: 2, width: 800, height: 600 });
    // A session saved in split view opens in one pane.
    expect(s?.panes).toHaveLength(1);
    expect(s).not.toHaveProperty("split");
  });

  it("drops malformed tabs and data", () => {
    expect(parseSession("not json")).toBeNull();
    expect(parseSession(null)).toBeNull();
    const s = parseSession(
      JSON.stringify({ panes: [[{ history: [{ kind: "path", path: "relative" }] }, { history: [] }, null]], frame: { x: "1" } })
    );
    expect(s?.panes[0]).toEqual([]);
    expect(s?.frame).toBeUndefined();
  });
});
