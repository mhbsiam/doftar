import { describe, expect, it } from "vitest";
import type { Step } from "../types";
import { planRename, renamed, runRenames, type RenameItem } from "./batchRename";

const file = (name: string, dir = "/d"): RenameItem => ({ name, folder: false, dir });
const none = () => new Set<string>();

describe("renamed", () => {
  it("replaces text in the name, not the extension", () => {
    const rule = { mode: "replace" as const, find: "jpg", replace: "x", matchCase: true };
    expect(renamed(file("jpg-trip.jpg"), rule, 0)).toBe("x-trip.jpg");
  });

  it("matches case only when asked, and treats the text literally", () => {
    const loose = { mode: "replace" as const, find: "IMG", replace: "Photo", matchCase: false };
    expect(renamed(file("img_1.png"), loose, 0)).toBe("Photo_1.png");
    const strict = { ...loose, matchCase: true };
    expect(renamed(file("img_1.png"), strict, 0)).toBe("img_1.png");
    const literal = { mode: "replace" as const, find: "(1)", replace: "$&", matchCase: true };
    expect(renamed(file("a (1).txt"), literal, 0)).toBe("a $&.txt");
  });

  it("adds text before or after, and numbers from the start", () => {
    expect(renamed(file("a.txt"), { mode: "add", text: "2026 ", where: "before" }, 0)).toBe("2026 a.txt");
    expect(renamed(file("a.txt"), { mode: "add", text: " old", where: "after" }, 0)).toBe("a old.txt");
    expect(renamed(file("x.png"), { mode: "number", base: "Trip", start: 1 }, 2)).toBe("Trip_3.png");
  });

  it("keeps a folder's dots and a dotfile's name whole", () => {
    const rule = { mode: "add" as const, text: "!", where: "after" as const };
    expect(renamed({ name: "v1.2", folder: true, dir: "/d" }, rule, 0)).toBe("v1.2!");
    expect(renamed(file(".zshrc"), rule, 0)).toBe(".zshrc!");
  });

  it("keeps a .tar.gz extension whole", () => {
    const rule = { mode: "add" as const, text: "-v2", where: "after" as const };
    expect(renamed(file("backup.tar.gz"), rule, 0)).toBe("backup-v2.tar.gz");
    expect(renamed(file("a.TAR.xz"), rule, 0)).toBe("a-v2.TAR.xz");
    expect(renamed(file(".tar.gz"), rule, 0)).toBe(".tar-v2.gz");
  });
});

describe("rename extras", () => {
  it("replaces with a regular expression and its groups", () => {
    const rule = { mode: "replace" as const, find: "^IMG_(\\d+)", replace: "Photo $1", matchCase: true, regex: true };
    expect(renamed(file("IMG_0042.jpg"), rule, 0)).toBe("Photo 0042.jpg");
    const bad = planRename([file("a.txt")], { ...rule, find: "(" }, none);
    expect(bad.problem).toMatch(/regular expression/);
  });

  it("changes letter case of the name only", () => {
    expect(renamed(file("My Trip.JPG"), { mode: "case", to: "lower" }, 0)).toBe("my trip.JPG");
    expect(renamed(file("my trip.jpg"), { mode: "case", to: "upper" }, 0)).toBe("MY TRIP.jpg");
    expect(renamed(file("mY trip_day-one.jpg"), { mode: "case", to: "title" }, 0)).toBe("My Trip_Day-One.jpg");
  });

  it("fills {n}, {name}, {date} and {folder}, padding numbers to the widest", () => {
    const item = { name: "a.png", folder: false, dir: "/x/Paris", modifiedMs: new Date(2026, 0, 5).getTime() };
    const rule = { mode: "number" as const, base: "{folder} {date} {n} {name}", start: 1 };
    expect(renamed(item, rule, 2, 12)).toBe("Paris 2026-01-05 03 a.png");
    expect(renamed(item, { mode: "number", base: "Trip", start: 1 }, 2, 12)).toBe("Trip_3.png");
  });
});

describe("renamed with media", () => {
  it("fills {camera}, {res} and {fps}, leaving them empty when unknown", () => {
    const media = { durationS: 10, width: 3840, height: 2160, fps: 29.97, codec: "H.264", camera: "Sony ILCE-7M4" };
    const rule = { mode: "number" as const, base: "{camera}_{res}_{fps}_{n}", start: 1 };
    expect(renamed({ ...file("C0042.MP4"), media }, rule, 0)).toBe("Sony ILCE-7M4_3840x2160_29.97_1.MP4");
    expect(renamed(file("C0043.MP4"), rule, 1)).toBe("___2.MP4");
  });
});

