import { describe, expect, it } from "vitest";
import { shotListCsv } from "./shotList";
import type { FileEntry } from "../types";

const clip = (name: string): FileEntry => ({
  name, path: `/v/${name}`, isDir: false, isHidden: false, isSymlink: false, isPackage: false,
  size: 1024, modifiedMs: Date.UTC(2026, 9, 28), createdMs: 0, ext: "mov",
});

describe("shotListCsv", () => {
  it("writes one row per clip, blank where nothing is known, and quotes commas", () => {
    const media = { durationS: 90.4, width: 1920, height: 1080, fps: 23.976, codec: "Apple ProRes 422, Linear PCM", camera: null };
    const csv = shotListCsv([clip("A001.mov"), clip("still.mov")], [media, null]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("name,path,duration,duration_seconds,width,height,fps,codec,camera,size_bytes,size,modified,tags");
    expect(lines[1]).toBe('A001.mov,/v/A001.mov,1:30,90.4,1920,1080,23.98,"Apple ProRes 422, Linear PCM",,1024,1 KB,2026-10-28T00:00:00.000Z,');
    expect(lines[2]).toBe("still.mov,/v/still.mov,,,,,,,,1024,1 KB,2026-10-28T00:00:00.000Z,");
  });
});
