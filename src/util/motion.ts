import { invoke } from "@tauri-apps/api/core";

/** The shared easing, same as `--ease-out` in global.css. */
export const EASE = "cubic-bezier(0.25, 1, 0.5, 1)";

/** For things leaving: accelerates away, same as `--ease-in` in global.css. */
export const EASE_IN = "cubic-bezier(0.55, 0, 1, 0.45)";

/**
 * For large things arriving or settling into place (tabs, rows moving a
 * distance), same as `--ease-spring` in global.css: a damped spring that
 * overshoots about 2.5%. Short slides, leaving and fading keep `EASE`. Falls
 * back to `EASE` where `linear()` easing is missing.
 */
export const SPRING = CSS.supports("transition-timing-function", "linear(0, 1)")
  ? "linear(0, 0.031, 0.107, 0.21, 0.324, 0.439, 0.549, 0.648, 0.734, 0.807, 0.867, 0.915, 0.952, 0.979, 0.998, 1.012, 1.02, 1.024, 1.025, 1.025, 1.023, 1.021, 1.018, 1.015, 1.012, 1.009, 1.007, 1.005, 1.004, 1.002, 1.001, 1.001, 1)"
  : EASE;

const TOKENS = {
  fast: "--dur-fast",
  base: "--dur",
  slow: "--dur-slow",
  pageOut: "--dur-page-out",
  pageIn: "--dur-page-in",
  long: "--dur-long",
} as const;

const FALLBACK_MS: Record<keyof typeof TOKENS, number> = {
  fast: 120,
  base: 220,
  slow: 340,
  pageOut: 180,
  pageIn: 420,
  long: 560,
};

/**
 * A duration from the motion scale in global.css, in milliseconds, so
 * animations driven from TypeScript follow the same tokens as the CSS ones.
 */
export function dur(token: keyof typeof TOKENS): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(TOKENS[token]).trim();
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return FALLBACK_MS[token];
  return raw.endsWith("ms") ? n : raw.endsWith("s") ? n * 1000 : FALLBACK_MS[token];
}

/**
 * Slows every animation down by the factor in `DOFTAR_SLOW_MOTION`, for
 * tuning motion by eye; the Rust side scales the window animations to match.
 * Does nothing unless that is set.
 */
export async function applyMotionScale() {
  const scale = await invoke<number>("motion_scale").catch(() => 1);
  if (!(scale > 1)) return;
  const root = getComputedStyle(document.documentElement);
  const tokens = [...Object.values(TOKENS), "--dur-page-delay", "--dur-loop"];
  const scaled = tokens.map((t) => {
    const raw = root.getPropertyValue(t).trim();
    const ms = raw.endsWith("ms") ? parseFloat(raw) : parseFloat(raw) * 1000;
    return `${t}: ${ms * scale}ms;`;
  });
  const style = document.createElement("style");
  style.textContent = `:root { ${scaled.join(" ")} }`;
  document.head.appendChild(style);
}
