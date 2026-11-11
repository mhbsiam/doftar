import { Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  DocumentErrorRegular,
  DocumentOnePageRegular,
  ZoomInRegular,
  ZoomOutRegular,
} from "@fluentui/react-icons";
import { api } from "../ipc";
import { showError } from "../actions";
import { parentOf, useTabs } from "../stores/tabs";
import { DEFAULT_PREVIEW_REM, useDateFormat, useSettings } from "../stores/settings";
import { EASE, dur } from "../util/motion";
import { basename, formatDate, formatSize } from "../util/format";
import { fileKind, isPlayableVideo, typeLabel } from "../util/kinds";
import { readable } from "../util/readable";
import type { FileEntry } from "../types";
import { EntryIcon, newThumbId } from "./FileIcon";
import { MetadataRows, Row } from "./Dialogs";
import { useItemInfo } from "../hooks/useItemInfo";
import type { Doc } from "./DocBody";

// Load the reader renderers on the first preview.
const DocArticle = lazy(() => import("./DocBody"));

/** Long side of the Quick Look picture, in pixels. */
const PICTURE_PX = 800;
/** The same, once zoomed in. Asked for only then, because it takes longer to make. */
const ZOOMED_PICTURE_PX = 3200;
const ZOOM_STEP = 1.25;
/** A picture starts fitted to the bar, so it only grows. Text can also shrink. */
const ZOOM_LIMITS: Partial<Record<Shown["kind"], { min: number; max: number }>> = {
  doc: { min: 0.6, max: 3 },
  picture: { min: 1, max: 8 },
  pdf: { min: 1, max: 8 },
};
/** Long sides a PDF page is drawn at. The smallest that stays sharp is used. */
const PDF_PAGE_PX = [800, 1600, 3200];
const MIN_REM = 16;
const MAX_REM = 60;
const INFO_MAX = 0.75;

/** Set on the pane, because split view shares this width between the two halves. See global.css. */
const setWidthVar = (slot: HTMLElement, rem: number) =>
  (slot.closest<HTMLElement>(".pane") ?? slot).style.setProperty("--preview-w", `${rem}rem`);

/** The preview bar. It slides open beside the listing and shows the file last double-clicked. */
export function PreviewSlot() {
  const open = useTabs((s) => s.previewOpen);
  const entry = useTabs((s) => s.preview);
  const width = useSettings((s) => s.previewWidth);
  const [mounted, setMounted] = useState(open);
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (slot.current) setWidthVar(slot.current, width);
  }, [width]);
  useEffect(() => {
    if (slot.current) slot.current.inert = !open;
    if (open) {
      setMounted(true);
      return;
    }
    // Unmount when shut. This also stops a playing video.
    const t = setTimeout(() => setMounted(false), dur("slow"));
    return () => clearTimeout(t);
  }, [open]);
  return (
    <div
      ref={slot}
      className={`preview-slot${open ? "" : " closed"}`}
      aria-hidden={!open || undefined}
    >
      <aside className="preview" aria-label="Preview">
        <Resizer slot={slot} width={width} />
        {mounted &&
          (entry ? (
            // Not keyed by the modified time, so a rewritten file keeps its zoom and scroll position.
            <Preview key={entry.path} entry={entry} />
          ) : (
            <div className="pv-empty">
              <DocumentOnePageRegular />
              <span>Double-click a file to preview it</span>
            </div>
          ))}
      </aside>
    </div>
  );
}

const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;

/**
 * Track a press on `e`'s target until release and report how far the pointer moved.
 * `cursor` stays the resize cursor everywhere.
 */
