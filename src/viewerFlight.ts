import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./ipc";
import type { Rect } from "./types";
import { iconOf, itemRect, liftItem } from "./util/itemRect";

const win = getCurrentWindow();
/** How long an icon stays hidden if the backend never says its flight ended. */
const HOLD_MAX_MS = 1500;

let release: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Hides `path`'s icon while its thumbnail flies to or from the viewer. */
function hold(path: string) {
  drop();
  release = liftItem(path);
  timer = setTimeout(drop, HOLD_MAX_MS);
}

function drop() {
  clearTimeout(timer);
  release?.();
  release = null;
}

/**
 * Opens `path` in one of Doftar's viewers through `open`, which is given
 * where the listing draws its icon (when on screen) and says whether
 * something flies from there into the viewer; the icon is hidden under it
 * meanwhile.
 */
async function openFromListing(path: string, open: (from: Rect | null) => Promise<boolean>) {
  const from = itemRect(path);
  const flying = await open(from);
  // Hidden only now: until the thumbnail is up over it, the icon still shows.
  if (flying && from) hold(path);
}

/** Opens the image at `path` in the viewer, its thumbnail flying there. */
export function openImageFromListing(path: string, order: string[] | null) {
  return openFromListing(path, (from) => api.openImageViewer(path, order, from));
}

/** Opens the PDF at `path`, its thumbnail flying onto the first page. */
export function openPdfFromListing(path: string) {
  return openFromListing(path, (from) => api.openPdf(path, from));
}

/**
 * Opens the text or Markdown file at `path` in the reader, its icon flying
 * there: such files have no thumbnail, so the icon the listing draws goes.
 */
export function openReaderFromListing(path: string) {
  return openFromListing(path, (from) => api.openReader(path, from, from && iconSvg(path)));
}

/**
 * The icon the listing draws for `path`, as a standalone SVG document the
 * backend can draw, or null when it is a thumbnail or isn't on screen. The
 * icons are self-contained (their gradients are their own), so the markup
 * carries everything.
 */
function iconSvg(path: string): string | null {
  const icon = iconOf(path);
  if (!(icon instanceof SVGSVGElement)) return null;
  const copy = icon.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const r = icon.getBoundingClientRect();
  copy.setAttribute("width", String(Math.round(r.width * 2) || 64));
  copy.setAttribute("height", String(Math.round(r.height * 2) || 64));
  return new XMLSerializer().serializeToString(copy);
}

/** Answers a viewer: where a file it is closing goes back to. */
export function startViewerFlight() {
  void win.listen("viewer:flown", drop);
  void win.listen("viewer:returned", drop);
  void win.listen<{ id: number; path: string }>("viewer:where", ({ payload }) => {
    const rect = itemRect(payload.path);
    if (rect) hold(payload.path);
    void api.viewerReturnRect(payload.id, rect).catch(() => drop());
  });
}
