import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FolderOpenRegular, DeleteRegular } from "@fluentui/react-icons";
import { api } from "../ipc";
import { navigateTo, trashNow } from "../actions";
import { useTabs, baseName, parentOf } from "../stores/tabs";
import { useUI } from "../stores/ui";
import { squarify } from "../util/squarify";
import { formatSize } from "../util/format";
import { dur } from "../util/motion";
import { textScale } from "../util/textScale";
import type { DiskMapNode, Rect } from "../types";

/**
 * The scanned folder as a treemap: each folder, app and big file a block
 * sized by the space it takes, two levels at a time, coloured by the kind of
 * file that fills it. Clicking a folder zooms into it: the view moves in on
 * its block while the next level fades in where it was, and Back reverses
 * that. Drawn on a canvas, so a home folder's worth of blocks stays smooth.
 */

/** A folder's own name strip, above the blocks inside it (CSS pixels). */
const HEADER = 18;
const PAD = 2;
const GAP = 2;
/** A folder this small shows as one block, without the level inside it. */
const MIN_NEST_W = 72;
const MIN_NEST_H = 52;
/** A block shows its name from this size, and its size too from LABEL_H2. */
const LABEL_W = 48;
const LABEL_H = 20;
const LABEL_H2 = 36;

interface Block {
  key: string;
  node: DiskMapNode;
  rect: Rect;
  depth: 1 | 2;
  /** A folder drawn with its own blocks inside it. */
  nested: boolean;
}

type Colors = Record<string, string>;

const keyOf = (n: DiskMapNode, parent: string) => n.path ?? `${parent}\u0000rest`;

/** Lays `node`'s children out in `box`, and theirs inside the folders big enough. */
function layoutMap(node: DiskMapNode, box: Rect): Block[] {
  const out: Block[] = [];
  const kids = node.children ?? [];
  const rects = squarify(
    kids.map((k) => k.bytes),
    box
  );
  kids.forEach((k, i) => {
    const r = rects[i];
    const nested =
      k.kind === "dir" &&
      (k.children?.length ?? 0) > 0 &&
      r.w >= MIN_NEST_W &&
      r.h >= MIN_NEST_H;
    out.push({ key: keyOf(k, node.path ?? ""), node: k, rect: r, depth: 1, nested });
    if (!nested) return;
    const inner = { x: r.x + PAD, y: r.y + HEADER, w: r.w - 2 * PAD, h: r.h - HEADER - PAD };
    const gk = k.children ?? [];
    const gr = squarify(
      gk.map((g) => g.bytes),
      inner
    );
    gk.forEach((g, j) =>
      out.push({ key: keyOf(g, k.path ?? ""), node: g, rect: gr[j], depth: 2, nested: false })
    );
  });
  return out;
}

/** Maps rects in `from` onto `to`, stretching as needed. */
function mapper(from: Rect, to: Rect): (r: Rect) => Rect {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  return (r) => ({ x: to.x + (r.x - from.x) * sx, y: to.y + (r.y - from.y) * sy, w: r.w * sx, h: r.h * sy });
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t),
});
const smooth = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};
/** ease-out-quint */
const settle = (t: number) => 1 - Math.pow(1 - t, 5);

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The colours in effect at `el` (the Disk page sets its own kind colours). */
function readColors(el: Element): Colors {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const out: Colors = {
    bg: v("--bg-card"),
    text: v("--text"),
    accent: v("--accent"),
    border: v("--border"),
  };
  for (const c of ["apps", "images", "video", "audio", "documents", "archives", "code", "other"]) {
    out[c] = v(`--disk-${c}`);
  }
  return out;
}

/** Whether text on `color` (#rgb or #rrggbb) reads better dark than light. */
function isLight(color: string): boolean {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!m) return false;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) > 0.4;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, room: number): string {
  if (ctx.measureText(text).width <= room) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > room) s = s.slice(0, -1);
  return s.length > 1 ? `${s}…` : "";
}

interface Paint {
  blocks: Block[];
  map: (r: Rect) => Rect;
  alpha: number;
}