function drag(
  e: ReactPointerEvent<HTMLElement>,
  cursor: "col-resizing" | "row-resizing",
  onMove: (dx: number, dy: number) => void,
  onEnd: () => void
) {
  e.preventDefault();
  const handle = e.currentTarget;
  try {
    handle.setPointerCapture(e.pointerId);
  } catch {
    // A synthetic or released pointer cannot be captured. The drag still tracks it.
  }
  const { clientX, clientY } = e;
  document.documentElement.classList.add(cursor);
  const move = (ev: PointerEvent) => onMove(ev.clientX - clientX, ev.clientY - clientY);
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    document.documentElement.classList.remove(cursor);
    onEnd();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

/** The inner edge of the preview bar. Drag it or use the arrow keys to resize. Double-click resets the width. */
function Resizer({ slot, width }: { slot: RefObject<HTMLDivElement | null>; width: number }) {
  // Keep the listing beside the bar from being squeezed out.
  const clamp = (w: number) => {
    const room = (slot.current?.parentElement?.clientWidth ?? Infinity) * 0.7;
    return Math.max(MIN_REM, Math.min(MAX_REM, room / remPx(), w));
  };
  const save = (w: number) => {
    const rounded = Math.round(clamp(w) * 4) / 4;
    if (slot.current) setWidthVar(slot.current, rounded);
    useSettings.getState().set({ previewWidth: rounded });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = slot.current;
    if (e.button !== 0 || !el) return;
    const startW = el.getBoundingClientRect().width / remPx();
    let w = startW;
    el.classList.add("resizing");
    drag(
      e,
      "col-resizing",
      (dx) => {
        // The bar sits at the right edge, so dragging left widens it.
        w = clamp(startW - dx / remPx());
        // Set the style directly while dragging, so the drag does not re-render the listing pane.
        setWidthVar(el, w);
      },
      () => {
        el.classList.remove("resizing");
        save(w);
      }
    );
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!step) return;
    e.preventDefault();
    save(useSettings.getState().previewWidth - step * (e.shiftKey ? 4 : 1));
  };

  return (
    <div
      className="pv-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize preview"
      aria-valuenow={Math.round(width)}
      aria-valuemin={MIN_REM}
      aria-valuemax={MAX_REM}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => save(DEFAULT_PREVIEW_REM)}
    />
  );
}

type PageSize = { w: number; h: number };

type Shown =
  | { kind: "loading" }
  | { kind: "doc"; doc: Doc }
  | { kind: "picture"; src: string }
  | { kind: "pdf"; pages: PageSize[] }
  | { kind: "video"; src: string }
  | { kind: "icon" }
  | { kind: "failed"; message: string };

/**
 * Follow a link in the previewed document `docPath` as the reader does.
 * Web and mail links open in the browser, documents in the reader, other files in their app.
 * open_link_target refuses anything that runs a program.
 */
async function follow(href: string, docPath: string, stage: HTMLElement) {
  // MarkdownView is loaded already, because it drew the link.
  const { resolveHref } = await import("./MarkdownView");
  const target = resolveHref(href, parentOf(docPath) ?? "/");
  if (!target) return;
  if (target.kind === "anchor") {
    stage.querySelector(`[id="${CSS.escape(target.id)}"]`)?.scrollIntoView({ block: "start" });
  } else if (target.kind === "web") {
    await api.openWebLink(target.url).catch(showError);
  } else if (await readable(target.path)) {
    await api.openReader(target.path).catch(showError);
  } else {
    await api.openLinkTarget(target.path).catch(showError);
  }
}

/** The reader draws text and data. Quick Look draws anything else as a picture. */
async function load(entry: FileEntry): Promise<Shown> {
  const { path, ext } = entry;
  if (isPlayableVideo(ext)) return { kind: "video", src: convertFileSrc(path) };
  // A PDF with a password, or still in the cloud, shows its Quick Look picture below.
  if (fileKind(ext) === "pdf") {
    const pages = await api.pdfPageSizes(path).catch(() => null);
    if (pages?.length) return { kind: "pdf", pages };
  }
  if (await readable(path)) {
    return { kind: "doc", doc: { path, ...(await api.readDocument(path)) } };
  }
  try {
    return { kind: "picture", src: convertFileSrc(await api.thumbnail(path, PICTURE_PX)) };
  } catch {
    return { kind: "icon" };
  }
}

/**
 * Zoom for what the stage shows: pinch, ⌘/Ctrl + scroll, or `zoomTo`.
 * What is under the pointer stays there. `fit` is the picture's size before it was zoomed.
 */
