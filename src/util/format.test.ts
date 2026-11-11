import { describe, expect, it } from "vitest";
import { dateFormat, formatDate, formatSize, normalizePath, shortDate } from "./format";

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

describe("formatSize", () => {
  it("names each unit", () => {
    expect(formatSize(0)).toBe("0 bytes");
    expect(formatSize(NaN)).toBe("");
    expect(formatSize(-5)).toBe("");
    expect(formatSize(1)).toBe("1 byte");
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

describe("formatDate", () => {
  it("leaves out a timestamp past what a Date holds", () => {
    expect(formatDate(9e15)).toBe("");
    expect(formatDate(Date.UTC(2024, 0, 2))).not.toBe("");
  });

  it("follows the chosen date and clock style", () => {
    const ms = new Date(2024, 8, 5, 15, 7).getTime();
    const mon = new Date(ms).toLocaleDateString([], { month: "short" });
    const cases = [
      ["mdy", "09/05/2024"],
      ["dmy", "05/09/2024"],
      ["dMonY", `05/${mon}/2024`],
      ["monDY", `${mon} 5, 2024`],
    ] as const;
    for (const [date, out] of cases) {
      Object.assign(dateFormat, { date, clock: "12" });
      expect(formatDate(ms)).toBe(`${out} 3:07 PM`);
    }
    dateFormat.clock = "24";
    expect(formatDate(ms)).toBe(`${mon} 5, 2024 15:07`);
    expect(formatDate(new Date(2024, 0, 1, 0, 5).getTime())).toBe(`${new Date(2024, 0, 1).toLocaleDateString([], { month: "short" })} 1, 2024 00:05`);
    dateFormat.clock = "12";
    expect(formatDate(new Date(2024, 0, 1, 0, 5).getTime())).toMatch(/ 12:05 AM$/);
    Object.assign(dateFormat, { date: "mdy", clock: "12" });
  });

  it("shortDate drops this year and shows only the time today", () => {
    const now = new Date();
    expect(shortDate(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 30).getTime())).toBe("9:30 AM");
    expect(shortDate(new Date(2020, 1, 3).getTime())).toBe("02/03/2020");
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
