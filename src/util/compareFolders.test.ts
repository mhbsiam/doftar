import { describe, expect, it } from "vitest";
import { missingOrNewer } from "./compareFolders";
import type { FileEntry } from "../types";

const e = (dir: string, name: string, modifiedMs = 0, isDir = false) =>
  ({ name, path: `${dir}/${name}`, isDir, modifiedMs }) as FileEntry;

describe("missingOrNewer", () => {
  it("picks what the other side lacks or holds an older copy of", () => {
    const left = [e("/l", "a.txt", 10_000), e("/l", "B.txt", 10_000), e("/l", "c.txt", 10_000), e("/l", "Sub", 0, true)];
    const right = [e("/r", "a.txt", 10_000), e("/r", "b.txt", 1_000), e("/r", "c.txt", 9_000), e("/r", "sub", 99_999, true)];
    // c.txt is within the clock slack. Folders on both sides are not compared.
    expect(missingOrNewer(left, right)).toEqual(["/l/B.txt"]);
    expect(missingOrNewer(right, left)).toEqual([]);
    expect(missingOrNewer([e("/l", "new.md")], right)).toEqual(["/l/new.md"]);
  });
});