function useStageZoom(stage: RefObject<HTMLDivElement | null>, kind: Shown["kind"]) {
  const [zoom, setZoom] = useState(1);
  const fit = useRef({ w: 0, h: 0 });
  const anchor = useRef<{ x: number; y: number; fx: number; fy: number } | null>(null);
  const latest = useRef({ zoom, kind });
  latest.current.kind = kind;

  const zoomTo = useCallback(
    (target: (z: number) => number, at?: { x: number; y: number }) => {
      const el = stage.current;
      const content = el?.firstElementChild as HTMLElement | null | undefined;
      const limits = ZOOM_LIMITS[latest.current.kind];
      // A picture still loading has no size to zoom from.
      if (!el || !content?.offsetWidth || !limits) return;
      const now = latest.current.zoom;
      const next = Math.min(limits.max, Math.max(limits.min, target(now)));
      if (next === now) return;
      if (now === 1) fit.current = { w: content.offsetWidth, h: content.offsetHeight };
      const r = content.getBoundingClientRect();
      const s = el.getBoundingClientRect();
      const x = at?.x ?? s.left + s.width / 2;
      const y = at?.y ?? s.top + s.height / 2;
      anchor.current = { x, y, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
      latest.current.zoom = next;
      setZoom(next);
    },
    [stage]
  );

  useLayoutEffect(() => {
    const el = stage.current;
    const a = anchor.current;
    anchor.current = null;
    const r = el?.firstElementChild?.getBoundingClientRect();
    if (!el || !a || !r) return;
    el.scrollLeft += r.left + a.fx * r.width - a.x;
    el.scrollTop += r.top + a.fy * r.height - a.y;
  }, [stage, zoom]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((!e.ctrlKey && !e.metaKey) || !ZOOM_LIMITS[latest.current.kind]) return;
      e.preventDefault();
      // A mouse notch is far larger than a trackpad tick. Limit it to one step.
      const factor = Math.min(ZOOM_STEP, Math.max(1 / ZOOM_STEP, Math.exp(-e.deltaY * 0.01)));
      zoomTo((z) => z * factor, { x: e.clientX, y: e.clientY });
    };
    // WebKit reports a pinch as gesture events, not as a wheel with Ctrl held.
    type Pinch = Event & { scale: number; clientX: number; clientY: number };
    let from = 1;
    const onPinchStart = (e: Event) => {
      e.preventDefault();
      from = latest.current.zoom;
    };
    const onPinch = (e: Event) => {
      e.preventDefault();
      const { scale, clientX: x, clientY: y } = e as Pinch;
      zoomTo(() => from * scale, { x, y });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onPinchStart);
    el.addEventListener("gesturechange", onPinch);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onPinchStart);
      el.removeEventListener("gesturechange", onPinch);
    };
  }, [stage, zoomTo]);

  return { zoom, fit: fit.current, zoomTo };
}

/** One PDF page. It is drawn only near the view, so a long document stays light. */
const PdfSheet = memo(function PdfSheet({
  path,
  modifiedMs,
  index,
  page,
  px,
}: {
  path: string;
  modifiedMs: number;
  index: number;
  page: PageSize;
  px: number;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const el = sheet.current!;
    // The newest change comes last. A busy page can get several at once.
    const io = new IntersectionObserver((all) => setNear(all[all.length - 1].isIntersecting), {
      root: el.closest(".pv-stage"),
      rootMargin: "100% 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!near) {
      setSrc(null);
      return;
    }
    const id = newThumbId();
    let waiting = true;
    api
      .pdfPagePicture(path, index, px, id)
      .then((file) => waiting && setSrc(convertFileSrc(file)))
      .catch(() => {})
      .finally(() => {
        waiting = false;
      });
    // Fast scrolling leaves no queue of pages.
    return () => {
      if (waiting) void api.cancelThumbnail(id).catch(() => {});
      waiting = false;
    };
  }, [near, path, modifiedMs, index, px]);
  return (
    <div ref={sheet} className="pv-sheet" style={{ aspectRatio: `${page.w} / ${page.h}` }}>
      {src && <img src={src} alt={`Page ${index + 1}`} draggable={false} />}
    </div>
  );
});

/** All of a PDF's pages, each as wide as the bar times `zoom`. */
function PdfPages({
  path,
  modifiedMs,
  pages,
  zoom,
}: {
  path: string;
  modifiedMs: number;
  pages: PageSize[];
  zoom: number;
}) {
  const bar = useSettings((s) => s.previewWidth);
  const wide = bar * remPx() * zoom * window.devicePixelRatio;
  return (
    <div className="pv-pdf pv-in" style={{ width: `${zoom * 100}%` }}>
      {pages.map((page, i) => (
        <PdfSheet
          key={i}
          path={path}
          modifiedMs={modifiedMs}
          index={i}
          page={page}
          px={PDF_PAGE_PX.find((px) => px >= (wide * Math.max(page.w, page.h)) / page.w) ?? PDF_PAGE_PX[2]}
        />
      ))}
    </div>
  );
}

