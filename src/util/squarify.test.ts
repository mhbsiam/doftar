import { describe, expect, it } from "vitest";
import { squarify } from "./squarify";

const BOX = { x: 10, y: 20, w: 600, h: 400 };
const area = (r: { w: number; h: number }) => r.w * r.h;

describe("squarify", () => {
  it("gives each size an area in proportion, filling the box", () => {
    const sizes = [6, 6, 4, 3, 2, 2, 1];
    const rects = squarify(sizes, BOX);
    const total = sizes.reduce((a, b) => a + b, 0);
    rects.forEach((r, i) => {
      expect(area(r)).toBeCloseTo((sizes[i] / total) * area(BOX), 6);
    });
    expect(rects.reduce((n, r) => n + area(r), 0)).toBeCloseTo(area(BOX), 6);
  });

  it("keeps every block inside the box without overlaps", () => {
    const rects = squarify([50, 30, 10, 5, 3, 1, 1], BOX);
    const e = 1e-6;
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(BOX.x - e);
      expect(r.y).toBeGreaterThanOrEqual(BOX.y - e);
      expect(r.x + r.w).toBeLessThanOrEqual(BOX.x + BOX.w + e);
      expect(r.y + r.h).toBeLessThanOrEqual(BOX.y + BOX.h + e);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(ox <= e || oy <= e).toBe(true);
      }
    }
  });

  it("keeps blocks near square for the paper's example", () => {
    const rects = squarify([6, 6, 4, 3, 2, 2, 1], { x: 0, y: 0, w: 6, h: 4 });
    const worst = Math.max(...rects.map((r) => Math.max(r.w / r.h, r.h / r.w)));
    expect(worst).toBeLessThan(3);
  });

  it("draws nothing for an empty or zero-sized input", () => {
    expect(squarify([], BOX)).toEqual([]);
    expect(squarify([0, 0], BOX).every((r) => area(r) === 0)).toBe(true);
    expect(squarify([5], { ...BOX, w: 0 })[0].w).toBe(0);
  });
});
