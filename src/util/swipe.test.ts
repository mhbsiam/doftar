import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { swipeTracker } from "./swipe";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("fires once per gesture, and again after a pause", () => {
  const seen: number[] = [];
  const swipes = swipeTracker((dir) => seen.push(dir));
  for (let i = 0; i < 10; i++) swipes.feed(-30);
  expect(seen).toEqual([-1]);
  vi.advanceTimersByTime(250);
  for (let i = 0; i < 10; i++) swipes.feed(30);
  expect(seen).toEqual([-1, 1]);
});

it("reports progress toward a swipe, then clears it", () => {
  const seen: number[] = [];
  const progress: number[] = [];
  const swipes = swipeTracker((dir) => seen.push(dir), { distance: 200, onProgress: (p) => progress.push(p) });
  swipes.feed(-100);
  swipes.feed(50);
  expect(progress).toEqual([-0.5, -0.25]);
  vi.advanceTimersByTime(250);
  expect(progress.at(-1)).toBe(0);
  for (let i = 0; i < 4; i++) swipes.feed(-60);
  expect(seen).toEqual([-1]);
  expect(progress.at(-1)).toBe(0);
});

it("ignores a short nudge", () => {
  const seen: number[] = [];
  const swipes = swipeTracker((dir) => seen.push(dir));
  swipes.feed(40);
  vi.advanceTimersByTime(250);
  swipes.feed(40);
  expect(seen).toEqual([]);
});