function Preview({ entry }: { entry: FileEntry }) {
  useDateFormat();
  const [shown, setShown] = useState<Shown>({ kind: "loading" });
  const stage = useRef<HTMLDivElement>(null);
  const { zoom, fit, zoomTo } = useStageZoom(stage, shown.kind);
  const enlarged = shown.kind === "picture" && zoom > 1;
  const limits = ZOOM_LIMITS[shown.kind];
  // The first picture blurs when enlarged. It stays if a sharper one can't be made.
  const [sharp, setSharp] = useState<string | null>(null);
  useEffect(() => {
    if (!enlarged) {
      setSharp(null);
      return;
    }
    let live = true;
    api
      .thumbnail(entry.path, ZOOMED_PICTURE_PX)
      .then((file) => live && setSharp(convertFileSrc(file)))
      .catch(() => live && setSharp(null));
    return () => {
      live = false;
    };
  }, [enlarged, entry]);
  useEffect(() => {
    let live = true;
    load(entry)
      .catch((err: unknown) => ({ kind: "failed", message: String(err) }) as const)
      // A PDF being rewritten can't be read for a moment. Keep its pages, and the place in them.
      // shortcut: a PDF that later gains a password keeps its old pages until it is reopened.
      .then((s) => live && setShown((now) => (now.kind === "pdf" && s.kind !== "pdf" ? now : s)));
    return () => {
      live = false;
    };
  }, [entry]);
  const json = useMemo(() => {
    if (shown.kind !== "doc" || shown.doc.kind !== "code" || shown.doc.lang !== "json") return undefined;
    try {
      return { value: JSON.parse(shown.doc.text) as unknown };
    } catch {
      return undefined;
    }
  }, [shown]);
  const audio = fileKind(entry.ext) === "audio";
  const onStageClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.dataset.href;
    if (href) void follow(href, entry.path, e.currentTarget);
  };

  return (
    <>
      <div className="pv-view">
        <div
          ref={stage}
          className={`pv-stage${shown.kind === "doc" ? " doc" : ""}${shown.kind === "pdf" ? " pdf" : ""}${enlarged ? " zoomed" : ""}`}
          onClick={onStageClick}
        >
          {shown.kind === "doc" && (
            <Suspense fallback={null}>
              <DocArticle doc={shown.doc} tree={json} className="pv-in" zoom={zoom} />
            </Suspense>
          )}
          {shown.kind === "pdf" && (
            <PdfPages path={entry.path} modifiedMs={entry.modifiedMs} pages={shown.pages} zoom={zoom} />
          )}
          {shown.kind === "picture" && (
            <img
              className="pv-picture pv-in"
              src={sharp ?? shown.src}
              alt=""
              draggable={false}
              style={enlarged ? { width: fit.w * zoom, height: fit.h * zoom } : undefined}
            />
          )}
          {shown.kind === "video" && (
            <video key={entry.modifiedMs} className="pv-picture pv-in" src={shown.src} controls playsInline />
          )}
          {shown.kind === "icon" && (
            <div className="pv-icon pv-in">
              <EntryIcon entry={entry} size={128} />
            </div>
          )}
          {shown.kind === "failed" && (
            <div className="pv-empty pv-in">
              <DocumentErrorRegular />
              <span>Can't preview this file: {shown.message}</span>
            </div>
          )}
        </div>
        {limits && (
          <div className={`pv-zoom${zoom !== 1 ? " on" : ""}`} role="group" aria-label="Zoom">
            <button
              className="iv-btn"
              onClick={() => zoomTo((z) => z / ZOOM_STEP)}
              disabled={zoom <= limits.min}
              aria-label="Zoom out"
              title="Zoom out"
            >
              <ZoomOutRegular />
            </button>
            <button
              className="iv-btn pv-zoom-level"
              onClick={() => zoomTo(() => 1)}
              disabled={zoom === 1}
              aria-label={`Reset zoom, now ${Math.round(zoom * 100)}%`}
              title="Reset zoom"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              className="iv-btn"
              onClick={() => zoomTo((z) => z * ZOOM_STEP)}
              disabled={zoom >= limits.max}
              aria-label="Zoom in"
              title="Zoom in"
            >
              <ZoomInRegular />
            </button>
          </div>
        )}
      </div>
      {audio && shown.kind !== "loading" && (
        <audio key={entry.modifiedMs} className="pv-audio" src={convertFileSrc(entry.path)} controls />
      )}
      <InfoDrawer key={entry.modifiedMs} entry={entry} />
    </>
  );
}

