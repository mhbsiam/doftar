import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BookOpenRegular,
  ChevronDownRegular,
  ChevronUpRegular,
  DocumentPdfRegular,
  LockClosedRegular,
  OpenRegular,
  PanelLeftRegular,
  SearchRegular,
  ZoomFitRegular,
  ZoomInRegular,
  ZoomOutRegular,
} from "@fluentui/react-icons";
import { api } from "../ipc";
import { CaptionButtons } from "./CaptionButtons";
import { useViewerTheme } from "../hooks/useResolvedTheme";
import { openDoc, pageSizes, passwordProblem, pdfjs, type PageSize, type PdfDocument } from "../util/pdf";
import { logUiError } from "../util/uiErrors";
import type { PdfAction, PdfState } from "../types";

const win = getCurrentWindow();
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const ZOOM_STEP = 1.25;
const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
/** Space between pages, as the css lays them out. */
const PAGE_GAP_REM = 0.571;
const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;

/** Where to cover on a page, as fractions of its box. */
interface Mark {
  left: number;
  top: number;
  width: number;
  height: number;
}
/** One match: the page it is on and what to cover there. */
interface Hit {
  page: number;
  marks: Mark[];
}
/** The text of one page, with where each run sits, so a match maps back to marks. */
interface PageText {
  text: string;
  items: { str: string; start: number; end: number; left: number; top: number; width: number; height: number }[];
}

const EMPTY: PdfState = {
  path: null,
  error: null,
  locked: false,
  pages: 0,
  page: 0,
  scale: 1,
  fit: true,
  twoUp: false,
  thumbnails: false,
  found: null,
};
const WRONG_PASSWORD = "That password didn't open it";
const UNREADABLE = "Doftar can't read this PDF";
const UNREACHABLE = "Doftar can't start the PDF viewer";

/** The page text of `doc`, read one by one and kept for the next search. */
async function readText(doc: PdfDocument): Promise<PageText[]> {
  const all: PageText[] = [];
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: PageText["items"] = [];
    let text = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      // Where the run sits at 1:1, the same way the text layer places it.
      const tx = pdfjs.Util.transform(vp.transform, item.transform);
      const height = Math.hypot(tx[2], tx[3]) / vp.height;
      const top = (tx[5] / vp.height) - height;
      const left = tx[4] / vp.width;
      const width = item.width / vp.width;
      items.push({ str: item.str, start: text.length, end: text.length + item.str.length, left, top, width, height });
      // Runs are joined with a space, so a match stops at a gap between them.
      text += item.str + " ";
    }
    all.push({ text, items });
  }
  return all;
}

/** Every match in the page text. Runs are clipped to what they cover. */
function searchAll(pages: PageText[], query: string): Hit[] {
  const q = query.toLowerCase();
  const hits: Hit[] = [];
  pages.forEach((p, page) => {
    const hay = p.text.toLowerCase();
    let at = hay.indexOf(q);
    while (at !== -1) {
      const marks: Mark[] = [];
      for (const item of p.items) {
        if (item.end <= at) continue;
        if (item.start >= at + q.length) break;
        const cut0 = Math.max(at, item.start) - item.start;
        const cut1 = Math.min(at + q.length, item.end) - item.start;
        if (cut1 <= cut0) continue;
        const k = item.str.length || 1;
        marks.push({
          left: item.left + (item.width * cut0) / k,
          top: item.top,
          width: (item.width * (cut1 - cut0)) / k,
          height: item.height,
        });
      }
      if (marks.length) hits.push({ page, marks });
      at = hay.indexOf(q, at + q.length);
    }
  });
  return hits;
}

/** The hit to land on for `page`: the next one there, or wrapped to the other end. */
function firstHit(hits: Hit[], page: number, backwards: boolean): number {
  if (!hits.length) return 0;
  if (backwards) {
    for (let i = hits.length - 1; i >= 0; i--) if (hits[i].page <= page) return i;
    return hits.length - 1;
  }
  for (let i = 0; i < hits.length; i++) if (hits[i].page >= page) return i;
  return 0;
}

