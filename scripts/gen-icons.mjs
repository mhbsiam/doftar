// Regenerates every bundle icon in src-tauri/icons from
// assets/doftar-icon-fullbleed.svg.
//
// The SVG is full-bleed (artwork fills the whole 1024 canvas, clipped to a
// squircle). macOS 26+ masks app icons itself and wraps any icon that does
// not fill the mask in a default rounded plate, so the source must not leave
// transparent margins around the artwork.
//
// Requires rsvg-convert (brew install librsvg).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "assets", "doftar-icon-fullbleed.svg");
const outDir = join(root, "src-tauri", "icons");
mkdirSync(outDir, { recursive: true });

try {
  execFileSync("rsvg-convert", ["--version"], { stdio: "ignore" });
} catch {
  console.error("rsvg-convert not found. Install it with: brew install librsvg");
  process.exit(1);
}

const cache = new Map();
function png(size) {
  if (!cache.has(size)) {
    cache.set(
      size,
      execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), source], {
        maxBuffer: 64 * 1024 * 1024,
      })
    );
  }
  return cache.get(size);
}

// Tauri desktop icons.
const pngs = {
  "32x32.png": 32,
  "64x64.png": 64,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "icon.png": 512,
};
for (const [name, size] of Object.entries(pngs)) {
  writeFileSync(join(outDir, name), png(size));
}

// macOS .icns, built by Apple's iconutil (ships with macOS) so each size gets
// the entry type Finder expects: Apple stores 16 and 32 px as ARGB, and
// Finder's list view garbles those sizes when they hold PNG data.
const iconsetSizes = {
  "icon_16x16.png": 16,
  "icon_16x16@2x.png": 32,
  "icon_32x32.png": 32,
  "icon_32x32@2x.png": 64,
  "icon_128x128.png": 128,
  "icon_128x128@2x.png": 256,
  "icon_256x256.png": 256,
  "icon_256x256@2x.png": 512,
  "icon_512x512.png": 512,
  "icon_512x512@2x.png": 1024,
};
const scratch = mkdtempSync(join(tmpdir(), "doftar-icons-"));
try {
  const iconset = join(scratch, "icon.iconset");
  mkdirSync(iconset);
  for (const [name, size] of Object.entries(iconsetSizes)) {
    writeFileSync(join(iconset, name), png(size));
  }
  execFileSync("iconutil", ["-c", "icns", "-o", join(outDir, "icon.icns"), iconset]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("icons written to", outDir);