function draw(
  canvas: HTMLCanvasElement,
  size: { w: number; h: number },
  layers: Paint[],
  hot: { hover: string | null; focus: string | null; showFocus: boolean }
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.w, size.h);
  const colors = readColors(canvas);
  const k = textScale();
  const family = getComputedStyle(document.body).fontFamily;
  ctx.textBaseline = "top";
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, size.w, size.h);
  ctx.clip();

  for (const layer of layers) {
    if (layer.alpha <= 0.001) continue;
    for (const b of layer.blocks) {
      const r = layer.map(b.rect);
      const x = r.x + GAP / 2;
      const y = r.y + GAP / 2;
      const w = r.w - GAP;
      const h = r.h - GAP;
      if (w < 0.5 || h < 0.5 || x > size.w || y > size.h || x + w < 0 || y + h < 0) continue;
      const rest = b.node.kind === "rest";
      const base = colors[b.node.cat] || colors.other;
      const radius = Math.min(4, w / 4, h / 4);
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.fillStyle = base;
      if (b.nested) {
        // A folder holding drawn blocks: a tint of its colour behind them.
        ctx.globalAlpha = layer.alpha * 0.2;
        ctx.fill();
      } else {
        ctx.globalAlpha = layer.alpha * (rest ? 0.38 : 1);
        ctx.fill();
        if (!rest && w > 6 && h > 6) {
          // A soft cushion, lit from the top left, so blocks read as shapes.
          const g = ctx.createLinearGradient(x, y, x + w, y + h);
          g.addColorStop(0, "rgba(255,255,255,0.22)");
          g.addColorStop(0.55, "rgba(255,255,255,0)");
          g.addColorStop(1, "rgba(0,0,0,0.16)");
          ctx.fillStyle = g;
          ctx.fill();
        }
      }

      // Labels at their real size, however the view is stretched.
      const lh = 12 * k;
      if (w >= LABEL_W * k && h >= (b.nested ? HEADER - 2 : LABEL_H * k)) {
        ctx.globalAlpha = layer.alpha;
        const onBlock = !b.nested && !rest;
        ctx.fillStyle = onBlock && !isLight(base) ? "#fbfbfb" : onBlock ? "#1b1b1b" : colors.text;
        ctx.font = `${b.nested || b.depth === 1 ? 600 : 400} ${lh}px ${family}`;
        const room = w - 10;
        const name = ellipsize(ctx, b.node.name, room);
        ctx.fillText(name, x + 5, y + (b.nested ? 3 : 5));
        if (!b.nested && h >= LABEL_H2 * k) {
          ctx.font = `400 ${11 * k}px ${family}`;
          ctx.globalAlpha = layer.alpha * 0.85;
          ctx.fillText(ellipsize(ctx, formatSize(b.node.bytes), room), x + 5, y + 7 + lh);
        }
      }

      const hover = hot.hover === b.key;
      const focus = hot.showFocus && hot.focus === b.key;
      if (hover || focus) {
        ctx.globalAlpha = layer.alpha;
        ctx.lineWidth = 2;
        ctx.strokeStyle = focus ? colors.accent : colors.text;
        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1, w - 2, h - 2, Math.max(0, radius - 1));
        ctx.stroke();
      }
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

type Motion =
  | {
      kind: "zoom";
      /** The level zoomed out of, and the one inside `at`, a block of it. */
      outer: Block[];
      inner: Block[];
      at: Rect;
      /** 1 zooms in; 0 zooms back out. */
      to: 0 | 1;
      start: number;
      ms: number;
    }
  | { kind: "morph"; from: Block[]; to: Block[]; start: number; ms: number };

function frame(m: Motion, box: Rect, now: number): { layers: Paint[]; done: boolean } {
  const raw = Math.min(1, (now - m.start) / m.ms);
  const t = settle(raw);
  if (m.kind === "zoom") {
    const p = m.to === 1 ? t : 1 - t;
    const shown = lerpRect(m.at, box, p);
    return {
      done: raw >= 1,
      layers: [
        { blocks: m.outer, map: mapper(m.at, shown), alpha: 1 - smooth(0.35, 0.95, p) },
        { blocks: m.inner, map: mapper(box, shown), alpha: smooth(0.1, 0.65, p) },
      ],
    };
  }
  // The same blocks glide to where they now go; new ones fade in and gone
  // ones shrink away.
  const before = new Map(m.from.map((b) => [b.key, b]));
  const after = new Set(m.to.map((b) => b.key));
  const moving: Block[] = m.to.map((b) => {
    const was = before.get(b.key);
    return was ? { ...b, rect: lerpRect(was.rect, b.rect, t) } : b;
  });
  const leaving = m.from
    .filter((b) => !after.has(b.key))
    .map((b) => {
      const c = { x: b.rect.x + b.rect.w / 2, y: b.rect.y + b.rect.h / 2, w: 0, h: 0 };
      return { ...b, rect: lerpRect(b.rect, c, t) };
    });
  const id = (r: Rect) => r;
  return {
    done: raw >= 1,
    layers: [
      { blocks: leaving, map: id, alpha: 1 - t },
      { blocks: moving.filter((b) => before.has(b.key)), map: id, alpha: 1 },
      { blocks: moving.filter((b) => !before.has(b.key)), map: id, alpha: t },
    ],
  };
}

/** The level-1 block nearest `from` in the direction of an arrow key. */
function neighbour(blocks: Block[], from: Block, key: string): Block | null {
  const c = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const o = c(from.rect);
  let best: Block | null = null;
  let score = Infinity;
  for (const b of blocks) {
    if (b === from || b.depth !== 1) continue;
    const p = c(b.rect);
    const dx = p.x - o.x;
    const dy = p.y - o.y;
    const along = key === "ArrowRight" ? dx : key === "ArrowLeft" ? -dx : key === "ArrowDown" ? dy : -dy;
    const across = key === "ArrowRight" || key === "ArrowLeft" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 1) continue;
    const s = along + across * 2;
    if (s < score) {
      score = s;
      best = b;
    }
  }
  return best;
}

