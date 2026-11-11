import { describe, expect, it } from "vitest";
import { commonPrefix, rankNames, splitDraft, tabComplete } from "./pathComplete";

describe("splitDraft", () => {
  it("resolves absolute, home and relative drafts", () => {
    expect(splitDraft("/Users/me/Doc", "/Users/me", "/x")).toEqual({ dir: "/Users/me", typedDir: "/Users/me/", prefix: "Doc" });
    expect(splitDraft("~/Doc", "/Users/me", "/x")).toEqual({ dir: "/Users/me", typedDir: "~/", prefix: "Doc" });
    expect(splitDraft("sub/a", "/h", "/x")).toEqual({ dir: "/x/sub", typedDir: "sub/", prefix: "a" });
    expect(splitDraft("/", "/h", "/x")).toEqual({ dir: "/", typedDir: "/", prefix: "" });
    expect(splitDraft("~", "/h", "/x")).toBeNull();
  });
});

describe("completion", () => {
  const names = ["Documents", "Downloads", "Desktop", "docs-old"];

  it("ranks prefix matches first", () => {
    expect(rankNames("do", names)).toEqual(["docs-old", "Documents", "Downloads", "Desktop"]);
    expect(rankNames("dsk", names)[0]).toBe("Desktop");
  });

  it("shares the common start", () => {
    expect(commonPrefix(["Documents", "docs-old"])).toBe("Doc");
    expect(commonPrefix([])).toBe("");
  });

  it("completes one match with a slash and several to their shared start", () => {
    const parts = { dir: "/h", typedDir: "~/", prefix: "Dow" };
    expect(tabComplete(parts, names)).toBe("~/Downloads/");
    expect(tabComplete({ ...parts, prefix: "d" }, ["Documents", "docs-old"])).toBe("~/Doc");
    expect(tabComplete({ ...parts, prefix: "Doc" }, ["Documents", "docs-old"])).toBeNull();
  });
});
