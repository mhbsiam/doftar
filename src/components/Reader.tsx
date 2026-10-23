import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeftRegular,
  ArrowRightRegular,
  DocumentErrorRegular,
  OpenRegular,
  TextBulletListLtrRegular,
} from "@fluentui/react-icons";
import { api } from "../ipc";
import { useResolvedTheme } from "../hooks/useResolvedTheme";
import { useSettings, type ThemePref } from "../stores/settings";
import { applyTextScale } from "../util/textScale";
import { extOf, isMarkdown, isPlainText, isViewerImage } from "../util/kinds";
import type { ReaderDoc, ReaderOpen } from "../types";
import { MarkdownView, resolveHref, textOf } from "./MarkdownView";
import { highlight } from "./highlight";

const win = getCurrentWindow();
const NOTICE_MS = 4000;
const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];
/** How far below the top of the page a heading counts as the one being read. */
const READING_LINE = 96;
/** Beyond this many lines a code file goes without line numbers. */
const MAX_NUMBERED_LINES = 200_000;
/**
 * Files a document's link never opens, whatever their default app: ones that
 * launch, install or set something up, and ones that point somewhere else.
 */
const NEVER_OPEN = new Set([
  "app", "pkg", "mpkg", "prefpane", "saver", "workflow", "action", "shortcut", "mobileconfig",
  "terminal", "command", "tool", "fileloc", "webloc", "inetloc",
]);

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

type Doc = ReaderDoc & { path: string };

/** Back and forward through the documents opened and followed. */
interface Trail {
  paths: string[];
  at: number;
}

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Source code coloured by language, with line numbers alongside. */
const CodeFile = memo(function CodeFile({ lang, text }: { lang: string; text: string }) {
  const body = useMemo(() => highlight(lang, text), [lang, text]);
  const numbers = useMemo(() => {
    let lines = 1;
    for (let i = text.indexOf("\n"); i !== -1 && lines <= MAX_NUMBERED_LINES; i = text.indexOf("\n", i + 1)) {
      if (i < text.length - 1) lines += 1;
    }
    // Millions of short lines would stall the window on the gutter alone.
    if (lines > MAX_NUMBERED_LINES) return null;
    return Array.from({ length: lines }, (_, i) => i + 1).join("\n");
  }, [text]);
  return (
    <div className="rd-code">
      {numbers !== null && (
        <pre className="rd-gutter" aria-hidden>
          {numbers}
        </pre>
      )}
      <pre className="rd-src">
        <code className="hljs">{body}</code>
      </pre>
    </div>
  );
});

/**
 * The reader window's page: Markdown drawn as a document with an outline of
 * its headings, plain text wrapped, or source code coloured. Links to other
 * documents open here; web links open in the browser.
 */