/** One page. It is drawn only near the view, so a long document stays light. */
const PdfPageCanvas = memo(function PdfPageCanvas({
  doc,
  index,
  size,
  scale,
  mark,
}: {
  doc: PdfDocument;
  index: number;
  size: PageSize;
  scale: number;
  mark: Hit | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = box.current!;
    // The newest change comes last. A busy page can get several at once.
    const io = new IntersectionObserver((all) => setNear(all[all.length - 1].isIntersecting), {
      root: el.closest(".pv-doc"),
      rootMargin: "100% 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const dpr = window.devicePixelRatio || 1;
  const px = Math.max(1, Math.round(size.w * scale * dpr));
  const py = Math.max(1, Math.round(size.h * scale * dpr));
  useEffect(() => {
    if (!near) return;
    let task: pdfjs.RenderTask | null = null;
    let stale = false;
    void (async () => {
      try {
        const page = await doc.getPage(index + 1);
        if (stale) return;
        const el = canvas.current!;
        // `px` is the drawn width in device pixels, so it carries the scale.
        const vp = page.getViewport({ scale: px / size.w });
        el.width = Math.max(1, Math.round(vp.width));
        el.height = Math.max(1, Math.round(vp.height));
        task = page.render({ canvasContext: el.getContext("2d")!, viewport: vp });
        await task.promise;
      } catch {
        // A cancelled render throws; the next one draws over it.
      }
    })();
    // Fast zooming leaves no queue of renders.
    return () => {
      stale = true;
      task?.cancel();
    };
  }, [near, doc, index, px, py, size.w, dpr]);
  return (
    <div
      ref={box}
      className="pv-page-box"
      data-page={index}
      style={{ width: `${size.w * scale}px`, height: `${size.h * scale}px` }}
    >
      <canvas ref={canvas} style={{ width: "100%", height: "100%" }} />
      {mark?.marks.map((m, i) => (
        <span
          key={i}
          className="pv-mark"
          style={{ left: `${m.left * 100}%`, top: `${m.top * 100}%`, width: `${m.width * 100}%`, height: `${m.height * 100}%` }}
        />
      ))}
    </div>
  );
});

/** One thumbnail. It is drawn only near the view of the sidebar. */
const Thumb = memo(function Thumb({
  doc,
  index,
  size,
  current,
  onGo,
}: {
  doc: PdfDocument;
  index: number;
  size: PageSize;
  current: boolean;
  onGo: () => void;
}) {
  const box = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = box.current!;
    const io = new IntersectionObserver((all) => setNear(all[all.length - 1].isIntersecting), {
      root: el.closest(".pv-side"),
      rootMargin: "200% 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const px = Math.round(112 * (window.devicePixelRatio || 1));
  const py = Math.max(1, Math.round((px * size.h) / size.w));
  useEffect(() => {
    if (!near) return;
    let task: pdfjs.RenderTask | null = null;
    let stale = false;
    void (async () => {
      try {
        const page = await doc.getPage(index + 1);
        if (stale) return;
        const el = canvas.current!;
        el.width = px;
        el.height = py;
        task = page.render({ canvasContext: el.getContext("2d")!, viewport: page.getViewport({ scale: px / size.w }) });
        await task.promise;
      } catch {
        // A cancelled render throws; the next one draws over it.
      }
    })();
    return () => {
      stale = true;
      task?.cancel();
    };
  }, [near, doc, index, px, py, size.w]);
  return (
    <button
      ref={box}
      className={`pv-thumb${current ? " on" : ""}`}
      onClick={onGo}
      aria-label={`Page ${index + 1}`}
      aria-current={current || undefined}
      title={`Page ${index + 1}`}
    >
      <canvas ref={canvas} />
    </button>
  );
});

/**
 * The toolbar and the document, drawn by pdf.js where a native PDFKit view sat on macOS.
 * The backend tells this page which file is open; every document action is handled here.
 */
export function PdfViewer() {
  const theme = useViewerTheme();
  const [state, setState] = useState<PdfState | null>(null);
  const [pageText, setPageText] = useState("");
  const [query, setQuery] = useState("");
  const [password, setPassword] = useState("");
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [hit, setHit] = useState<Hit | null>(null);
  /** Width the pages share, read from the scroll box. */
  const [docW, setDocW] = useState(0);
  const bar = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const docBox = useRef<HTMLDivElement>(null);

  // What the actions read and change, outside React so an action applies once.
  const live = useRef<PdfState | null>(null);
  const docRef = useRef<PdfDocument | null>(null);
  /** Answers the pdf.js password question for the document being opened. */
  const ask = useRef<((password: string) => void) | null>(null);
  const text = useRef<PageText[] | null>(null);
  const hits = useRef<Hit[]>([]);
  const at = useRef(0);
  const looked = useRef("");
  const fitRef = useRef(0);
  /** Finds run one after another, so a fast typist cannot interleave them. */
  const finding = useRef<Promise<void> | null>(null);

  const put = (patch: Partial<PdfState>) => {
    const next = { ...EMPTY, ...live.current, ...patch };
    live.current = next;
    setState(next);
  };

  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    const unState = win.listen<PdfState>("pdf:state", ({ payload }) => {
      // The backend only tracks the file. The document itself is this page's job.
      if (payload.path !== live.current?.path) {
        setDoc(null);
        setSizes([]);
        setHit(null);
        docRef.current = null;
        text.current = null;
        hits.current = [];
        looked.current = "";
      }
      put({ path: payload.path, error: payload.path === live.current?.path ? live.current?.error ?? null : null });
    });
    void api
      .pdfState()
      .then((s) => put({ path: s.path, error: s.error }))
      .catch((err) => {
        // The state command is unreachable (a broken install). Say so — a blank window teaches nothing.
        put({ error: UNREACHABLE });
        logUiError("pdf state", err);
      });
    const unMenu = win.listen<string>("menu", ({ payload }) => {
      if (payload === "close_tab") void win.close();
      else if (payload === "select_all") apply({ do: "selectAll" });
    });
    // Other windows reach this one through pdf_action, which lands here as an event.
    const unAction = win.listen<PdfAction>("pdf:action", ({ payload }) => apply(payload));
    return () => {
      for (const un of [unState, unMenu, unAction]) void un.then((f) => f());
    };
    // `apply` only reads refs and sets state, so the listeners subscribe once and never go stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const path = state?.path ?? null;

  // Open the file of `path`. One load at a time; a newer path stops the older one.
  useEffect(() => {
    if (!path) return;
    let gone = false;
    const task = openDoc(path, (answer, wrong) => {
      if (gone) return;
      ask.current = answer;
      put({ locked: true, error: wrong ? WRONG_PASSWORD : null });
    });
    void (async () => {
      try {
        const opened = await task.promise;
        if (gone) {
          void opened.destroy().catch(() => {});
          return;
        }
        docRef.current = opened;
        ask.current = null;
        setDoc(opened);
        const boxes = await pageSizes(opened);
        if (gone) return;
        text.current = null;
        hits.current = [];
        looked.current = "";
        setHit(null);
        setSizes(boxes);
        put({ pages: opened.numPages, page: 0, scale: 1, fit: true, locked: false, error: null, found: null });
        docBox.current?.scrollTo({ top: 0 });
      } catch (err) {
        if (gone || task.destroyed) return;
        // A password question came through the callback above.
        if (!passwordProblem(err)) put({ error: UNREADABLE });
      }
    })();
    return () => {
      gone = true;
      ask.current = null;
      void task.destroy().catch(() => {});
      const was = docRef.current;
      docRef.current = null;
      text.current = null;
      hits.current = [];
      looked.current = "";
      setDoc(null);
      setSizes([]);
      setHit(null);
      if (was) void was.destroy().catch(() => {});
    };
  }, [path]);

  useEffect(() => {
    setPageText(state?.pages ? String((state?.page ?? 0) + 1) : "");
  }, [state?.page, state?.pages]);

  useEffect(() => {
    setQuery("");
    setPassword("");
  }, [path]);

  useEffect(() => {
    document.title = path ? nameOf(path) : "PDF";
  }, [path]);

  /** Jump so page `index` starts at the top of the view. */
  const goTo = (index: number) => {
    const wrap = docBox.current?.firstElementChild as HTMLElement | null;
    const el = wrap?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "start" });
    put({ page: index });
  };

  // Toolbar keys only. The document scrolls and selects like any page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "f") {
        search.current?.focus();
        search.current?.select();
      } else if (mod && (e.key === "=" || e.key === "+")) apply({ do: "zoomIn" });
      else if (mod && e.key === "-") apply({ do: "zoomOut" });
      else if (mod && e.key === "0") apply({ do: "fit" });
      else if (e.key === "Escape" && !mod) apply({ do: "focus" });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `apply` only reads refs and sets state, so this handler is bound once and never goes stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goToTyped = () => {
    const pages = state?.pages ?? 0;
    const n = Number.parseInt(pageText, 10);
    if (Number.isFinite(n) && pages) apply({ do: "page", index: Math.min(pages, Math.max(1, n)) - 1 });
    else setPageText(pages ? String((state?.page ?? 0) + 1) : "");
  };

  const onFindKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply({ do: "find", query, backwards: e.shiftKey });
    }
  };

  /** One document action, applied here. Other windows' actions arrive as `pdf:action` events. */
  const apply = (action: PdfAction) => {
    const now = live.current;
    switch (action.do) {
      case "page":
        if (now?.pages) goTo(Math.min(now.pages - 1, Math.max(0, action.index)));
        break;
      case "step":
        if (now?.pages) goTo(Math.min(now.pages - 1, Math.max(0, now.page + action.delta)));
        break;
      case "zoomIn":
      case "zoomOut": {
        const at = (now?.fit ? fitRef.current : now?.scale) || 1;
        const next = Math.round(at * (action.do === "zoomIn" ? ZOOM_STEP : 1 / ZOOM_STEP) * 100) / 100;
        put({ fit: false, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)) });
        break;
      }
      case "fit":
        put({ fit: true, scale: fitRef.current || now?.scale || 1 });
        break;
      case "actualSize":
        put({ fit: false, scale: 1 });
        break;
      case "twoUp":
        put({ twoUp: action.on });
        break;
      case "thumbnails":
        put({ thumbnails: action.on });
        break;
      case "find": {
        const q = action.query;
        finding.current = (finding.current ?? Promise.resolve())
          .then(async () => {
            const d = docRef.current;
            if (!d) return;
            if (!q) {
              hits.current = [];
              looked.current = "";
              setHit(null);
              put({ found: null });
              return;
            }
            if (looked.current !== q) {
              looked.current = q;
              text.current ??= await readText(d);
              // The document may have moved on while the text was read.
              if (docRef.current !== d) return;
              hits.current = searchAll(text.current, q);
              at.current = firstHit(hits.current, live.current?.page ?? 0, action.backwards);
              put({ found: hits.current.length > 0 });
            } else if (hits.current.length) {
              at.current = (at.current + (action.backwards ? hits.current.length - 1 : 1)) % hits.current.length;
            } else {
              put({ found: false });
              return;
            }
            const hit = hits.current[at.current];
            if (!hit) return;
            setHit(hit);
            goTo(hit.page);
          })
          .catch(() => {});
        break;
      }
      case "unlock":
        ask.current?.(action.password);
        break;
      // No text layer, so there is nothing to select.
      case "selectAll":
        break;
      // The toolbar is part of the flow, and the theme follows data-theme.
      case "inset":
      case "theme":
        break;
      case "focus":
        docBox.current?.focus({ preventScroll: true });
        break;
    }
  };

  // The width the pages share. It drives the fit, so it is read on every size change.
  const showing = !!path && !state?.error && !state?.locked;
  useEffect(() => {
    const el = docBox.current;
    if (!showing || !el) return;
    let frame = 0;
    const measure = () => setDocW(el.clientWidth);
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        // The page the top third of the view sits in.
        const wrap = el.firstElementChild as HTMLElement | null;
        if (!wrap?.children.length) return;
        const line = el.scrollTop + el.clientHeight * 0.3;
        let lo = 0;
        let hi = wrap.children.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if ((wrap.children[mid] as HTMLElement).offsetTop <= line) lo = mid;
          else hi = mid - 1;
        }
        // In two-up the pages of a row share a top; the left one is the current one.
        if (live.current?.twoUp && lo > 0 && (wrap.children[lo - 1] as HTMLElement).offsetTop === (wrap.children[lo] as HTMLElement).offsetTop) {
          lo -= 1;
        }
        if (live.current?.page !== lo) put({ page: lo });
      });
    };
    const ro = new ResizeObserver(measure);
    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(el);
    measure();
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [showing]);

  // The scale that fits the page, or both pages, to the width. Zero before it can be measured.
  const fitScale = useMemo(() => {
    const first = sizes[0];
    if (!docW || !first?.w) return 0;
    return ((state?.twoUp ? (docW - PAGE_GAP_REM * remPx()) / 2 : docW) / first.w) || 0;
  }, [docW, sizes, state?.twoUp]);
  fitRef.current = fitScale;
  const scale = state?.fit && fitScale ? fitScale : state?.scale || 1;
  // In fit mode the zoom shown follows the window, as the native view reported its own scale.
  useLayoutEffect(() => {
    if (state?.fit && fitScale && state.scale !== fitScale) put({ scale: fitScale });
  }, [state?.fit, fitScale, state?.scale]);

  const pages = state?.pages ?? 0;
  const page = state?.page ?? 0;
  const zoom = state ? `${Math.round(state.scale * 100)}%` : "";

  return (
    <div className="pv">
      <header ref={bar} className="iv-bar" data-tauri-drag-region>
        <CaptionButtons />
        <button
          className={`iv-btn${state?.thumbnails ? " on" : ""}`}
          onClick={() => apply({ do: "thumbnails", on: !state?.thumbnails })}
          disabled={!showing}
          aria-label="Page thumbnails"
          aria-pressed={!!state?.thumbnails}
          title="Page thumbnails"
        >
          <PanelLeftRegular />
        </button>
        <span className="iv-name" data-tauri-drag-region title={path ?? undefined}>
          {path ? nameOf(path) : "PDF"}
        </span>
        <span className="pv-pages" data-tauri-drag-region>
          {showing && (
            <>
              <input
                className="pv-page"
                value={pageText}
                onChange={(e) => setPageText(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && goToTyped()}
                onBlur={goToTyped}
                aria-label="Page"
                inputMode="numeric"
              />
              <span>of {pages}</span>
            </>
          )}
        </span>
        <div className="iv-tools">
          <button
            className="iv-btn pv-narrow-hide"
            onClick={() => apply({ do: "zoomOut" })}
            disabled={!showing}
            aria-label="Zoom out"
            title="Zoom out (Ctrl+−)"
          >
            <ZoomOutRegular />
          </button>
          <span className="iv-zoom pv-narrow-hide">{showing ? zoom : ""}</span>
          <button
            className="iv-btn pv-narrow-hide"
            onClick={() => apply({ do: "zoomIn" })}
            disabled={!showing}
            aria-label="Zoom in"
            title="Zoom in (Ctrl++)"
          >
            <ZoomInRegular />
          </button>
          <button
            className={`iv-btn pv-narrow-hide${state?.fit ? " on" : ""}`}
            onClick={() => apply(state?.fit ? { do: "actualSize" } : { do: "fit" })}
            disabled={!showing}
            aria-label={state?.fit ? "Actual size" : "Fit to window"}
            title={state?.fit ? "Actual size" : "Fit to window (Ctrl+0)"}
          >
            <ZoomFitRegular />
          </button>
          <button
            className={`iv-btn pv-medium-hide${state?.twoUp ? " on" : ""}`}
            onClick={() => apply({ do: "twoUp", on: !state?.twoUp })}
            disabled={!showing}
            aria-label="Two pages side by side"
            aria-pressed={!!state?.twoUp}
            title="Two pages side by side"
          >
            <BookOpenRegular />
          </button>
          <span className="iv-sep pv-narrow-hide" />
          <label className={`pv-find${state?.found === false ? " missed" : ""}`}>
            <SearchRegular />
            <input
              ref={search}
              type="search"
              placeholder="Find"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onFindKey}
              disabled={!showing}
              aria-label="Find in document"
              title="Return finds the next match, ⇧Return the previous one"
            />
            {state?.found === false && showing && <span className="pv-missed">No matches</span>}
          </label>
          <button
            className="iv-btn pv-medium-hide"
            onClick={() => apply({ do: "find", query, backwards: true })}
            disabled={!showing || !query}
            aria-label="Previous match"
          >
            <ChevronUpRegular />
          </button>
          <button
            className="iv-btn pv-medium-hide"
            onClick={() => apply({ do: "find", query, backwards: false })}
            disabled={!showing || !query}
            aria-label="Next match"
          >
            <ChevronDownRegular />
          </button>
          <span className="iv-sep" />
          <button
            className="iv-btn wide"
            onClick={() => path && void api.openPath(path).catch(() => {})}
            disabled={!path}
            title="Open in default app"
          >
            <OpenRegular />
            <span>Open in default app</span>
          </button>
        </div>
      </header>
      <div className="pv-stage">
        {path && state?.locked && (
          <form
            className="iv-empty pv-lock"
            onSubmit={(e) => {
              e.preventDefault();
              apply({ do: "unlock", password });
            }}
          >
            <LockClosedRegular />
            <span>“{nameOf(path)}” is protected with a password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              aria-label="Password"
              autoFocus
            />
            {state.error && <span className="pv-error">{state.error}</span>}
            <button className="iv-btn wide primary" type="submit" disabled={!password}>
              Open
            </button>
          </form>
        )}
        {path && state?.error && !state.locked && (
          <div className="iv-empty">
            <DocumentPdfRegular />
            <span>{state.error}</span>
            <button className="iv-btn wide" onClick={() => void api.openPath(path).catch(() => {})}>
              Open in default app
            </button>
          </div>
        )}
        {/* No path yet: the window itself failed to initialize (a denied or dead state command). */}
        {!path && state?.error && (
          <div className="iv-empty">
            <DocumentPdfRegular />
            <span>{state.error}</span>
          </div>
        )}
        {showing && doc && sizes.length > 0 && (
          <div className="pv-doc-row pv-in">
            {state?.thumbnails && (
              <div className="pv-side">
                {sizes.map((size, i) => (
                  <Thumb
                    key={i}
                    doc={doc}
                    index={i}
                    size={size}
                    current={page === i}
                    onGo={() => apply({ do: "page", index: i })}
                  />
                ))}
              </div>
            )}
            <div ref={docBox} className="pv-doc" tabIndex={-1}>
              <div className={`pv-doc-pages${state?.twoUp ? " two" : ""}`}>
                {sizes.map((size, i) => (
                  <PdfPageCanvas
                    key={i}
                    doc={doc}
                    index={i}
                    size={size}
                    scale={scale}
                    mark={hit?.page === i ? hit : null}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
