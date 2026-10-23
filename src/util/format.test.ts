import { describe, expect, it } from "vitest";
import { formatSize, normalizePath } from "./format";

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

describe("formatSize", () => {
  it("names each unit", () => {
    expect(formatSize(0)).toBe("0 bytes");
    expect(formatSize(1023)).toBe("1023 bytes");
    expect(formatSize(1024)).toBe("1 KB");
    expect(formatSize(1025)).toBe("2 KB");
    expect(formatSize(5.25 * MB)).toBe("5.3 MB");
    expect(formatSize(300 * MB)).toBe("300 MB");
    expect(formatSize(2.5 * GB)).toBe("2.50 GB");
    expect(formatSize(3 * GB * 1024)).toBe("3.00 TB");
  });

  it("moves up a unit when rounding reaches 1024", () => {
    expect(formatSize(MB - 1)).toBe("1.0 MB");
    expect(formatSize(1023.4 * KB)).toBe("1.0 MB");
    expect(formatSize(1023 * KB)).toBe("1023 KB");
    expect(formatSize(1023.6 * MB)).toBe("1.00 GB");
    expect(formatSize(1023.4 * MB)).toBe("1023 MB");
    expect(formatSize(1023.97 * GB)).toBe("1.00 TB");
    expect(formatSize(1023.9 * GB)).toBe("1023.9 GB");
  });
});

describe("normalizePath", () => {
  it("resolves . and .. segments", () => {
    expect(normalizePath("/a/b/..")).toBe("/a");
    expect(normalizePath("/a/b/../c/./d")).toBe("/a/c/d");
    expect(normalizePath("/a/./b/.")).toBe("/a/b");
    expect(normalizePath("/a/b/../..")).toBe("/");
  });

  it("stays at the root when .. goes past it", () => {
    expect(normalizePath("/..")).toBe("/");
    expect(normalizePath("/../../a")).toBe("/a");
  });

  it("drops doubled and trailing slashes", () => {
    expect(normalizePath("/a//b///")).toBe("/a/b");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("//")).toBe("/");
  });

  it("keeps names that only start with dots", () => {
    expect(normalizePath("/a/.hidden/...")).toBe("/a/.hidden/...");
  });
});