describe("planRename", () => {
  it("counts changes and passes a clean batch", () => {
    const p = planRename([file("a.txt"), file("b.txt")], { mode: "add", text: "x", where: "before" }, none);
    expect(p).toEqual({ names: ["xa.txt", "xb.txt"], changed: 2, problem: null });
  });

  it("refuses duplicates, names in use and invalid names", () => {
    const same = planRename([file("a.txt"), file("b.txt")], { mode: "replace", find: "b", replace: "a", matchCase: true }, none);
    expect(same.problem).toMatch(/both be named/);
    const exists = planRename([file("a.txt")], { mode: "add", text: "c", where: "before" }, () => new Set(["ca.txt"]));
    expect(exists.problem).toMatch(/already exists/);
    const bad = planRename([file("a.txt")], { mode: "add", text: "/", where: "before" }, none);
    expect(bad.problem).toMatch(/slash/);
    expect(planRename([file("a.txt")], { mode: "number", base: " ", start: 1 }, none).problem).toBe("Type a name");
  });

  it("lets selected items take each other's names", () => {
    const shift = planRename([file("a_1.txt"), file("a_2.txt")], { mode: "number", base: "a", start: 2 }, none);
    expect(shift).toMatchObject({ names: ["a_2.txt", "a_3.txt"], problem: null });
    const swap = planRename([file("a.txt"), file("b.txt")], { mode: "replace", find: "^(a|b)", replace: "x", matchCase: true, regex: true }, none);
    expect(swap.problem).toMatch(/both be named/);
  });

  it("allows a change of case and the same name in different folders", () => {
    const upper = planRename([file("a.txt")], { mode: "replace", find: "a", replace: "A", matchCase: true }, () => new Set(["a.txt"]));
    expect(upper.problem).toBe(null);
    // A case-sensitive disk can hold both names.
    const clash = planRename([file("a.txt")], { mode: "replace", find: "a", replace: "A", matchCase: true }, () => new Set(["a.txt", "A.txt"]));
    expect(clash.problem).toMatch(/already exists/);
    const apart = planRename([file("x.txt", "/1"), file("y.txt", "/2")], { mode: "number", base: "n", start: 1 }, none);
    expect(apart.problem).toBe(null);
  });
});

describe("runRenames", () => {
  // A folder as a map of path to content. A rename returns the step that undoes it, as rename_path does.
  const disk = (files: Record<string, string>, failTo?: string) => {
    const fs = new Map(Object.entries(files));
    const move = (from: string, to: string) => {
      if (!fs.has(from)) throw new Error(`no ${from}`);
      if (fs.has(to)) throw new Error(`${to} exists`);
      fs.set(to, fs.get(from)!);
      fs.delete(from);
    };
    const rename = async (from: string, to: string): Promise<Step> => {
      if (to === failTo) throw new Error("refused");
      move(from, to);
      return { kind: "move", from: to, to: from };
    };
    const undo = (steps: Step[]) => steps.forEach((s) => s.kind === "move" && move(s.from, s.to));
    return { fs, rename, undo };
  };

  it("swaps two names, and the steps undo it", async () => {
    const d = disk({ "/d/a": "A", "/d/b": "B" });
    const jobs = [
      { name: "a", from: "/d/a", to: "/d/b" },
      { name: "b", from: "/d/b", to: "/d/a" },
    ];
    const res = await runRenames(jobs, d.rename, "t");
    expect(res.errors).toEqual([]);
    expect(Object.fromEntries(d.fs)).toEqual({ "/d/a": "B", "/d/b": "A" });
    d.undo(res.steps);
    expect(Object.fromEntries(d.fs)).toEqual({ "/d/a": "A", "/d/b": "B" });
  });

  it("puts an item back under its old name when its final rename fails", async () => {
    // b steps aside, then b → c is refused: b must not stay hidden.
    const d = disk({ "/d/a": "A", "/d/b": "B" }, "/d/c");
    const jobs = [
      { name: "a", from: "/d/a", to: "/d/b" },
      { name: "b", from: "/d/b", to: "/d/c" },
    ];
    const res = await runRenames(jobs, d.rename, "t");
    // a could not take b's name back, so b's hidden name is reported.
    expect(res.errors).toEqual(["b: Error: refused", "b is now the hidden item “.doftar-rename-t-1” in its folder"]);
    d.undo(res.steps);
    expect(Object.fromEntries(d.fs)).toEqual({ "/d/a": "A", "/d/b": "B" });
  });
});
