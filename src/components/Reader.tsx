import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeftRegular,
  ArrowRightRegular,
  CheckmarkRegular,
  DocumentErrorRegular,
  EditRegular,
  OpenRegular,
  SaveRegular,
  CodeRegular,
  TextBulletListLtrRegular,
  TextBulletListTreeRegular,
} from "@fluentui/react-icons";
import { api } from "../ipc";
import { CaptionButtons } from "./CaptionButtons";
import { useViewerTheme } from "../hooks/useResolvedTheme";
import { extOf, isDataFile, isSheet, isViewerImage } from "../util/kinds";
import type { ReaderOpen } from "../types";
import { readable } from "../util/readable";
import { resolveHref, textOf } from "./MarkdownView";
import { DocBody, dirOf, docClass, type Doc } from "./DocBody";
import type { EditorControl } from "./TextEditor";

// Load the editor and its languages on the first edit.
const TextEditor = lazy(() => import("./TextEditor"));

const win = getCurrentWindow();
const NOTICE_MS = 4000;
const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];
/** A heading counts as read when it is within this distance of the page top. */
const READING_LINE = 96;
/** Files a document link never opens. They launch, install or set up something, or point elsewhere. */
const NEVER_OPEN = new Set([
  "app", "pkg", "mpkg", "prefpane", "saver", "workflow", "action", "shortcut", "mobileconfig",
  "terminal", "command", "tool", "fileloc", "webloc", "inetloc",
]);

const TEXT_DATA = new Set(["csv", "tsv", "tab", "jsonl", "ndjson", "ipynb"]);

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

interface Trail {
  paths: string[];
  at: number;
}

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The reader window page: Markdown with an outline, wrapped text, or coloured code.
 * Links to documents open here. Web links open in the browser.
 */