/**
 * Zoom-outs of the mounted folder maps; each acts only when its map has focus.
 * The "Enclosing Folder" menu item (⌘↑) calls them through `folderMapUp`, as
 * the menu can take the key before the map sees it.
 */
const zoomOuts = new Set<() => boolean>();
export const folderMapUp = () => [...zoomOuts].some((up) => up());

export function FolderMap(props: { root: string; version: number; onForget: (paths: string[]) => void }) {
  const { root, version, onForget } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [path, setPath] = useState(root);
  const [node, setNode] = useState<DiskMapNode | null>(null);
  const [missing, setMissing] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const motion = useRef<Motion | null>(null);
  const raf = useRef(0);
  const busy = useRef(false);

  const box = useMemo(() => ({ x: 0, y: 0, w: size.w, h: size.h }), [size.w, size.h]);
  const blocks = useMemo(() => (node && size.w > 0 ? layoutMap(node, box) : []), [node, box, size.w]);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c || size.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
  }, [size.w, size.h]);

  // A new scan starts the map over at its root.
  useEffect(() => {
    setPath(root);
  }, [root]);

  const load = useCallback((at: string) => api.diskMap(at, 2).catch(() => null), []);

  // Loads the level shown, and again after items leave it (`version`),
  // gliding the blocks to their new places.
  const lastVersion = useRef(version);
  useEffect(() => {
    let live = true;
    void load(path).then((next) => {
      if (!live) return;
      setMissing(!next);
      const reflow = lastVersion.current !== version && node?.path === next?.path;
      lastVersion.current = version;
      if (reflow && next && !reducedMotion() && size.w > 0) {
        motion.current = {
          kind: "morph",
          from: blocksRef.current,
          to: layoutMap(next, box),
          start: performance.now(),
          ms: dur("slow"),
        };
      }
      setNode(next);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, version, load]);

  const hot = useRef({ hover, focus, showFocus: keyboard });
  hot.current = { hover, focus, showFocus: keyboard };

  const paint = useCallback(() => {
    const c = canvasRef.current;
    if (!c || size.w === 0) return;
    const m = motion.current;
    if (m) {
      const { layers, done } = frame(m, box, performance.now());
      draw(c, size, layers, hot.current);
      if (done) {
        motion.current = null;
        busy.current = false;
        raf.current = requestAnimationFrame(paint);
      } else {
        raf.current = requestAnimationFrame(paint);
      }
      return;
    }
    draw(c, size, [{ blocks: blocksRef.current, map: (r) => r, alpha: 1 }], hot.current);
  }, [size, box]);

  useEffect(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf.current);
  }, [paint, blocks, hover, focus, keyboard]);

  // Light and dark change the colours, which the canvas reads as it draws.
  useEffect(() => {
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(paint);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, [paint]);

  const blockAt = (x: number, y: number): Block | null => {
    let hit: Block | null = null;
    for (const b of blocksRef.current) {
      const r = b.rect;
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
        // A block inside a folder wins over the folder; its name strip doesn't.
        if (!hit || b.depth === 2) hit = b;
      }
    }
    return hit;
  };

  /** Zooms into the folder `b`, or out to the level above when `b` is null. */
  const zoom = async (b: Block | null) => {
    if (busy.current || !node) return;
    if (b) {
      if (b.node.kind !== "dir" || !b.node.path) return;
      busy.current = true;
      const next = await load(b.node.path);
      if (!next) {
        busy.current = false;
        return;
      }
      if (!reducedMotion()) {
        motion.current = {
          kind: "zoom",
          outer: blocksRef.current,
          inner: layoutMap(next, box),
          at: b.rect,
          to: 1,
          start: performance.now(),
          ms: dur("long"),
        };
      } else {
        busy.current = false;
      }
      setFocus(null);
      setHover(null);
      setNode(next);
      setPath(b.node.path);
      return;
    }
    const up = parentOf(path);
    if (!up || path === root || !up.startsWith(root)) return;
    busy.current = true;
    const parent = await load(up);
    if (!parent) {
      busy.current = false;
      return;
    }
    const outer = layoutMap(parent, box);
    const was = outer.find((x) => x.node.path === path && x.depth === 1);
    if (was && !reducedMotion()) {
      motion.current = {
        kind: "zoom",
        outer,
        inner: blocksRef.current,
        at: was.rect,
        to: 0,
        start: performance.now(),
        ms: dur("long"),
      };
    } else {
      busy.current = false;
    }
    setFocus(was?.key ?? null);
    setHover(null);
    setNode(parent);
    setPath(up);
  };

  const trash = (b: Block) => {
    const p = b.node.path;
    if (!p) return;
    void trashNow([p]).then(async () => {
      const gone = !(await api.pathExists(p).catch(() => true));
      if (gone) onForget([p]);
    });
  };

  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    const r = canvasRef.current?.getBoundingClientRect();
    const b = r && blockAt(e.clientX - r.left, e.clientY - r.top);
    const p = b?.node.path;
    if (!b || !p) return;
    setFocus(b.key);
    useUI.getState().openContextMenu(e.clientX, e.clientY, [
      ...(b.node.kind === "dir"
        ? [
            { key: "zoom", label: "Zoom in", onSelect: () => void zoom(b) },
            { key: "open", label: "Open folder", onSelect: () => navigateTo({ kind: "path", path: p }) },
          ]
        : []),
      { key: "reveal", label: "Show in folder", onSelect: () => useTabs.getState().reveal(p) },
      { key: "trash", label: "Move to Trash", dividerBefore: true, onSelect: () => trash(b) },
    ]);
  };

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const atRoot = useRef(true);
  atRoot.current = path === root;
  useEffect(() => {
    // At the top there is nothing to zoom out of, so ⌘↑ goes to the enclosing folder.
    const up = () => {
      if (atRoot.current || !canvasRef.current || document.activeElement !== canvasRef.current) return false;
      void zoomRef.current(null);
      return true;
    };
    zoomOuts.add(up);
    return () => void zoomOuts.delete(up);
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    const list = blocksRef.current;
    const cur = list.find((b) => b.key === focus) ?? null;
    // ⌘↑ is checked before the arrows, which would otherwise take it as plain ↑.
    if (e.key === "Backspace" || e.key === "Escape" || (e.key === "ArrowUp" && e.metaKey)) {
      e.preventDefault();
      void zoom(null);
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      setKeyboard(true);
      const first = list.find((b) => b.depth === 1) ?? null;
      const next = cur && cur.depth === 1 ? neighbour(list, cur, e.key) : first;
      if (next) setFocus(next.key);
    } else if (e.key === "Enter" && cur) {
      e.preventDefault();
      if (cur.node.kind === "dir") void zoom(cur);
      else if (cur.node.path) useTabs.getState().reveal(cur.node.path);
    }
  };

  const total = node?.bytes ?? 0;
  const shown = blocks.find((b) => b.key === (hover ?? focus)) ?? null;
  const share = (n: number) => {
    if (total <= 0) return "";
    const p = (n / total) * 100;
    return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
  };
  const describe = (b: Block) => `${b.node.name}, ${formatSize(b.node.bytes)}, ${share(b.node.bytes)} of ${baseName(path) || "/"}`;
  const focused = blocks.find((b) => b.key === focus) ?? null;

  const crumbs: string[] = [];
  for (let p: string | null = path; p && p.startsWith(root); p = p === root ? null : parentOf(p)) {
    crumbs.unshift(p);
  }

  return (
    <section className="disk-card fmap" aria-label="Folder map">
      <div className="fmap-head">
        <h2 className="disk-card-title">Folder map</h2>
        <nav className="fmap-crumbs" aria-label="Folder map level">
          {crumbs.map((c, i) => (
            <span key={c} className="fmap-crumb-wrap">
              {i > 0 && <span className="fmap-sep" aria-hidden>›</span>}
              <button
                className="fmap-crumb"
                disabled={c === path}
                aria-current={c === path ? "location" : undefined}
                onClick={() => {
                  if (c === parentOf(path)) void zoom(null);
                  else setPath(c);
                }}
              >
                {i === 0 ? baseName(c) || c : baseName(c)}
              </button>
            </span>
          ))}
        </nav>
      </div>
      <div ref={wrapRef} className="fmap-stage">
        {missing ? (
          <p className="disk-hint fmap-missing">
            The map comes from a scan in this session. Scan again to see it.
          </p>
        ) : (
          <canvas
            ref={canvasRef}
            className="fmap-canvas"
            tabIndex={0}
            role="img"
            aria-roledescription="folder map"
            aria-label={`Folder map of ${baseName(path) || path}. Arrow keys move between blocks, Enter zooms in, Backspace zooms out.`}
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setHover(blockAt(e.clientX - r.left, e.clientY - r.top)?.key ?? null);
            }}
            onMouseLeave={() => setHover(null)}
            onMouseDown={() => setKeyboard(false)}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const b = blockAt(e.clientX - r.left, e.clientY - r.top);
              if (!b) return;
              setFocus(b.key);
              if (b.node.kind === "dir") void zoom(b);
            }}
            onDoubleClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const b = blockAt(e.clientX - r.left, e.clientY - r.top);
              if (b && b.node.kind !== "dir" && b.node.path) useTabs.getState().reveal(b.node.path);
            }}
            onContextMenu={menu}
            onKeyDown={onKey}
          />
        )}
      </div>
      <div className="fmap-foot">
        <span className="fmap-info">
          {shown ? (
            <>
              <span className="disk-dot" style={{ background: `var(--disk-${shown.node.cat})` }} />
              <span className="fmap-info-name">{shown.node.name}</span>
              <span className="fmap-info-size">
                {formatSize(shown.node.bytes)} · {share(shown.node.bytes)}
              </span>
            </>
          ) : (
            !missing && <span className="fmap-hint">Click a folder to zoom in; Backspace goes back.</span>
          )}
        </span>
        {focused?.node.path && (
          <span className="fmap-actions">
            <button
              className="btn subtle compact"
              onClick={() => focused.node.path && useTabs.getState().reveal(focused.node.path)}
            >
              <FolderOpenRegular className="btn-icon" />
              Show in folder
            </button>
            <button className="btn subtle compact" onClick={() => trash(focused)}>
              <DeleteRegular className="btn-icon" />
              Move to Trash
            </button>
          </span>
        )}
        <span className="fmap-live" aria-live="polite">
          {keyboard && focused ? describe(focused) : ""}
        </span>
      </div>
    </section>
  );
}