/**
 * The name, kind and date under the preview. Drag its top edge up, or use the arrow keys,
 * to show all other details. Double-click the edge to open or shut it fully.
 */
function InfoDrawer({ entry }: { entry: FileEntry }) {
  const stored = useSettings((s) => s.previewInfoHeight);
  // Keep the rest mounted while it is pulled open or slides shut.
  const [peek, setPeek] = useState(false);
  const expanded = stored > 0 || peek;
  const info = useItemInfo(expanded ? entry.path : null);
  const footer = useRef<HTMLElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLDivElement>(null);
  const glide = useRef<Animation | null>(null);

  const limits = () => {
    const min = summary.current?.getBoundingClientRect().height ?? 0;
    const max = (footer.current?.parentElement?.clientHeight ?? 0) * INFO_MAX;
    return { min, max: Math.max(min, max) };
  };

  /** Glide to `px` tall. Show only the summary if little else exists. */
  const settle = (from: number, px: number) => {
    const el = footer.current;
    if (!el) return;
    const { min, max } = limits();
    const to = Math.min(max, Math.max(min, px));
    const rem = to <= min + 8 ? 0 : Math.round((to / remPx()) * 4) / 4;
    flushSync(() => {
      setPeek(true);
      useSettings.getState().set({ previewInfoHeight: rem });
    });
    el.style.height = rem ? `${rem}rem` : "";
    const run = el.animate([{ height: `${from}px` }, { height: `${rem ? rem * remPx() : min}px` }], {
      duration: dur("base"),
      easing: EASE,
    });
    glide.current = run;
    void run.finished
      .catch(() => {})
      .then(() => glide.current === run && setPeek(false));
  };

  const pin = () => {
    const el = footer.current!;
    const from = el.getBoundingClientRect().height;
    glide.current?.cancel();
    glide.current = null;
    el.style.height = `${from}px`;
    return from;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = footer.current;
    if (e.button !== 0 || !el) return;
    // Pin first, so mounting the rest does not jump to the full height.
    const start = pin();
    const { min, max } = limits();
    let h = start;
    setPeek(true);
    drag(
      e,
      "row-resizing",
      (_dx, dy) => {
        // Never taller than the content. It grows as the details arrive.
        const content = min + (more.current?.scrollHeight ?? 0);
        h = Math.min(Math.max(start, Math.min(max, content)), Math.max(min, start - dy));
        el.style.height = `${h}px`;
      },
      () => settle(h, h)
    );
  };

  const toggle = () => {
    if (!footer.current) return;
    const from = pin();
    settle(from, useSettings.getState().previewInfoHeight > 0 ? 0 : Infinity);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
      return;
    }
    const step = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    if (!footer.current) return;
    const from = pin();
    settle(from, from + step * 2 * remPx());
  };

  return (
    <footer
      ref={footer}
      className={`pv-info${expanded ? " expanded" : ""}`}
      style={stored > 0 ? { height: `${stored}rem` } : undefined}
    >
      <div
        className="pv-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Show more details"
        aria-expanded={stored > 0}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={toggle}
      />
      <div ref={summary} className="pv-summary">
        <div className="pv-name" title={entry.name}>
          {entry.name}
        </div>
        <div className="pv-meta">
          {typeLabel(entry)}
          {!entry.isDir && ` · ${formatSize(entry.size)}`}
        </div>
        <div className="pv-meta">Modified {formatDate(entry.modifiedMs)}</div>
      </div>
      {expanded && (
        <div ref={more} className="pv-more">
          <Row label="Where">
            <span className="prop-path">{parentOf(entry.path) ?? "/"}</span>
          </Row>
          {info && (
            <>
              <Row label="Created">{formatDate(info.createdMs)}</Row>
              <Row label="Last opened">{formatDate(info.accessedMs)}</Row>
              {!entry.isDir && <Row label="Size on disk">{formatSize(info.sizeOnDisk)}</Row>}
              <Row label="Opens with">
                {info.defaultApp ? basename(info.defaultApp).replace(/\.app$/, "") : "No default app"}
              </Row>
              {info.whereFroms.length > 0 && (
                <Row label="Downloaded from">
                  <span className="prop-path">{info.whereFroms[0]}</span>
                </Row>
              )}
            </>
          )}
          <MetadataRows path={entry.path} />
        </div>
      )}
    </footer>
  );
}
