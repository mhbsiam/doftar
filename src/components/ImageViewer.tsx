import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowUndoRegular,
  ChevronLeftRegular,
  ChevronRightRegular,
  CropRegular,
  FlipHorizontalRegular,
  FlipVerticalRegular,
  ImageOffRegular,
  OpenRegular,
  RotateLeftRegular,
  RotateRightRegular,
  SaveCopyRegular,
  ZoomFitRegular,
  ZoomInRegular,
  ZoomOutRegular,
} from "@fluentui/react-icons";
import { api } from "../ipc";
import { useResolvedTheme } from "../hooks/useResolvedTheme";
import { useSettings, type ThemePref } from "../stores/settings";
import { applyTextScale } from "../util/textScale";
import { extOf, isEditableImage } from "../util/kinds";
import { dur } from "../util/motion";
import type { ImageEdit, PixelRect, ViewerOpen } from "../types";

const PREVIEW_APP = "/System/Applications/Preview.app";
/** WebKit can't decode these at all, so they go straight to a converted copy. */
const NEEDS_COPY = new Set(["dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"]);
const MAX_SCALE = 16;
const ZOOM_STEP = 1.25;
/** Horizontal scroll, in pixels, that a two-finger swipe needs to change image. */
const SWIPE_DISTANCE = 80;
/** A swipe ends once its scroll events (momentum included) stop for this long. */
const SWIPE_IDLE_MS = 200;
/** How long a turn or flip animates; matches `--dur-slow` plus a frame. */
/** A wheel pan is written to the picture at once and reaches React this long after the last tick. */
const PAN_SETTLE_MS = 120;
/** The smallest crop, in screen pixels. */
const MIN_CROP = 24;
/** Room kept round the image while cropping, in screen pixels. */
const CROP_INSET = 24;
const NOTICE_MS = 4000;

const win = getCurrentWindow();
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mod4 = (n: number) => ((n % 4) + 4) % 4;

/** `found` in the listing's order where it is known, then by name like Finder. */
function arrange(found: string[], order: string[] | null): string[] {
  const rank = new Map((order ?? []).map((p, i) => [p, i]));
  return [...found].sort((a, b) => {
    const ra = rank.get(a) ?? Infinity;
    const rb = rank.get(b) ?? Infinity;
    return ra !== rb ? ra - rb : collator.compare(nameOf(a), nameOf(b));
  });
}

/** A URL the webview can load for `path`: the file itself, or a converted copy. */
async function sourceFor(path: string, copy: boolean, rev = 0): Promise<string> {
  const src = convertFileSrc(copy ? await api.viewerImage(path) : path);
  // A saved edit replaces the file under the same name; this skips the cached one.
  return rev ? `${src}?v=${rev}` : src;
}

/** An image as last drawn, kept to fade out under the next one. */
interface Drawn {
  src: string;
  frame: CSSProperties;
  style: CSSProperties;
  cropped: boolean;
  pixelated: boolean;
}

interface Size {
  w: number;
  h: number;
}
/** `scale` is null while the image fits the window; `x`/`y` pan it from centre. */
interface View {
  scale: number | null;
  x: number;
  y: number;
}
const FIT: View = { scale: null, x: 0, y: 0 };

/**
 * Edits not yet saved: the image is turned `turns` quarter turns clockwise,
 * then scaled by `sx`/`sy` (a flip is -1), then cut down to `crop`, which is
 * in pixels of the turned and flipped image. Turns aren't wrapped to 0–3, so
 * turning past a full circle still animates the short way.
 */
interface Edits {
  turns: number;
  sx: 1 | -1;
  sy: 1 | -1;
  crop: PixelRect | null;
}
const NO_EDITS: Edits = { turns: 0, sx: 1, sy: 1, crop: null };

/** A turn or flip: how it changes the edits, and how it carries a crop along. */
type TransformArgs = [
  change: (e: Edits) => Partial<Edits>,
  move: (r: PixelRect, full: Size) => PixelRect,
];

/** The edits as the backend takes them: a turn, then maybe a mirror. */
function toImageEdit(e: Edits): ImageEdit {
  // A vertical flip is a mirror and a half turn; flipping both ways is a half turn.
  return { turns: mod4(e.turns + (e.sy < 0 ? 2 : 0)), mirror: e.sx !== e.sy, crop: e.crop };
}

function isEdited(e: Edits): boolean {
  const edit = toImageEdit(e);
  return edit.turns !== 0 || edit.mirror || edit.crop !== null;
}

/** `nat` as shown after `turns`. */
function turnedSize(nat: Size, turns: number): Size {
  return mod4(turns) % 2 ? { w: nat.h, h: nat.w } : nat;
}

/** `r`, in an image of size `full`, after a quarter turn of that image. */
function turnRect(r: PixelRect, full: Size, clockwise: boolean): PixelRect {
  return clockwise
    ? { x: full.h - r.y - r.h, y: r.x, w: r.h, h: r.w }
    : { x: r.y, y: full.w - r.x - r.w, w: r.h, h: r.w };
}

function flipRect(r: PixelRect, full: Size, axis: "h" | "v"): PixelRect {
  return axis === "h" ? { ...r, x: full.w - r.x - r.w } : { ...r, y: full.h - r.y - r.h };
}

