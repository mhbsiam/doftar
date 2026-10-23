import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { listen } from "@tauri-apps/api/event";
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
import { useResolvedTheme } from "../hooks/useResolvedTheme";
import { useSettings, type ThemePref } from "../stores/settings";
import { applyTextScale } from "../util/textScale";
import type { PdfAction, PdfState } from "../types";

const PREVIEW_APP = "/System/Applications/Preview.app";
const win = getCurrentWindow();
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const act = (action: PdfAction) => void api.pdfAction(action).catch(() => {});

/**
 * The PDF window's page: just the toolbar, and a message or password box when
 * a document can't show. The document itself is a native PDFKit view that
 * pdf.rs lays over the window below the toolbar.
 */
export function PdfViewer() {
  const theme = useResolvedTheme();
  const [state, setState] = useState<PdfState | null>(null);
  const [pageText, setPageText] = useState("");
  const [query, setQuery] = useState("");
  const [password, setPassword] = useState("");
  const bar = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    act({ do: "theme", dark: theme === "dark" });
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

  // The document fills the window below the toolbar, whatever its height.
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const report = () => act({ do: "inset", top: el.getBoundingClientRect().bottom });
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const unState = win.listen<PdfState>("pdf:state", ({ payload }) => setState(payload));
    void api.pdfState().then(setState).catch(() => {});
    const unMenu = win.listen<string>("menu", ({ payload }) => {
      if (payload === "close_tab") void win.close();
      else if (payload === "select_all") act({ do: "selectAll" });
    });
    return () => {
      for (const un of [unState, unMenu]) void un.then((f) => f());
    };
  }, []);

  const path = state?.path ?? null;
  const pages = state?.pages ?? 0;
  const page = state?.page ?? 0;

  useEffect(() => {
    setPageText(pages ? String(page + 1) : "");
  }, [page, pages]);

  // A new document starts with an empty search and password box.
  useEffect(() => {
    setQuery("");
    setPassword("");
  }, [path]);

  useEffect(() => {
    document.title = path ? nameOf(path) : "PDF";
  }, [path]);

  // The toolbar's own keys; the document's arrow keys and scrolling are native.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "f") {
        search.current?.focus();
        search.current?.select();
      } else if (mod && (e.key === "=" || e.key === "+")) act({ do: "zoomIn" });
      else if (mod && e.key === "-") act({ do: "zoomOut" });
      else if (mod && e.key === "0") act({ do: "fit" });
      else if (e.key === "Escape" && !mod) act({ do: "focus" });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const goToTyped = () => {
    const n = Number.parseInt(pageText, 10);
    if (Number.isFinite(n) && pages) act({ do: "page", index: Math.min(pages, Math.max(1, n)) - 1 });
    else setPageText(pages ? String(page + 1) : "");
  };

  const onFindKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      act({ do: "find", query, backwards: e.shiftKey });
    }
  };

  const showing = !!path && !state?.error && !state?.locked;
  const zoom = state ? `${Math.round(state.scale * 100)}%` : "";

  return (
    <div className="pv">
      <header ref={bar} className="iv-bar" data-tauri-drag-region>
        <button
          className={`iv-btn${state?.thumbnails ? " on" : ""}`}
          onClick={() => act({ do: "thumbnails", on: !state?.thumbnails })}
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
            onClick={() => act({ do: "zoomOut" })}
            disabled={!showing}
            aria-label="Zoom out"
            title="Zoom out (⌘−)"
          >
            <ZoomOutRegular />
          </button>
          <span className="iv-zoom pv-narrow-hide">{showing ? zoom : ""}</span>
          <button
            className="iv-btn pv-narrow-hide"
            onClick={() => act({ do: "zoomIn" })}
            disabled={!showing}
            aria-label="Zoom in"
            title="Zoom in (⌘+)"
          >
            <ZoomInRegular />
          </button>
          <button
            className={`iv-btn pv-narrow-hide${state?.fit ? " on" : ""}`}
            onClick={() => act(state?.fit ? { do: "actualSize" } : { do: "fit" })}
            disabled={!showing}
            aria-label={state?.fit ? "Actual size" : "Fit to window"}
            title={state?.fit ? "Actual size" : "Fit to window (⌘0)"}
          >
            <ZoomFitRegular />
          </button>
          <button
            className={`iv-btn pv-medium-hide${state?.twoUp ? " on" : ""}`}
            onClick={() => act({ do: "twoUp", on: !state?.twoUp })}
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
            onClick={() => act({ do: "find", query, backwards: true })}
            disabled={!showing || !query}
            aria-label="Previous match"
          >
            <ChevronUpRegular />
          </button>
          <button
            className="iv-btn pv-medium-hide"
            onClick={() => act({ do: "find", query, backwards: false })}
            disabled={!showing || !query}
            aria-label="Next match"
          >
            <ChevronDownRegular />
          </button>
          <span className="iv-sep" />
          <button
            className="iv-btn wide"
            onClick={() => path && void api.openWith([path], PREVIEW_APP).catch(() => {})}
            disabled={!path}
            title="Open in Preview"
          >
            <OpenRegular />
            <span>Open in Preview</span>
          </button>
        </div>
      </header>
      <div className="pv-stage">
        {path && state?.locked && (
          <form
            className="iv-empty pv-lock"
            onSubmit={(e) => {
              e.preventDefault();
              act({ do: "unlock", password });
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
            <button
              className="iv-btn wide"
              onClick={() => void api.openWith([path], PREVIEW_APP).catch(() => {})}
            >
              Open in Preview
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
