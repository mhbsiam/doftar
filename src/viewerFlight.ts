import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./ipc";
import type { Rect } from "./types";
import { iconOf, itemRect, liftItem } from "./util/itemRect";

const win = getCurrentWindow();
/** Time limit in ms if the backend never ends the flight. */
const HOLD_MAX_MS = 1500;

let release: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

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
 * Open `path` in a viewer with `open`. `open` gets the icon rect and returns true if something
 * flies from there. The icon is then hidden.
 */
async function openFromListing(path: string, open: (from: Rect | null) => Promise<boolean>) {
  const from = itemRect(path);
  const flying = await open(from);
  // Hide the icon only now. Until the thumbnail covers it, the icon shows.
  if (flying && from) hold(path);
}

export function openImageFromListing(path: string, order: string[] | null) {
  return openFromListing(path, (from) => api.openImageViewer(path, order, from));
}

export function openPdfFromListing(path: string) {
  return openFromListing(path, (from) => api.openPdf(path, from));
}

/** Nothing flies. The video window zooms from the icon. */
export function openVideoFromListing(path: string, order: string[] | null = null) {
  return openFromListing(path, (from) => api.openVideo(path, from, order).then(() => false));
}

/** Text and Markdown files have no thumbnail, so their icon flies. */
export function openReaderFromListing(path: string) {
  return openFromListing(path, (from) => api.openReader(path, from, from && iconSvg(path)));
}

/** Returns the icon of `path` as a standalone SVG document. null if it is a thumbnail or off screen. */
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

export function startViewerFlight() {
  void win.listen("viewer:flown", drop);
  void win.listen("viewer:returned", drop);
  void win.listen<{ id: number; path: string }>("viewer:where", ({ payload }) => {
    const rect = itemRect(payload.path);
    if (rect) hold(payload.path);
    void api.viewerReturnRect(payload.id, rect).catch(() => drop());
  });
}
