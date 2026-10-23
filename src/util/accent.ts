import type { BrandVariants } from "@fluentui/react-components";
import { folderStops, type FolderColorId } from "./folderColors";

/**
 * The accent follows the default folder color, so selection, links and
 * buttons belong to the same palette as the files. Each shade keeps the
 * folder's hue and saturation and picks the lightness that holds WCAG AA
 * contrast for that hue, since yellow and green read lighter than blue or
 * purple at the same lightness.
 */

type Hsl = [h: number, s: number, l: number];

function hexToHsl(hex: string): Hsl {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex([h, s, l]: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0"))
      .join("")
  );
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The lightest (or, with `lighten` false, darkest) shade that keeps `ratio` against `against`. */
function shadeFor(h: number, s: number, against: string, ratio: number, lighten: boolean): number {
  let best = lighten ? 0.05 : 0.95;
  for (let i = 5; i <= 95; i++) {
    const l = (lighten ? i : 100 - i) / 100;
    if (contrast(hslToHex([h, s, l]), against) >= ratio) best = l;
    else break;
  }
  return best;
}

export interface Accent {
  /** CSS custom properties, set on the root over global.css's defaults. */
  vars: Record<string, string>;
  /** A Fluent brand ramp in the same hue, for Fluent's own brand colors. */
  ramp: BrandVariants;
}

// Light: against the window's grey, so links stay readable on every surface.
const LIGHT_GROUND = "#ececec";
// Dark: against the file area, the lightest surface accent text sits on.
const DARK_GROUND = "#30343f";

const cache = new Map<string, Accent>();

export function accentFor(id: FolderColorId, mode: "light" | "dark"): Accent {
  const key = `${id}:${mode}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const [h, s0] = hexToHsl(folderStops(id)[1]);
  // The folder tints are soft; a deeper accent needs a little more color.
  const s = Math.min(0.6, s0 * 1.8);
  const at = (l: number) => hslToHex([h, s, Math.min(0.97, Math.max(0.03, l))]);

  let vars: Record<string, string>;
  if (mode === "light") {
    const l = shadeFor(h, s, LIGHT_GROUND, 4.6, true);
    vars = {
      "--accent": at(l),
      "--brand": at(l),
      "--accent-hover": at(l - 0.04),
      "--accent-btn": at(l),
      "--accent-btn-hover": at(l + 0.03),
      "--accent-btn-active": at(l + 0.06),
      "--on-accent": "#ffffff",
    };
  } else {
    const l = shadeFor(h, s, DARK_GROUND, 6, false);
    vars = {
      "--accent": at(l),
      "--brand": at(l),
      "--accent-hover": at(l + 0.08),
      "--accent-btn": at(l),
      "--accent-btn-hover": at(l - 0.04),
      "--accent-btn-active": at(l - 0.08),
      "--on-accent": "#000000",
    };
  }

  const steps = [6, 10, 14, 17, 20, 23, 26, 30, 35, 41, 48, 56, 62, 72, 82, 91];
  const ramp = Object.fromEntries(
    steps.map((l, i) => [(i + 1) * 10, at(l / 100)])
  ) as unknown as BrandVariants;
  // Pin the shades Fluent leans on to the accent itself.
  if (mode === "light") ramp[80] = vars["--accent"];
  else ramp[130] = vars["--accent"];

  const accent = { vars, ramp };
  cache.set(key, accent);
  return accent;
}