export function Reader() {
  const theme = useResolvedTheme();
  const [trail, setTrail] = useState<Trail>({ paths: [], at: -1 });
  const [doc, setDoc] = useState<Doc | null>(null);
  const [failed, setFailed] = useState<{ path: string; message: string } | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [zoom, setZoom] = useState(2);
  const [active, setActive] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [defaultApp, setDefaultApp] = useState<string | null>(null);

  const current = trail.at >= 0 ? trail.paths[trail.at] : null;
  const currentRef = useRef(current);
  currentRef.current = current;
  const trailRef = useRef(trail);
  trailRef.current = trail;
  const docRef = useRef(doc);
  docRef.current = doc;
  const scroller = useRef<HTMLElement>(null);
  const article = useRef<HTMLElement>(null);
  /** Where each document was scrolled to, for going back to it. */
  const scrolls = useRef(new Map<string, number>());
  /** Scrolled to once the document it belongs to is drawn. */
  const pending = useRef<{ path: string; anchor: string | null; top: number } | null>(null);
  /** Set when a document is opened into the window, which shows once it is drawn. */
  const showOnDraw = useRef(false);

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

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  // Keeps the backend told what is shown and where the document sits, so
  // the file's icon can fly back from there on closing.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const report = () => {
      const at = el.getBoundingClientRect();
      const stage = { x: at.left, y: at.top, w: at.width, h: at.height };
      void api.viewerShown(current, null, stage).catch(() => {});
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [current]);

  const step = useCallback((delta: number) => {
    const t = trailRef.current;
    const at = t.at + delta;
    if (at < 0 || at >= t.paths.length) return;
    const from = t.paths[t.at];
    if (from && scroller.current) scrolls.current.set(from, scroller.current.scrollTop);
    const path = t.paths[at];
    pending.current = { path, anchor: null, top: scrolls.current.get(path) ?? 0 };
    setTrail({ ...t, at });
  }, []);

  /** Reads the shown document again; `quiet` keeps it as it is when unchanged or unreadable. */
  const load = useCallback(async (path: string, quiet: boolean) => {
    try {
      const read = await api.readDocument(path);
      if (currentRef.current !== path) return;
      if (quiet && docRef.current?.path === path && docRef.current.modified === read.modified) {
        return;
      }
      setFailed(null);
      setDoc({ path, ...read });
    } catch (err) {
      if (currentRef.current !== path || quiet) return;
      setDoc(null);
      setFailed({ path, message: String(err) });
    }
  }, []);

  /** Moves to `path`, remembering where the page was. */
  const go = useCallback(
    (path: string, anchor: string | null = null) => {
      const from = currentRef.current;
      if (from === path) {
        if (anchor) scrollToId(anchor);
        else void load(path, true);
        return;
      }
      if (from && scroller.current) scrolls.current.set(from, scroller.current.scrollTop);
      pending.current = { path, anchor, top: 0 };
      setTrail((t) => ({ paths: [...t.paths.slice(0, t.at + 1), path], at: t.at + 1 }));
    },
    [load]
  );

  useEffect(() => {
    if (!current) return;
    void load(current, false);
    const title = nameOf(current);
    document.title = title;
    void win.setTitle(title).catch(() => {});
    setDefaultApp(null);
    void api
      .openWithApps(current)
      .then((apps) => {
        if (currentRef.current === current) setDefaultApp(apps.find((a) => a.isDefault)?.name ?? null);
      })
      .catch(() => {});
  }, [current, load]);

  // Once a document is drawn: scroll where it was asked, and make sure the
  // window it was opened into is showing.
  useLayoutEffect(() => {
    const p = pending.current;
    const drawn = doc?.path ?? failed?.path;
    if (!drawn || !p || p.path !== drawn) return;
    pending.current = null;
    const el = scroller.current;
    if (el) el.scrollTop = p.top;
    if (p.anchor) scrollToId(p.anchor, false);
    el?.focus({ preventScroll: true });
    // Not after a frame: a hidden window gets none, so that would wait for
    // the backend's fallback. The backend shows a ready window itself.
    if (showOnDraw.current) {
      showOnDraw.current = false;
      void api.showZoomed().catch(() => {});
    }
  }, [doc, failed]);

  // Listens first, then tells the backend it can send documents straight here.
  useEffect(() => {
    const open = (path: string) => {
      showOnDraw.current = true;
      go(path);
    };
    const unOpen = win.listen<ReaderOpen>("reader:open", ({ payload }) => open(payload.path));
    void unOpen
      .then(() => api.readerReady())
      .then((first) => {
        if (first) open(first.path);
      })
      .catch(() => {});
    return () => void unOpen.then((f) => f());
  }, [go]);

  // Closing hides the window (reader.rs); the next document starts afresh.
  useEffect(() => {
    const unHidden = win.listen("reader:hidden", () => {
      currentRef.current = null;
      docRef.current = null;
      pending.current = null;
      showOnDraw.current = false;
      scrolls.current.clear();
      setTrail({ paths: [], at: -1 });
      setDoc(null);
      setFailed(null);
      setNotice(null);
    });
    return () => void unHidden.then((f) => f());
  }, []);

  // A document edited elsewhere shows its changes when the window comes back.
  useEffect(() => {
    const unFocus = win.onFocusChanged(({ payload: focused }) => {
      const path = currentRef.current;
      if (focused && path) void load(path, true);
    });
    const unMenu = win.listen<string>("menu", ({ payload }) => {
      const path = currentRef.current;
      if (payload === "close_tab") void win.close();
      else if (payload === "refresh" && path) void load(path, false);
      else if (payload === "back") step(-1);
      else if (payload === "forward") step(1);
      else if (payload === "select_all" && article.current) {
        window.getSelection()?.selectAllChildren(article.current);
      }
    });
    return () => {
      for (const un of [unFocus, unMenu]) void un.then((f) => f());
    };
  }, [load, step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "=" || e.key === "+")) setZoom((z) => Math.min(ZOOMS.length - 1, z + 1));
      else if (mod && e.key === "-") setZoom((z) => Math.max(0, z - 1));
      else if (mod && e.key === "0") setZoom(2);
      else if (e.altKey || e.metaKey) return;
      else if (e.key === "Escape") void win.close();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const outline = useMemo(
    () =>
      (doc?.kind === "markdown" ? doc.blocks : []).flatMap((b) =>
        b.t === "heading" && b.level <= 3 ? [{ id: b.id, level: b.level, text: textOf(b.c) }] : []
      ),
    [doc]
  );

  // Marks the section being read in the outline.
  useEffect(() => {
    const el = scroller.current;
    if (!el || outline.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = el.getBoundingClientRect().top + READING_LINE;
      let id: string | null = outline[0].id;
      for (const h of outline) {
        const node = document.getElementById(h.id);
        if (node && node.getBoundingClientRect().top <= top) id = h.id;
      }
      setActive(id);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [outline]);

  const follow = async (href: string) => {
    const path = currentRef.current;
    if (!path) return;
    const target = resolveHref(href, dirOf(path));
    if (!target) return;
    if (target.kind === "anchor") {
      scrollToId(target.id);
      return;
    }
    if (target.kind === "web") {
      await openUrl(target.url).catch(() => setNotice(`Couldn't open ${target.url}`));
      return;
    }
    if (target.path === path) {
      if (target.anchor) scrollToId(target.anchor);
      return;
    }
    if (!(await api.pathExists(target.path).catch(() => false))) {
      setNotice(`“${nameOf(target.path)}” isn't there`);
      return;
    }
    const ext = extOf(target.path);
    const readable =
      isMarkdown(ext) ||
      (isPlainText(ext) && (await api.isTextFile(target.path).catch(() => false)));
    if (readable) go(target.path, target.anchor || null);
    else if (isViewerImage(ext)) await api.openImageViewer(target.path, null);
    else if (await launches(target.path)) {
      setNotice(`Doftar doesn't run programs from a document: “${nameOf(target.path)}”`);
    } else {
      // A document's link must not start a program; open_link_target
      // refuses one on the Rust side even if the check above is wrong.
      await api.openLinkTarget(target.path).catch(() => setNotice(`Couldn't open “${nameOf(target.path)}”`));
    }
  };

  const onArticleClick = (e: ReactMouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.dataset.href;
    if (href) void follow(href);
  };

  const openInApp = () => {
    if (current) void api.openLinkTarget(current).catch(() => setNotice("Couldn't open the file"));
  };

  const hasOutline = outline.length >= 2;

  return (
    <div className="md-reader">
      <header className="iv-bar" data-tauri-drag-region>
        <button
          className="iv-btn"
          onClick={() => step(-1)}
          disabled={trail.at <= 0}
          aria-label="Back"
          title="Back (⌘[)"
        >
          <ArrowLeftRegular />
        </button>
        <button
          className="iv-btn"
          onClick={() => step(1)}
          disabled={trail.at >= trail.paths.length - 1}
          aria-label="Forward"
          title="Forward (⌘])"
        >
          <ArrowRightRegular />
        </button>
        <span className="iv-name" data-tauri-drag-region title={current ?? undefined}>
          {current ? nameOf(current) : "Reader"}
        </span>
        <span className="iv-meta" data-tauri-drag-region>
          {current ? dirOf(current) : ""}
        </span>
        <div className="iv-tools">
          <button
            className={`iv-btn${outlineOpen && hasOutline ? " on" : ""}`}
            onClick={() => setOutlineOpen((o) => !o)}
            disabled={!hasOutline}
            aria-label="Outline"
            aria-pressed={outlineOpen && hasOutline}
            title="Outline"
          >
            <TextBulletListLtrRegular />
          </button>
          <span className="iv-sep" />
          <button className="iv-btn wide" onClick={openInApp} disabled={!current} title="Open in the default app">
            <OpenRegular />
            <span>{defaultApp ? `Open in ${defaultApp}` : "Open in Default App"}</span>
          </button>
        </div>
      </header>
      <div className="md-body">
        {hasOutline && outlineOpen && doc && (
          <nav className="md-outline" aria-label="Outline">
            {outline.map((h) => (
              <button
                key={h.id}
                className={`md-outline-item l${h.level}${active === h.id ? " active" : ""}`}
                onClick={() => scrollToId(h.id)}
                title={h.text}
              >
                {h.text}
              </button>
            ))}
          </nav>
        )}
        <main ref={scroller} className="md-scroll" tabIndex={-1}>
          {doc && (
            <article
              ref={article}
              key={doc.path}
              className={doc.kind === "markdown" ? "md-doc" : "rd-doc"}
              style={{ fontSize: `${ZOOMS[zoom]}rem` }}
              onClick={doc.kind === "markdown" ? onArticleClick : undefined}
            >
              {doc.kind === "markdown" && <MarkdownView blocks={doc.blocks} dir={dirOf(doc.path)} />}
              {doc.kind === "text" && <pre className="rd-text">{doc.text}</pre>}
              {doc.kind === "code" && <CodeFile lang={doc.lang} text={doc.text} />}
            </article>
          )}
          {failed && failed.path === current && (
            <div className="iv-empty">
              <DocumentErrorRegular />
              <span>Doftar can't show this file: {failed.message}</span>
              <button className="iv-btn wide" onClick={openInApp}>
                {defaultApp ? `Open in ${defaultApp}` : "Open in Default App"}
              </button>
            </div>
          )}
        </main>
        {notice && (
          <div className="iv-notice" role="alert">
            {notice}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Whether opening `path` from a document's link could start a program or
 * install something: an app or other package, a file in `NEVER_OPEN`, an
 * alias, or a file that runs when opened. A symlink is judged by what it
 * points to; open_link_target checks that again on the Rust side.
 */
async function launches(path: string): Promise<boolean> {
  if (NEVER_OPEN.has(extOf(path))) return true;
  const [entry] = await api.statEntries([path]).catch(() => []);
  if (!entry) return false;
  if (entry.isPackage || entry.isAlias) return true;
  return api.runsAsProgram(path).catch(() => true);
}

/** Scrolls the heading or footnote `id` to the top; GitHub anchors ignore case. */
function scrollToId(id: string, smooth = true) {
  const el = document.getElementById(id) ?? document.getElementById(id.toLowerCase());
  el?.scrollIntoView({ block: "start", behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
}