/** Whole pixels inside `full`; the whole image means no crop at all. */
function settleCrop(r: PixelRect, full: Size): PixelRect | null {
  const x = clamp(Math.round(r.x), 0, full.w - 1);
  const y = clamp(Math.round(r.y), 0, full.h - 1);
  const w = clamp(Math.round(r.w), 1, full.w - x);
  const h = clamp(Math.round(r.h), 1, full.h - y);
  return w === full.w && h === full.h ? null : { x, y, w, h };
}

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Handle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** `start` dragged by `dx`/`dy` image pixels at `handle`, kept inside `full`. */
function dragCrop(
  start: PixelRect,
  handle: Handle,
  dx: number,
  dy: number,
  full: Size,
  ratio: number | null,
  min: number
): PixelRect {
  if (handle === "move") {
    return {
      ...start,
      x: clamp(start.x + dx, 0, full.w - start.w),
      y: clamp(start.y + dy, 0, full.h - start.h),
    };
  }
  const west = handle.includes("w");
  const north = handle.includes("n");
  if (ratio && handle.length === 2) {
    // The opposite corner stays put; the larger pull decides the size.
    const ax = west ? start.x + start.w : start.x;
    const ay = north ? start.y + start.h : start.y;
    const pw = start.w + (west ? -dx : dx);
    const ph = start.h + (north ? -dy : dy);
    const roomW = west ? ax : full.w - ax;
    const roomH = north ? ay : full.h - ay;
    const w = clamp(Math.max(pw, ph * ratio), Math.max(min, min * ratio), Math.min(roomW, roomH * ratio));
    const h = w / ratio;
    return { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
  }
  let l = start.x;
  let t = start.y;
  let r = start.x + start.w;
  let b = start.y + start.h;
  if (west) l = clamp(l + dx, 0, r - min);
  if (handle.includes("e")) r = clamp(r + dx, l + min, full.w);
  if (north) t = clamp(t + dy, 0, b - min);
  if (handle.includes("s")) b = clamp(b + dy, t + min, full.h);
  return { x: l, y: t, w: r - l, h: b - t };
}

const RATIOS: { id: string; label: string; ratio: number | "original" | null }[] = [
  { id: "free", label: "Freeform", ratio: null },
  { id: "original", label: "Original", ratio: "original" },
  { id: "1:1", label: "Square", ratio: 1 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "3:2", label: "3:2", ratio: 3 / 2 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
];

/** Keeps a zoomed image from being dragged further than its edges. */
function clampPan(box: Size, stage: Size, scale: number, x: number, y: number) {
  const mx = Math.max(0, (box.w * scale - stage.w) / 2);
  const my = Math.max(0, (box.h * scale - stage.h) / 2);
  return { x: clamp(x, -mx, mx), y: clamp(y, -my, my) };
}

function openInPreview(path: string | null) {
  if (path) void api.openWith([path], PREVIEW_APP).catch(console.error);
}

/**
 * The viewer window's page. The window is made hidden at launch and hidden
 * again on close, so an image opens without waiting for a webview to start.
 */
/** The frame's and picture's placement, as drawn, for animating a turn from. */
interface Geom {
  left: number;
  top: number;
  w: number;
  h: number;
  imgW: number;
  imgH: number;
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  turns: number;
}

/** `--ease-out` from global.css, as a function, for sampling keyframes. */
function easeOut(t: number): number {
  const [x1, y1, x2, y2] = [0.25, 1, 0.5, 1];
  const bx = (u: number) => 3 * x1 * u * (1 - u) ** 2 + 3 * x2 * u * u * (1 - u) + u ** 3;
  const by = (u: number) => 3 * y1 * u * (1 - u) ** 2 + 3 * y2 * u * u * (1 - u) + u ** 3;
  let lo = 0;
  let hi = 1;
  let u = t;
  for (let i = 0; i < 24; i++) {
    u = (lo + hi) / 2;
    if (bx(u) < t) lo = u;
    else hi = u;
  }
  return by(u);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Keyframes that swing the picture from how it was drawn to how it is drawn
 * now, with transforms only. The frame scales from its old box to the new
 * one about its top-left corner, and the picture inside counters that scale
 * exactly, so it turns and resizes undistorted while the crop box morphs.
 */
function turnKeyframes(from: Geom, to: Geom): { frame: Keyframe[]; img: Keyframe[] } {
  const steps = 30;
  const fx0 = from.w / to.w;
  const fy0 = from.h / to.h;
  const r0 = from.imgW / to.imgW;
  const c0 = { x: from.left + from.tx + from.imgW / 2, y: from.top + from.ty + from.imgH / 2 };
  const c1 = { x: to.left + to.tx + to.imgW / 2, y: to.top + to.ty + to.imgH / 2 };
  const frame: Keyframe[] = [];
  const img: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const offset = i / steps;
    const e = easeOut(offset);
    const left = lerp(from.left, to.left, e);
    const top = lerp(from.top, to.top, e);
    const fx = lerp(fx0, 1, e);
    const fy = lerp(fy0, 1, e);
    const r = lerp(r0, 1, e);
    const x = lerp(c0.x, c1.x, e) - left - (fx * to.imgW) / 2;
    const y = lerp(c0.y, c1.y, e) - top - (fy * to.imgH) / 2;
    const sx = lerp(from.sx, to.sx, e) * r;
    const sy = lerp(from.sy, to.sy, e) * r;
    const deg = lerp(from.turns * 90, to.turns * 90, e);
    frame.push({ offset, transform: `translate(${left}px, ${top}px) scale(${fx}, ${fy})` });
    img.push({
      offset,
      transform: `scale(${1 / fx}, ${1 / fy}) translate(${x}px, ${y}px) scale(${sx}, ${sy}) rotate(${deg}deg)`,
    });
  }
  return { frame, img };
}

export function ImageViewer() {
  const theme = useResolvedTheme();
  const [list, setList] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  /** Every image in the folder went away while it was shown. */
  const [emptied, setEmptied] = useState(false);
  const [img, setImg] = useState<{ path: string; src: string; copy: boolean } | null>(null);
  const [natural, setNatural] = useState<(Size & { src: string }) | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [stage, setStage] = useState<Size>({ w: 0, h: 0 });
  const [view, setView] = useState<View>(FIT);
  const [dragging, setDragging] = useState(false);
  /** The previous image, fading out while the next one comes in. */
  const [outgoing, setOutgoing] = useState<Drawn | null>(null);
  /** The image whose thumbnail flew in; it shows at once instead of fading in. */
  const [flownPath, setFlownPath] = useState<string | null>(null);
  /** The flown image the backend still waits to hear has been drawn. */
  const landing = useRef<string | null>(null);
  /** Counts opens, so reopening the image already shown still lands. */
  const [opens, setOpens] = useState(0);
  const lastShown = useRef("");
  /** Bumped when the shown file is saved over, to load it afresh. */
  const [rev, setRev] = useState(0);
  const [edits, setEdits] = useState<Edits>(NO_EDITS);
  /** The crop being drawn, in pixels of the turned image, while cropping. */
  const [cropping, setCropping] = useState<PixelRect | null>(null);
  const [ratioId, setRatioId] = useState("free");
  const [cropDragging, setCropDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Asks about unsaved edits; `go` is what was asked for, run once they're dealt with. */
  const [prompt, setPrompt] = useState<{ go: () => void } | null>(null);

  const order = useRef<string[] | null>(null);
  const currentRef = useRef(current);
  currentRef.current = current;
  const listRef = useRef(list);
  listRef.current = list;
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const cropDrag = useRef<{ handle: Handle; x: number; y: number; start: PixelRect } | null>(null);
  const preloads = useRef<HTMLImageElement[]>([]);
  const drawn = useRef<Drawn | null>(null);
  /** Earlier edits, for undo. */
  const history = useRef<Edits[]>([]);
  const frameRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  /** How the picture is placed now, and how it was before a turn began. */
  const geomRef = useRef<Geom | null>(null);
  const turnFrom = useRef<Geom | null>(null);
  /** A pan drawn straight onto the frame that React hasn't been told about yet. */
  const pendingPan = useRef<View | null>(null);
  const panTimer = useRef<ReturnType<typeof setTimeout>>();

  const nat = img && natural?.src === img.src && img.path === current ? natural : null;
  const full = nat ? turnedSize(nat, edits.turns) : null;
  /** The crop the image is shown cut down to; while cropping, all of it shows. */
  const shownCrop = cropping ? null : edits.crop;
  const box = full && (shownCrop ? { w: shownCrop.w, h: shownCrop.h } : full);
  // Cropping leaves room round the image for the handles on its edges.
  const inset = cropping ? CROP_INSET * 2 : 0;
  const fit =
    box && stage.w > 0
      ? Math.max(0.01, Math.min(1, (stage.w - inset) / box.w, (stage.h - inset) / box.h))
      : 1;
  const scale = view.scale ?? fit;
  const zoomed = view.scale !== null;
  const dirty = isEdited(edits);
  const editable =
    current !== null && !!nat && !!img && !img.copy && isEditableImage(extOf(current));
  const geo = useRef({ box, stage, fit, full });
  geo.current = { box, stage, fit, full };
  const natRef = useRef(nat);
  natRef.current = nat;
  const zoomedRef = useRef(zoomed);
  zoomedRef.current = zoomed;
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const croppingRef = useRef(cropping);
  croppingRef.current = cropping;
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  /** The save under way, for whatever waits on it to settle. */
  const saveRun = useRef<Promise<boolean> | null>(null);
  /**
   * Turns and flips pressed while a save runs. They are made on the saved
   * picture once it is in (`path`, not drawn from `stale`), or back on the
   * edits if the save failed.
   */
  const queued = useRef<{ path: string | null; stale: string | null; changes: TransformArgs[] }>({
    path: null,
    stale: null,
    changes: [],
  });

  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Follows theme and text size changes made in Doftar's other windows.
  useEffect(() => {
    const un = listen<{ state: { theme?: ThemePref; textScale?: number } }>(
      "sync:settings",
      ({ payload }) => {
        const { theme, textScale } = payload.state;
        if (theme) useSettings.setState({ theme });
        if (textScale) applyTextScale(textScale);
      }
    );
    return () => void un.then((f) => f());
  }, []);

  // Closing with unsaved edits asks first (viewer.rs holds the close back).
  useEffect(() => {
    void api.viewerSetDirty(dirty).catch(() => {});
  }, [dirty]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  /** Runs `go` now, or once unsaved edits are saved or thrown away. */
  const guard = useCallback(function guarded(go: () => void) {
    // A save under way settles first: once it is done there may be nothing to ask.
    if (savingRef.current) void saveRun.current?.then(() => guarded(go));
    else if (dirtyRef.current) setPrompt({ go });
    else go();
  }, []);

  const closeNow = useCallback(() => {
    void api
      .viewerSetDirty(false)
      .catch(() => {})
      .finally(() => void win.close());
  }, []);

  /** Re-reads the folder, keeping the shown image or, if it has gone, its neighbour. */
  const refresh = useCallback(async () => {
    const shown = currentRef.current;
    if (!shown) return;
    const dir = dirOf(shown);
    let found = await api.listImages(dir).catch(() => null);
    if (!found) return;
    // A hidden file opened while Doftar shows hidden files isn't listed.
    if (!found.includes(shown) && (await api.pathExists(shown).catch(() => false))) {
      found = [...found, shown];
    }
    if (currentRef.current !== shown) return;
    const next = arrange(found, order.current);
    if (!next.includes(shown)) {
      const old = listRef.current;
      const i = old.indexOf(shown);
      const survivor =
        old.slice(i + 1).find((p) => next.includes(p)) ??
        old.slice(0, Math.max(i, 0)).reverse().find((p) => next.includes(p));
      setCurrent(survivor ?? next[0] ?? null);
      if (!survivor && next.length === 0) setEmptied(true);
    }
    setList(next);
  }, []);

  const open = useCallback(
    (msg: ViewerOpen) => {
      const sameFolder = currentRef.current && dirOf(currentRef.current) === dirOf(msg.path);
      order.current = msg.order;
      landing.current = msg.flown ? msg.path : null;
      setFlownPath(msg.flown ? msg.path : null);
      setOpens((n) => n + 1);
      if (!sameFolder || !listRef.current.includes(msg.path)) setList([msg.path]);
      setCurrent(msg.path);
      setEmptied(false);
      currentRef.current = msg.path;
      void refresh();
    },
    [refresh]
  );

  // Listens first, then tells the backend it can send images straight here;
  // one asked for while the page was still loading comes back from that call.
  useEffect(() => {
    const unOpen = win.listen<ViewerOpen>("viewer:open", ({ payload }) =>
      guard(() => open(payload))
    );
    void unOpen
      .then(() => api.viewerReady())
      .then((first) => {
        if (!first) return;
        open(first);
        // A flown image shows the window once it is drawn, below.
        if (first.flown) return;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            void api.showZoomed().catch(() => {});
          })
        );
      })
      .catch(() => {});
    return () => void unOpen.then((f) => f());
  }, [open, guard]);

  // Closing fades the window out natively and hides it; the image is
  // dropped only then, so the next open never flashes it.
  useEffect(() => {
    const unHidden = win.listen("viewer:hidden", () => {
      currentRef.current = null;
      drawn.current = null;
      history.current = [];
      setCurrent(null);
      setList([]);
      setEmptied(false);
      setImg(null);
      setNatural(null);
      setOutgoing(null);
      setEdits(NO_EDITS);
      setCropping(null);
      setPrompt(null);
      queued.current.changes = [];
      preloads.current = [];
    });
    const unConfirm = win.listen("viewer:confirm-close", () => {
      if (!promptRef.current) guard(closeNow);
    });
    return () => {
      for (const un of [unHidden, unConfirm]) void un.then((f) => f());
    };
  }, [closeNow, guard]);

  useEffect(() => {
    const title = current ? nameOf(current) : "Image Viewer";
    document.title = title;
    void win.setTitle(title).catch(() => {});
  }, [current]);

  // Loads the shown image; a format WebKit can't decode falls back in onError.
  useEffect(() => {
    // The image on screen fades out under the new one.
    const last = drawn.current;
    drawn.current = null;
    if (last) setOutgoing(last);
    setView(FIT);
    setFailed(null);
    setImg(null);
    setEdits(NO_EDITS);
    setCropping(null);
    history.current = [];
    if (!current) return;
    let live = true;
    const copy = NEEDS_COPY.has(extOf(current));
    sourceFor(current, copy, rev)
      .then((src) => live && setImg({ path: current, src, copy }))
      .catch(() => live && setFailed(current));
    return () => {
      live = false;
    };
  }, [current, rev]);

  // Warms the images on either side, so stepping to them is instant.
  useEffect(() => {
    const i = current ? list.indexOf(current) : -1;
    if (i < 0) return;
    const neighbours = [list[i + 1], list[i - 1]].filter(Boolean);
    preloads.current = [];
    for (const path of neighbours) {
      void sourceFor(path, NEEDS_COPY.has(extOf(path)))
        .then((src) => {
          const el = new Image();
          el.src = src;
          preloads.current.push(el);
        })
        .catch(() => {});
    }
  }, [current, list]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onImgError = () => {
    if (!img) return;
    const { path } = img;
    if (img.copy) {
      setFailed(path);
      return;
    }
    sourceFor(path, true, rev)
      .then((src) => currentRef.current === path && setImg({ path, src, copy: true }))
      .catch(() => currentRef.current === path && setFailed(path));
  };

  const step = useCallback(
    (delta: number) => {
      const l = listRef.current;
      const c = currentRef.current;
      const next = c ? l[l.indexOf(c) + delta] : undefined;
      if (next) guard(() => setCurrent(next));
    },
    [guard]
  );

  /** Zooms to `target(scale)`, keeping the image point under `at` (stage pixels) still. */
  const zoom = useCallback((target: (s: number) => number, at?: { x: number; y: number }) => {
    if (croppingRef.current) return;
    setView((state) => {
      const v = pendingPan.current ?? state;
      pendingPan.current = null;
      clearTimeout(panTimer.current);
      const { box, stage, fit } = geo.current;
      if (!box) return v;
      const s = v.scale ?? fit;
      const ns = clamp(target(s), fit, MAX_SCALE);
      if (Math.abs(ns - fit) < 1e-3) return FIT;
      const cx = at?.x ?? stage.w / 2;
      const cy = at?.y ?? stage.h / 2;
      const left = (stage.w - box.w * s) / 2 + v.x;
      const top = (stage.h - box.h * s) / 2 + v.y;
      const px = (cx - left) / s;
      const py = (cy - top) / s;
      const x = cx - px * ns - (stage.w - box.w * ns) / 2;
      const y = cy - py * ns - (stage.h - box.h * ns) / 2;
      return { scale: ns, ...clampPan(box, stage, ns, x, y) };
    });
  }, []);

  const viewRef = useRef(view);
  viewRef.current = view;
  const frameTransform = (v: View) => {
    const { box, stage } = geo.current;
    const s = v.scale ?? geo.current.fit;
    if (!box) return "";
    const p = clampPan(box, stage, s, v.x, v.y);
    return `translate(${(stage.w - box.w * s) / 2 + p.x}px, ${(stage.h - box.h * s) / 2 + p.y}px)`;
  };
  const commitPan = useCallback(() => {
    clearTimeout(panTimer.current);
    const p = pendingPan.current;
    if (!p) return;
    pendingPan.current = null;
    setView(p);
  }, []);
  // Panning moves the frame straight away and lets React catch up once the
  // gesture settles, so a wheel tick or pointer move never waits on a render.
  const panBy = useCallback(
    (dx: number, dy: number) => {
      const { box, stage } = geo.current;
      const v = pendingPan.current ?? viewRef.current;
      if (v.scale === null || !box) return;
      const next = { scale: v.scale, ...clampPan(box, stage, v.scale, v.x + dx, v.y + dy) };
      pendingPan.current = next;
      if (frameRef.current) frameRef.current.style.transform = frameTransform(next);
      clearTimeout(panTimer.current);
      panTimer.current = setTimeout(commitPan, PAN_SETTLE_MS);
    },
    [commitPan]
  );
  // A render for anything else must not put the frame back where React
  // last saw it while a pan is still only on the screen.
  useLayoutEffect(() => {
    if (pendingPan.current && frameRef.current) {
      frameRef.current.style.transform = frameTransform(pendingPan.current);
    }
  });

  /**
   * Turns or flips the image, remembering the edits before for undo. `move`
   * carries a crop (made or being drawn) along with the image. Works from
   * refs, so key repeats faster than renders still add up.
   */
  const transform = useCallback(
    (...[change, move]: TransformArgs) => {
      if (savingRef.current) {
        queued.current.changes.push([change, move]);
        return;
      }
      const nat = natRef.current;
      if (!nat || !editableRef.current) return;
      const e = editsRef.current;
      const full = turnedSize(nat, e.turns);
      const next = { ...e, ...change(e), crop: e.crop && move(e.crop, full) };
      history.current.push(e);
      editsRef.current = next;
      setEdits(next);
      const r = croppingRef.current;
      if (r) {
        croppingRef.current = move(r, full);
        setCropping(croppingRef.current);
      }
      pendingPan.current = null;
      turnFrom.current = geomRef.current;
      setView(FIT);
    },
    []
  );
  useLayoutEffect(() => {
    const from = turnFrom.current;
    turnFrom.current = null;
    const to = geomRef.current;
    const frame = frameRef.current;
    const pic = imgRef.current;
    if (!from || !to || !frame || !pic) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const k = turnKeyframes(from, to);
    const opts: KeyframeAnimationOptions = { duration: dur("slow"), easing: "linear" };
    frame.animate(k.frame, opts);
    pic.animate(k.img, opts);
  }, [edits]);

  const rotate = useCallback(
    (clockwise: boolean) =>
      transform(
        // Under a single flip, turning the picture one way turns the pixels the other.
        (e) => ({ turns: e.turns + (clockwise ? 1 : -1) * e.sx * e.sy }),
        (r, full) => turnRect(r, full, clockwise)
      ),
    [transform]
  );

  const flip = useCallback(
    (axis: "h" | "v") =>
      transform(
        (e) => (axis === "h" ? { sx: -e.sx as 1 | -1 } : { sy: -e.sy as 1 | -1 }),
        (r, full) => flipRect(r, full, axis)
      ),
    [transform]
  );

  const undo = useCallback(() => {
    if (croppingRef.current || savingRef.current) return;
    const prev = history.current.pop();
    if (!prev) return;
    editsRef.current = prev;
    setEdits(prev);
    setView(FIT);
  }, []);

  const revert = useCallback(() => {
    history.current = [];
    setEdits(NO_EDITS);
    setCropping(null);
    setView(FIT);
  }, []);

  const startCrop = useCallback(() => {
    const { full } = geo.current;
    if (!full || !editableRef.current || croppingRef.current || savingRef.current) return;
    setView(FIT);
    setRatioId("free");
    setCropping(editsRef.current.crop ?? { x: 0, y: 0, w: full.w, h: full.h });
  }, []);

  const finishCrop = useCallback(() => {
    const r = croppingRef.current;
    const { full } = geo.current;
    if (!r || !full) return;
    const crop = settleCrop(r, full);
    const was = editsRef.current.crop;
    if (JSON.stringify(crop) !== JSON.stringify(was)) {
      history.current.push(editsRef.current);
      setEdits({ ...editsRef.current, crop });
    }
    setCropping(null);
  }, []);

  const cropRatio = (id: string): number | null => {
    const r = RATIOS.find((x) => x.id === id)?.ratio ?? null;
    if (r === "original") return full ? full.w / full.h : null;
    if (!r || !cropping) return r;
    // A preset follows the way the crop is drawn, tall or wide.
    return cropping.h > cropping.w ? 1 / r : r;
  };

  const pickRatio = (id: string) => {
    setRatioId(id);
    const r = cropRatio(id);
    if (!r || !cropping) return;
    const w = Math.min(cropping.w, cropping.h * r);
    const h = w / r;
    setCropping({
      x: cropping.x + (cropping.w - w) / 2,
      y: cropping.y + (cropping.h - h) / 2,
      w,
      h,
    });
  };

  /** Saves the edits over the file or beside it; true once saved. */
  const save = useCallback(
    (asCopy: boolean): Promise<boolean> => {
      if (savingRef.current && saveRun.current) return saveRun.current;
      const path = currentRef.current;
      if (!path || !dirtyRef.current || croppingRef.current) return Promise.resolve(false);
      // Set now rather than on render, so a second ⌘S can't start another save.
      savingRef.current = true;
      setSaving(true);
      const run = (async () => {
        try {
          const out = await api.saveImageEdit(path, toImageEdit(editsRef.current), asCopy);
          // Anything pressed meanwhile waits for the saved picture to load.
          queued.current.path = asCopy ? out : path;
          queued.current.stale = natRef.current?.src ?? null;
          // The loading effect clears the edits, once the edited picture is
          // kept to fade out under the saved one.
          if (asCopy) {
            setCurrent(out);
            currentRef.current = out;
            void refresh();
          } else {
            setRev((r) => r + 1);
          }
          dirtyRef.current = false;
          return true;
        } catch (err) {
          queued.current.path = path;
          queued.current.stale = null;
          setNotice(`Couldn't save: ${String(err)}`);
          return false;
        } finally {
          savingRef.current = false;
          setSaving(false);
        }
      })();
      saveRun.current = run;
      return run;
    },
    [refresh]
  );

  // Makes the turns and flips pressed during a save, once there is a picture
  // to make them on; moving to another image drops them.
  useEffect(() => {
    const q = queued.current;
    if (saving || q.changes.length === 0) return;
    if (current !== q.path) {
      q.changes = [];
      return;
    }
    if (!nat || nat.src === q.stale) return;
    const changes = q.changes;
    q.changes = [];
    for (const args of changes) transform(...args);
  }, [saving, current, nat, transform]);

  const answer = async (choice: "save" | "discard" | "cancel") => {
    const p = promptRef.current;
    if (!p) return;
    if (choice === "cancel") {
      setPrompt(null);
      return;
    }
    // A crop still being drawn isn't part of the edits.
    setCropping(null);
    croppingRef.current = null;
    // Saved meanwhile (a ⌘S that was under way) is as good as saved now.
    if (choice === "save" && dirtyRef.current && !(await save(false))) return;
    // Dismissed while the save ran: what was asked for is off.
    if (promptRef.current !== p) return;
    setPrompt(null);
    dirtyRef.current = false;
    if (choice === "discard") revert();
    p.go();
  };

  useEffect(() => {
    const unMenu = win.listen<string>("menu", ({ payload }) => {
      if (payload === "close_tab") guard(closeNow);
      else if (payload === "refresh") void refresh();
      else if (payload === "undo") undo();
    });
    const unFocus = win.onFocusChanged(({ payload: focused }) => {
      if (focused) void refresh();
    });
    return () => {
      for (const un of [unFocus, unMenu]) void un.then((f) => f());
    };
  }, [refresh, guard, closeNow, undo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (promptRef.current) {
        if (e.key === "Escape") {
          setPrompt(null);
          e.preventDefault();
        }
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (!mod && (e.target as HTMLElement).closest("select")) return;
      if (mod && key === "s") void save(e.shiftKey);
      else if (mod && (e.key === "=" || e.key === "+")) zoom((s) => s * ZOOM_STEP);
      else if (mod && e.key === "-") zoom((s) => s / ZOOM_STEP);
      else if (mod && e.key === "0") setView(FIT);
      else if (mod || e.altKey) return;
      else if (key === "r") rotate(!e.shiftKey);
      else if (key === "l") rotate(false);
      else if (key === "h") flip("h");
      else if (key === "v") flip("v");
      else if (croppingRef.current) {
        if (e.key === "Enter") finishCrop();
        else if (e.key === "Escape") setCropping(null);
        else return;
      } else if (key === "c") startCrop();
      else if (e.key === "ArrowRight" || e.key === "PageDown") step(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") step(-1);
      else if (e.key === "Home" || e.key === "End") {
        const l = listRef.current;
        const next = e.key === "Home" ? l[0] : l[l.length - 1];
        if (next) guard(() => setCurrent(next));
      } else if (e.key === "Escape") {
        if (zoomedRef.current) setView(FIT);
        else guard(closeNow);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, zoom, save, rotate, flip, finishCrop, startCrop, guard, closeNow]);

  // Pinch (or ⌘/Ctrl + scroll) zooms; scrolling pans a zoomed image and
  // a sideways two-finger swipe on a fitted one changes image.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const zoomAcc = { current: { factor: 1, at: { x: 0, y: 0 }, raf: 0 } };
    let swipe = 0;
    let swiped = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (croppingRef.current || promptRef.current) return;
      if (e.ctrlKey || e.metaKey) {
        // Pinch ticks within a frame fold into one zoom step.
        const r = el.getBoundingClientRect();
        const z = zoomAcc.current;
        z.factor *= Math.exp(-e.deltaY * 0.01);
        z.at = { x: e.clientX - r.left, y: e.clientY - r.top };
        if (!z.raf) {
          z.raf = requestAnimationFrame(() => {
            z.raf = 0;
            const factor = z.factor;
            z.factor = 1;
            zoom((s) => s * factor, z.at);
          });
        }
        return;
      }
      if (zoomedRef.current) {
        panBy(-e.deltaX, -e.deltaY);
        return;
      }
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      clearTimeout(idle);
      idle = setTimeout(() => {
        swipe = 0;
        swiped = false;
      }, SWIPE_IDLE_MS);
      if (swiped) return;
      swipe += e.deltaX;
      if (Math.abs(swipe) >= SWIPE_DISTANCE) {
        step(swipe > 0 ? 1 : -1);
        swiped = true;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      clearTimeout(idle);
      cancelAnimationFrame(zoomAcc.current.raf);
    };
  }, [zoom, panBy, step]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !zoomed || (e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    panBy(e.clientX - drag.current.x, e.clientY - drag.current.y);
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const endDrag = () => {
    drag.current = null;
    commitPan();
    setDragging(false);
  };
  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!box || cropping || (e.target as HTMLElement).closest("button")) return;
    if (zoomed) {
      setView(FIT);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    zoom(() => (fit < 1 ? 1 : 2), { x: e.clientX - r.left, y: e.clientY - r.top });
  };

  const onCropDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined;
    if (e.button !== 0 || !handle || !cropping) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    cropDrag.current = { handle, x: e.clientX, y: e.clientY, start: cropping };
    setCropDragging(true);
  };
  const onCropMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = cropDrag.current;
    if (!d || !full) return;
    const free = cropRatio(ratioId);
    // Shift keeps a freeform crop's shape while resizing from a corner.
    const ratio = free ?? (e.shiftKey ? d.start.w / d.start.h : null);
    const min = Math.min(full.w, full.h, Math.max(1, MIN_CROP / scale));
    const dx = (e.clientX - d.x) / scale;
    const dy = (e.clientY - d.y) / scale;
    setCropping(dragCrop(d.start, d.handle, dx, dy, full, ratio, min));
  };
  const endCropDrag = () => {
    cropDrag.current = null;
    setCropDragging(false);
  };

  const index = current ? list.indexOf(current) : -1;
  const failedHere = current !== null && failed === current;
  const shown = current !== null && img?.path === current && !failedHere;
  const pan = box ? clampPan(box, stage, scale, view.x, view.y) : { x: 0, y: 0 };
  const left = box ? (stage.w - box.w * scale) / 2 + pan.x : 0;
  const top = box ? (stage.h - box.h * scale) / 2 + pan.y : 0;
  const frameStyle: CSSProperties = box
    ? { width: box.w * scale, height: box.h * scale, transform: `translate(${left}px, ${top}px)` }
    : { visibility: "hidden" };
  // The picture is laid out unturned, centred where the turned one goes,
  // then turned and flipped about its centre.
  const imgStyle: CSSProperties =
    nat && full
      ? {
          width: nat.w * scale,
          height: nat.h * scale,
          transform: `translate(${((full.w - nat.w) / 2 - (shownCrop?.x ?? 0)) * scale}px, ${
            ((full.h - nat.h) / 2 - (shownCrop?.y ?? 0)) * scale
          }px) scale(${edits.sx}, ${edits.sy}) rotate(${edits.turns * 90}deg)`,
        }
      : {};
  const pixelated = scale >= 3;
  geomRef.current =
    nat && full && box
      ? {
          left,
          top,
          w: box.w * scale,
          h: box.h * scale,
          imgW: nat.w * scale,
          imgH: nat.h * scale,
          tx: ((full.w - nat.w) / 2 - (shownCrop?.x ?? 0)) * scale,
          ty: ((full.h - nat.h) / 2 - (shownCrop?.y ?? 0)) * scale,
          sx: edits.sx,
          sy: edits.sy,
          turns: edits.turns,
        }
      : null;
  if (nat && img) {
    drawn.current = {
      src: img.src,
      frame: frameStyle,
      style: imgStyle,
      cropped: !!shownCrop,
      pixelated,
    };
  }
  const measured = cropping ?? box;
  const meta = measured && `${Math.round(measured.w)} × ${Math.round(measured.h)}`;
  const busy = saving || !!prompt;

  // Where the image is drawn in the stage, while it is drawn whole and as it
  // is on disk: what a thumbnail flies onto, and back from.
  const pic =
    nat && box && !zoomed && !cropping && !dirty
      ? { x: left, y: top, w: box.w * scale, h: box.h * scale }
      : null;
  const picKey = pic && `${pic.x},${pic.y},${pic.w},${pic.h}`;
  const inWindow = useCallback(
    (r: typeof pic) => {
      const at = stageRef.current?.getBoundingClientRect();
      return r && at ? { x: at.left + r.x, y: at.top + r.y, w: r.w, h: r.h } : null;
    },
    []
  );

  // The flown thumbnail settles onto the image once it is drawn; two frames
  // on, so the image is on screen before the thumbnail over it goes.
  useEffect(() => {
    if (!current || landing.current !== current || (!nat && !failedHere)) return;
    landing.current = null;
    const at = inWindow(pic);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => void api.showZoomed(at).catch(() => {}))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, nat, failedHere, picKey, inWindow, opens]);

  // Keeps the backend told what is shown where, to fly it back on closing.
  useEffect(() => {
    const at = stageRef.current?.getBoundingClientRect();
    if (!at) return;
    const stageRect = { x: at.left, y: at.top, w: at.width, h: at.height };
    const where = inWindow(pic);
    const key = JSON.stringify([current, where, stageRect]);
    if (key === lastShown.current) return;
    lastShown.current = key;
    void api.viewerShown(current, where, stageRect).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, picKey, stage.w, stage.h, inWindow]);

  return (
    <div className="iv">
      <header className="iv-bar" data-tauri-drag-region>
        <span className="iv-name" data-tauri-drag-region title={current ?? undefined}>
          {current ? nameOf(current) : "Image Viewer"}
          {dirty && <span className="iv-edited"> — Edited</span>}
        </span>
        <span className="iv-meta" data-tauri-drag-region>
          {index >= 0 && list.length > 0 && `${index + 1} of ${list.length}`}
          {meta && ` · ${meta}`}
        </span>
        <div className="iv-tools">
          {cropping ? (
            <>
              <select
                className="iv-select"
                value={ratioId}
                onChange={(e) => pickRatio(e.target.value)}
                aria-label="Aspect ratio"
                title="Aspect ratio"
              >
                {RATIOS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <button
                className="iv-btn"
                onClick={() => zoom((s) => s / ZOOM_STEP)}
                disabled={!nat || !zoomed}
                aria-label="Zoom out"
                title="Zoom out (⌘−)"
              >
                <ZoomOutRegular />
              </button>
              <span className="iv-zoom" aria-live="polite">
                {nat ? `${Math.round(scale * 100)}%` : ""}
              </span>
              <button
                className="iv-btn"
                onClick={() => zoom((s) => s * ZOOM_STEP)}
                disabled={!nat || scale >= MAX_SCALE}
                aria-label="Zoom in"
                title="Zoom in (⌘+)"
              >
                <ZoomInRegular />
              </button>
              <button
                className="iv-btn"
                onClick={() => setView(FIT)}
                disabled={!nat || !zoomed}
                aria-label="Fit to window"
                title="Fit to window (⌘0)"
              >
                <ZoomFitRegular />
              </button>
            </>
          )}
          <span className="iv-sep" />
          <button
            className="iv-btn"
            onClick={() => rotate(false)}
            disabled={!editable || busy}
            aria-label="Rotate left"
            title={editable || !nat ? "Rotate left (L)" : "Doftar can't edit this kind of image"}
          >
            <RotateLeftRegular />
          </button>
          <button
            className="iv-btn"
            onClick={() => rotate(true)}
            disabled={!editable || busy}
            aria-label="Rotate right"
            title={editable || !nat ? "Rotate right (R)" : "Doftar can't edit this kind of image"}
          >
            <RotateRightRegular />
          </button>
          <button
            className="iv-btn"
            onClick={() => flip("h")}
            disabled={!editable || busy}
            aria-label="Flip horizontally"
            title="Flip horizontally (H)"
          >
            <FlipHorizontalRegular />
          </button>
          <button
            className="iv-btn"
            onClick={() => flip("v")}
            disabled={!editable || busy}
            aria-label="Flip vertically"
            title="Flip vertically (V)"
          >
            <FlipVerticalRegular />
          </button>
          {cropping ? (
            <>
              <span className="iv-sep" />
              <button className="iv-btn wide" onClick={() => setCropping(null)} title="Cancel (Esc)">
                Cancel
              </button>
              <button className="iv-btn wide primary" onClick={finishCrop} title="Crop (Return)">
                Done
              </button>
            </>
          ) : (
            <>
              <button
                className="iv-btn"
                onClick={startCrop}
                disabled={!editable || busy}
                aria-label="Crop"
                title="Crop (C)"
              >
                <CropRegular />
              </button>
              <span className="iv-sep" />
              {dirty ? (
                <>
                  <button
                    className="iv-btn"
                    onClick={revert}
                    disabled={busy}
                    aria-label="Revert"
                    title="Revert to the saved image"
                  >
                    <ArrowUndoRegular />
                  </button>
                  <button
                    className="iv-btn"
                    onClick={() => void save(true)}
                    disabled={busy}
                    aria-label="Save as a copy"
                    title="Save as a copy (⇧⌘S)"
                  >
                    <SaveCopyRegular />
                  </button>
                  <button
                    className="iv-btn wide primary"
                    onClick={() => void save(false)}
                    disabled={busy}
                    title="Save over the original (⌘S)"
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                </>
              ) : (
                <button
                  className="iv-btn wide"
                  onClick={() => openInPreview(current)}
                  disabled={!current}
                  title="Open in Preview"
                >
                  <OpenRegular />
                  <span>Open in Preview</span>
                </button>
              )}
            </>
          )}
        </div>
      </header>
      <div
        ref={stageRef}
        className={`iv-stage${zoomed ? " zoomed" : ""}${dragging ? " dragging" : ""}${
          cropping ? " cropping" : ""
        }${flownPath !== null && flownPath === current ? " flown" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
      >
        {outgoing && (
          <div
            key={`out:${outgoing.src}`}
            className={`iv-pic iv-out${outgoing.cropped ? " cropped" : ""}`}
            style={outgoing.frame}
            aria-hidden
            onAnimationEnd={() => setOutgoing(null)}
          >
            <img
              src={outgoing.src}
              alt=""
              draggable={false}
              className={outgoing.pixelated ? "pixelated" : undefined}
              style={outgoing.style}
            />
          </div>
        )}
        {shown && (
          <div ref={frameRef} className={`iv-pic${shownCrop ? " cropped" : ""}`} style={frameStyle}>
            <img
              ref={imgRef}
              key={img.src}
              src={img.src}
              alt={nameOf(current)}
              draggable={false}
              className={`${nat ? "ready" : ""}${pixelated ? " pixelated" : ""}` || undefined}
              style={imgStyle}
              onLoad={(e) => {
                const el = e.currentTarget;
                setNatural({
                  src: img.src,
                  w: el.naturalWidth || geo.current.stage.w,
                  h: el.naturalHeight || geo.current.stage.h,
                });
              }}
              onError={onImgError}
            />
          </div>
        )}
        {cropping && full && (
          <div
            className={`iv-crop${cropDragging ? " active" : ""}`}
            style={frameStyle}
            onPointerDown={onCropDown}
            onPointerMove={onCropMove}
            onPointerUp={endCropDrag}
            onPointerCancel={endCropDrag}
          >
            <div
              className="iv-crop-box"
              data-handle="move"
              style={{
                left: cropping.x * scale,
                top: cropping.y * scale,
                width: cropping.w * scale,
                height: cropping.h * scale,
              }}
            >
              {HANDLES.filter((h) => h.length === 2 || !cropRatio(ratioId)).map((h) => (
                <div key={h} className={`iv-crop-h ${h}`} data-handle={h} />
              ))}
            </div>
          </div>
        )}
        {current !== null && !failedHere && !nat && <div className="iv-loading">Loading…</div>}
        {current === null && emptied && (
          <div className="iv-empty">
            <ImageOffRegular />
            <span>No images left in this folder</span>
          </div>
        )}
        {failedHere && (
          <div className="iv-empty">
            <ImageOffRegular />
            <span>Doftar can't show this image</span>
            <button className="iv-btn wide" onClick={() => openInPreview(current)}>
              Open in Preview
            </button>
          </div>
        )}
        {notice && (
          <div className="iv-notice" role="alert">
            {notice}
          </div>
        )}
        <button
          className="iv-nav prev"
          onClick={() => step(-1)}
          disabled={index <= 0 || !!cropping}
          aria-label="Previous image"
          title="Previous (←)"
        >
          <ChevronLeftRegular />
        </button>
        <button
          className="iv-nav next"
          onClick={() => step(1)}
          disabled={index < 0 || index >= list.length - 1 || !!cropping}
          aria-label="Next image"
          title="Next (→)"
        >
          <ChevronRightRegular />
        </button>
      </div>
      {prompt && (
        <div className="iv-dialog-scrim">
          <div
            className="iv-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="iv-dialog-title"
            aria-describedby="iv-dialog-text"
          >
            <h2 id="iv-dialog-title">
              Save changes to “{current ? nameOf(current) : "this image"}”?
            </h2>
            <p id="iv-dialog-text">Your edits will be lost if you don't save them.</p>
            <div className="iv-dialog-actions">
              <button className="iv-btn wide" onClick={() => void answer("discard")} disabled={saving}>
                Don't Save
              </button>
              <span className="iv-dialog-gap" />
              <button className="iv-btn wide" onClick={() => void answer("cancel")} disabled={saving}>
                Cancel
              </button>
              <button
                className="iv-btn wide primary"
                onClick={() => void answer("save")}
                disabled={saving}
                autoFocus
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
