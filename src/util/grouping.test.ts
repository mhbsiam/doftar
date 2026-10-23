import { describe, expect, it, vi } from "vitest";
import { dateBucket } from "./grouping";

// A zone with daylight saving, set before any date is made. In 2026 New York
// springs forward on Sunday 8 March and falls back on Sunday 1 November.
vi.stubEnv("TZ", "America/New_York");

const at = (m: number, d: number, h = 0, min = 0) => new Date(2026, m, d, h, min).getTime();
const TODAY = 0;
const YESTERDAY = 1;
const THIS_WEEK = 2;
const LAST_WEEK = 3;
const THIS_MONTH = 4;

describe("dateBucket", () => {
  it("runs in a zone that changes its clocks", () => {
    expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(240);
    expect(new Date(2026, 11, 1).getTimezoneOffset()).toBe(300);
  });

  it("counts a 25-hour yesterday from its midnight", () => {
    // Monday 2 November; Sunday was an hour longer.
    const now = new Date(2026, 10, 2, 10);
    expect(dateBucket(at(10, 2, 0, 5), now)).toBe(TODAY);
    expect(dateBucket(at(10, 1, 0, 30), now)).toBe(YESTERDAY);
    expect(dateBucket(at(10, 1, 23, 59), now)).toBe(YESTERDAY);
    expect(dateBucket(at(9, 31, 23, 30), now)).toBe(LAST_WEEK);
  });

  it("counts a 23-hour yesterday from its midnight", () => {
    // Monday 9 March; Sunday was an hour shorter.
    const now = new Date(2026, 2, 9, 10);
    expect(dateBucket(at(2, 8, 0, 30), now)).toBe(YESTERDAY);
    expect(dateBucket(at(2, 7, 23, 30), now)).toBe(LAST_WEEK);
  });

  it("starts the week on the Sunday it began, across a clock change", () => {
    // Wednesday 4 November; the week began on the long Sunday.
    const now = new Date(2026, 10, 4, 9);
    expect(dateBucket(at(10, 2, 12), now)).toBe(THIS_WEEK);
    expect(dateBucket(at(10, 1, 0, 30), now)).toBe(THIS_WEEK);
    expect(dateBucket(at(9, 31, 23, 30), now)).toBe(LAST_WEEK);
    expect(dateBucket(at(9, 25, 0, 30), now)).toBe(LAST_WEEK);
    expect(dateBucket(at(9, 24, 23, 30), now)).toBe(5);
  });

  it("puts the rest of the month and year in their buckets", () => {
    const now = new Date(2026, 6, 30, 12);
    expect(dateBucket(at(6, 2), now)).toBe(THIS_MONTH);
    expect(dateBucket(at(5, 2), now)).toBe(5);
    expect(dateBucket(at(0, 1), now)).toBe(6);
    expect(dateBucket(new Date(2025, 11, 31, 23).getTime(), now)).toBe(7);
  });
});
