import { describe, expect, it } from "vitest";
import { defaultOf, appCommand, terminalList } from "./terminals";

const app = (name: string) => ({ name, path: `/Applications/${name}.app` });

describe("appCommand", () => {
  const editors = [app("Visual Studio Code"), app("Zed"), app("Warp")];
  it("finds the editor and its path", () => {
    expect(appCommand("code .", editors)).toEqual({ app: editors[0], arg: "." });
    expect(appCommand(" zed ../src ", editors)).toEqual({ app: editors[1], arg: "../src" });
    expect(appCommand("Warp .", editors)).toEqual({ app: editors[2], arg: "." });
  });
  it("leaves anything else to the terminal", () => {
    for (const c of ["code", "code -n .", "code . && ls", "code ~/x", "code 'a b'", "cursor .", "ls ."]) {
      expect(appCommand(c, editors)).toBeNull();
    }
  });
});

describe("terminalList", () => {
  it("drops a code editor that was added as a terminal", () => {
    const code = app("Visual Studio Code");
    const list = terminalList([app("Terminal")], [code.path], [code]);
    expect(list).toEqual([app("Terminal")]);
    // A saved choice that points at the editor falls back to the first terminal.
    expect(defaultOf(list, code.path)).toEqual(app("Terminal"));
  });
});