export function Reader() {
  const theme = useViewerTheme();
  const [trail, setTrail] = useState<Trail>({ paths: [], at: -1 });
  const [doc, setDoc] = useState<Doc | null>(null);
  const [failed, setFailed] = useState<{ path: string; message: string } | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [zoom, setZoom] = useState(2);
  const [active, setActive] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [defaultApp, setDefaultApp] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [jsonText, setJsonText] = useState(false);
  const [ask, setAsk] = useState<{ then: () => void } | null>(null);
  const [saving, setSaving] = useState(false);
  const editor = useRef<EditorControl | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const current = trail.at >= 0 ? trail.paths[trail.at] : null;
  const currentRef = useRef(current);
  currentRef.current = current;
  const trailRef = useRef(trail);
  trailRef.current = trail;
  const docRef = useRef(doc);
  docRef.current = doc;
  const scroller = useRef<HTMLElement>(null);
  const article = useRef<HTMLElement>(null);
  const scrolls = useRef(new Map<string, number>());
  const pending = useRef<{ path: string; anchor: string | null; top: number } | null>(null);
  /** Set when a document opens into the window. The window shows after the draw. */
  const showOnDraw = useRef(false);

  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);


  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    void api.readerSetDirty(dirty).catch(() => {});
  }, [dirty]);

  /** Run `then` now, or after unsaved edits are saved or dropped. */
  const guard = useCallback((then: () => void) => {
    if (dirtyRef.current) setAsk({ then });
    else then();
  }, []);

  const answer = async (choice: "save" | "discard" | "cancel") => {
    const pending = ask;
    if (!pending) return;
    if (choice === "save") {
      setSaving(true);
      const ok = (await editor.current?.save()) ?? false;
      setSaving(false);
      if (!ok) return setAsk(null);
    }
    setAsk(null);
    if (choice === "cancel") return;
    dirtyRef.current = false;
    setDirty(false);
    await api.readerSetDirty(false).catch(() => {});
    pending.then();
  };

  // Tell the backend what is shown and where the document sits,
  // to fly the file icon back on close.
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

  /** Read the shown document again. `quiet` keeps it as is if unchanged or unreadable. */
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

  // After a document draws: scroll to the asked place and show its window.
  useLayoutEffect(() => {
    const p = pending.current;
    const drawn = doc?.path ?? failed?.path;
    if (!drawn || !p || p.path !== drawn) return;
    pending.current = null;
    const el = scroller.current;
    if (el) el.scrollTop = p.top;
    if (p.anchor) scrollToId(p.anchor, false);
    el?.focus({ preventScroll: true });
    // Do not wait for a frame. A hidden window gets none,
    // so the show would wait for the backend fallback.
    if (showOnDraw.current) {
      showOnDraw.current = false;
      void api.showZoomed().catch(() => {});
    }
  }, [doc, failed]);

  // Listen first, then tell the backend it can send documents here.
  useEffect(() => {
    const open = (path: string, edit = false) =>
      guard(() => {
        showOnDraw.current = true;
        setEditing(edit);
        go(path);
      });
    const unOpen = win.listen<ReaderOpen>("reader:open", ({ payload }) => open(payload.path, payload.edit));
    void unOpen
      .then(() => api.readerReady())
      .then((first) => {
        if (first) open(first.path, first.edit);
      })
      .catch(() => {});
    return () => void unOpen.then((f) => f());
  }, [go, guard]);

  // Closing hides the window (reader.rs). The next document starts fresh.
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
      setEditing(false);
      setDirty(false);
      setAsk(null);
    });
    const unConfirm = win.listen("reader:confirm-close", () => guard(() => void win.close()));
    // Quitting waits while edits exist. After a save or discard, it continues.
    const unQuit = win.listen("reader:confirm-quit", () =>
      guard(() => {
        void api
          .readerSetDirty(false)
          .catch(() => {})
          .finally(() => void api.requestQuit().catch(() => {}));
      })
    );
    return () => {
      for (const un of [unHidden, unConfirm, unQuit]) void un.then((f) => f());
    };
  }, [guard]);

  // Show changes made elsewhere when the window comes back.
  useEffect(() => {
    const unFocus = win.onFocusChanged(({ payload: focused }) => {
      const path = currentRef.current;
      if (focused && path) void load(path, true);
    });
    const unMenu = win.listen<string>("menu", ({ payload }) => {
      const path = currentRef.current;
      // The menu bar takes the editor shortcuts (⌘Z, ⌘A, ⌘[) before the editor sees them.
      if (editingRef.current && payload !== "close_tab") {
        editor.current?.command(payload);
        return;
      }
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
      else if (e.key === "Escape" && !editingRef.current) void win.close();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const outline = useMemo(
    () =>
      (doc?.kind === "markdown"
        ? doc.blocks
        : doc?.kind === "notebook"
          ? doc.cells.flatMap((c) => (c.t === "markdown" ? c.blocks : []))
          : []
      ).flatMap((b) =>
        b.t === "heading" && b.level <= 3 ? [{ id: b.id, level: b.level, text: textOf(b.c) }] : []
      ),
    [doc]
  );

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
      await api.openWebLink(target.url).catch(() => setNotice(`Couldn't open ${target.url}`));
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
    if (await readable(target.path)) go(target.path, target.anchor || null);
    else if (isViewerImage(extOf(target.path))) await api.openImageViewer(target.path, null);
    else if (await launches(target.path)) {
      setNotice(`Doftar doesn't run programs from a document: “${nameOf(target.path)}”`);
    } else {
      // A document link must not start a program. open_link_target
      // also refuses it in Rust, if the check above is wrong.
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

  const hasOutline = outline.length >= 2 && !editing;

  // JSON that parses shows as a tree. JSON with comments stays text.
  const json = useMemo(() => {
    if (doc?.kind !== "code" || doc.lang !== "json") return undefined;
    try {
      return { value: JSON.parse(doc.text) as unknown };
    } catch {
      return undefined;
    }
  }, [doc]);
  const jsonTree = json !== undefined && !jsonText;
  const editable =
    current !== null && !((isDataFile(extOf(current)) || isSheet(extOf(current))) && !TEXT_DATA.has(extOf(current)));

  const startEditing = () => setEditing(true);
  const doneEditing = () =>
    guard(() => {
      setEditing(false);
      if (currentRef.current) void load(currentRef.current, false);
    });
  const saveNow = async () => {
    setSaving(true);
    await editor.current?.save();
    setSaving(false);
  };

  return (
    <div className="md-reader">
      <header className="iv-bar" data-tauri-drag-region>
        <CaptionButtons />
        <button
          className="iv-btn"
          onClick={() => step(-1)}
          disabled={trail.at <= 0 || editing}
          aria-label="Back"
          title="Back (⌘[)"
        >
          <ArrowLeftRegular />
        </button>
        <button
          className="iv-btn"
          onClick={() => step(1)}
          disabled={trail.at >= trail.paths.length - 1 || editing}
          aria-label="Forward"
          title="Forward (⌘])"
        >
          <ArrowRightRegular />
        </button>
        <span className="iv-name" data-tauri-drag-region title={current ?? undefined}>
          {current ? nameOf(current) : "Reader"}
        </span>
        {editing && dirty && <span className="ed-dot" title="Edited" aria-label="Edited" />}
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
          {json !== undefined && !editing && (
            <button
              className="iv-btn wide"
              onClick={() => setJsonText((t) => !t)}
              title={jsonTree ? "Show the JSON text" : "Show the JSON as a tree"}
            >
              {jsonTree ? <CodeRegular /> : <TextBulletListTreeRegular />}
              <span>{jsonTree ? "Text" : "Tree"}</span>
            </button>
          )}
          <span className="iv-sep" />
          {editing ? (
            <>
              <button className="iv-btn wide" onClick={() => void saveNow()} disabled={!dirty || saving} title="Save (⌘S)">
                <SaveRegular />
                <span>{saving ? "Saving…" : "Save"}</span>
              </button>
              <button className="iv-btn wide primary" onClick={doneEditing} title="Back to reading">
                <CheckmarkRegular />
                <span>Done</span>
              </button>
            </>
          ) : (
            <button className="iv-btn wide" onClick={startEditing} disabled={!editable} title="Edit in Doftar">
              <EditRegular />
              <span>Edit</span>
            </button>
          )}
          <span className="iv-sep" />
          <button className="iv-btn wide" onClick={openInApp} disabled={!current} title="Open in the default app">
            <OpenRegular />
            <span>{defaultApp ? `Open in ${defaultApp}` : "Open in Default App"}</span>
          </button>
        </div>
      </header>
      <div className="md-body">
        {editing && current && (
          <Suspense fallback={null}>
            <TextEditor
              key={current}
              path={current}
              fontSize={`${0.857 * ZOOMS[zoom]}rem`}
              control={editor}
              onDirty={setDirty}
              onNotice={setNotice}
            />
          </Suspense>
        )}
        {!editing && hasOutline && outlineOpen && doc && (
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
        <main ref={scroller} className="md-scroll" tabIndex={-1} hidden={editing}>
          {doc && (
            <article
              ref={article}
              key={doc.path}
              className={docClass(doc)}
              style={{ fontSize: `${ZOOMS[zoom]}rem` }}
              onClick={doc.kind === "markdown" || doc.kind === "notebook" ? onArticleClick : undefined}
            >
              <DocBody doc={doc} scale={zoom} tree={jsonTree ? json : undefined} />
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
      {ask && (
        <div className="iv-dialog-scrim">
          <div
            className="iv-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="rd-dialog-title"
            aria-describedby="rd-dialog-text"
          >
            <h2 id="rd-dialog-title">Save changes to “{current ? nameOf(current) : "this file"}”?</h2>
            <p id="rd-dialog-text">Your edits will be lost if you don't save them.</p>
            <div className="iv-dialog-actions">
              <button className="iv-btn wide" onClick={() => void answer("discard")} disabled={saving}>
                Don't Save
              </button>
              <span className="iv-dialog-gap" />
              <button className="iv-btn wide" onClick={() => void answer("cancel")} disabled={saving}>
                Cancel
              </button>
              <button className="iv-btn wide primary" onClick={() => void answer("save")} disabled={saving} autoFocus>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * True if opening `path` from a document link could start a program or install something.
 * This covers an app or package, a `NEVER_OPEN` file, an alias, and a file that runs when opened.
 * A symlink is judged by its target. open_link_target checks again in Rust.
 */
async function launches(path: string): Promise<boolean> {
  if (NEVER_OPEN.has(extOf(path))) return true;
  const [entry] = await api.statEntries([path]).catch(() => []);
  if (!entry) return false;
  if (entry.isPackage || entry.isAlias) return true;
  return api.runsAsProgram(path).catch(() => true);
}

/** Scroll the heading or footnote `id` to the top. GitHub anchors ignore case. */
function scrollToId(id: string, smooth = true) {
  const el = document.getElementById(id) ?? document.getElementById(id.toLowerCase());
  el?.scrollIntoView({ block: "start", behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
}
