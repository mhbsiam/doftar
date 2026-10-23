import { Channel, invoke } from "@tauri-apps/api/core";
import type React from "react";
import { api } from "./ipc";
import { useTabs, baseName, findTab, paneAt, paneStore, parentOf } from "./stores/tabs";
import { useAppData } from "./stores/appdata";
import { useDrag } from "./stores/drag";
import { getViewEntries, showError, transfer, trashNow } from "./actions";
import { absorb } from "./flight";
import type { FileEntry } from "./types";

const THRESHOLD = 4;
const SPRING_TAB_MS = 600;
const SPRING_FOLDER_MS = 800;
const EDGE = 32;
const MAX_SCROLL = 28;

export type DropSpec =
  | { kind: "path"; path: string }
  | { kind: "trash" }
  | { kind: "favs" };

export interface Target {
  key: string;
  surface: string;
  spec: DropSpec;
  /** The pane the target sits in, which a spring-loaded folder opens in. */
  pane: number;
}

function tabFolder(id: number): string | null {
  const tab = findTab(id)?.tab;
  return tab && tab.location.kind === "path" ? tab.location.path : null;
}

/**
 * The open folder as a drop target when the pointer is over the listing's
 * blank background (no `[data-drop]` element under it) and the drop would
 * actually do something there.
 */
function folderUnder(x: number, y: number, paths: string[], copy: boolean): Target | null {
  if (!document.elementFromPoint(x, y)?.closest(".content")) return null;
  // The listing under the pointer, which in a split may be the other half's.
  const pane = paneAt(x, y);
  const path = tabFolder(paneStore(pane).getState().activeId);
  if (!path) return null;
  const spec: DropSpec = { kind: "path", path };
  return canDrop(spec, paths, copy)
    ? { key: `content${pane}|path:${path}`, surface: "content", spec, pane }
    : null;
}

export function resolveAt(x: number, y: number): Target | null {
  const el = document
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>("[data-drop]");
  const raw = el?.dataset.drop;
  if (!raw) return null;
  const bar = raw.indexOf("|");
  const surface = raw.slice(0, bar);
  const spec = raw.slice(bar + 1);
  const pane = paneAt(x, y);
  // The same folder can be a target in both halves; keep them apart.
  const key = `${raw}#${pane}`;
  if (spec.startsWith("path:")) {
    return { key, surface, spec: { kind: "path", path: spec.slice(5) }, pane };
  }
  if (spec.startsWith("tab:")) {
    const path = tabFolder(Number(spec.slice(4)));
    return path ? { key, surface, spec: { kind: "path", path }, pane } : null;
  }
  if (spec === "trash") return { key, surface, spec: { kind: "trash" }, pane };
  if (spec === "favs") return { key, surface, spec: { kind: "favs" }, pane };
  return null;
}

function isInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder === "/" ? "/" : `${folder}/`);
}

export function canDrop(spec: DropSpec, paths: string[], copy: boolean): boolean {
  if (paths.length === 0) return false;
  if (spec.kind === "favs") return paths.some((p) => known.get(p)?.isDir);
  if (spec.kind !== "path") return true;
  const dest = spec.path;
  if (paths.some((p) => isInside(dest, p))) return false;
  if (!copy && paths.every((p) => parentOf(p) === dest)) return false;
  return true;
}

let known = new Map<string, FileEntry>();
export const dragEntry = (path: string) => known.get(path);
/** Entries for paths dragged in from outside the app (native drops). */
export function setDragEntries(entries: FileEntry[]) {
  known = new Map(entries.map((e) => [e.path, e]));
}
export function clearDragEntries() {
  known = new Map();
}

export function isDragHandle(target: HTMLElement): boolean {
  if (target.closest(".gtile")) return true;
  return !!target.closest(".drow") && !!target.closest(".name-text, svg, img, .icon-badged");
}

let hoverKey: string | null = null;
let springTimer: ReturnType<typeof setTimeout> | null = null;
let movesRequest = 0;
let movesFor: { key: string; moves: boolean } | null = null;

function clearSpring() {
  if (springTimer) clearTimeout(springTimer);
  springTimer = null;
  if (useDrag.getState().springMs) useDrag.getState().setOver({ springMs: 0 });
}

export function hoverTarget(target: Target | null, paths: string[], copy: boolean) {
  const store = useDrag.getState();
  if (!target) {
    if (hoverKey !== null) clearSpring();
    hoverKey = null;
    store.setOver({ overKey: null, springMs: 0, blocked: false, label: "", copy });
    return;
  }
  const ok = canDrop(target.spec, paths, copy);
  const changed = target.key !== hoverKey;
  let springMs = changed ? 0 : store.springMs;
  if (changed) {
    clearSpring();
    hoverKey = target.key;
    movesFor = null;
    const spec = target.spec;
    if (ok && (target.surface === "tab" || target.surface === "row") && spec.kind === "path") {
      const open = () => {
        springTimer = null;
        useDrag.getState().setOver({ springMs: 0 });
        if (target.surface === "tab") selectTabAt(target.key);
        else paneStore(target.pane).getState().navigate({ kind: "path", path: spec.path });
      };
      springMs = target.surface === "tab" ? SPRING_TAB_MS : SPRING_FOLDER_MS;
      springTimer = setTimeout(open, springMs);
    }
  }
  const moves = movesFor?.key === target.key ? movesFor.moves : true;
  const verb = (moves: boolean) => (copy || !moves ? "Copy" : "Move");
  const label = (moves: boolean) =>
    target.spec.kind === "trash"
      ? "Move to Trash"
      : target.spec.kind === "favs"
        ? "Add to Favorites"
        : `${verb(moves)} to ${baseName(target.spec.path) || "/"}`;
  store.setOver({
    overKey: ok ? target.key : null,
    springMs,
    blocked: !ok,
    copy: copy || !moves,
    label: ok ? label(moves) : "",
  });
  if (ok && changed && target.spec.kind === "path") {
    const ticket = ++movesRequest;
    const dest = target.spec.path;
    api
      .dropMoves(paths, dest)
      .then((moves) => {
        if (ticket === movesRequest && hoverKey === target.key) {
          movesFor = { key: target.key, moves };
          useDrag.getState().setOver({ label: label(moves), copy: copy || !moves });
        }
      })
      .catch(() => {});
  }
}

function selectTabAt(key: string) {
  const id = parseInt(key.slice(key.indexOf("tab:") + 4), 10);
  if (!Number.isNaN(id)) findTab(id)?.store.setActive(id);
}

export function resetHover() {
  clearSpring();
  hoverKey = null;
  movesFor = null;
  movesRequest++;
}

export function dropOn(spec: DropSpec, paths: string[], copy: boolean) {
  if (!canDrop(spec, paths, copy)) return;
  if (spec.kind === "path") {
    const items = copy ? paths : paths.filter((p) => parentOf(p) !== spec.path);
    if (items.length === 0) return;
    void transfer("drop", items, spec.path, copy);
    return;
  }
  if (spec.kind === "trash") {
    trashNow(paths, { fly: false });
    return;
  }
  const data = useAppData.getState();
  for (const p of paths) {
    const entry = known.get(p);
    if (!entry || !entry.isDir || data.favorites.some((f) => f.path === p)) continue;
    data.toggleFavorite({
      path: p,
      name: entry.name,
      dirName: parentOf(p) ?? "/",
      modifiedMs: entry.modifiedMs,
    });
  }
}

let cancelCurrent: (() => void) | null = null;

const wantsCopy = (e: { altKey: boolean }) => e.altKey;

export function beginPress(e: React.MouseEvent, entry: FileEntry) {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest("input, button, textarea")) return;
  // Only the parts useMarquee skips may start a file drag; everything else on
  // a row is a marquee-start zone, and the two must never run at once.
  if (!isDragHandle(e.target as HTMLElement)) return;
  const additive = e.metaKey || e.ctrlKey || e.shiftKey;
  const startX = e.clientX;
  const startY = e.clientY;
  let active = false;
  let raf = 0;
  let px = startX;
  let py = startY;
  let alt = e.altKey;
  let paths: string[] = [];

  const scroller = (e.currentTarget as HTMLElement).closest<HTMLElement>(".content");

  const loop = () => {
    raf = 0;
    if (!active) return;
    if (scroller) {
      const b = scroller.getBoundingClientRect();
      let dy = 0;
      if (px >= b.left && px <= b.right) {
        if (py < b.top + EDGE && py >= b.top - EDGE) {
          dy = -Math.min(MAX_SCROLL, (b.top + EDGE - py) / 2 + 2);
        } else if (py > b.bottom - EDGE && py <= b.bottom + EDGE) {
          dy = Math.min(MAX_SCROLL, (py - (b.bottom - EDGE)) / 2 + 2);
        }
      }
      if (dy) {
        scroller.scrollTop += dy;
        raf = requestAnimationFrame(loop);
      }
    }
  };

  const begin = () => {
    active = true;
    const tabs = useTabs.getState();
    const cur = tabs.tabs.find((t) => t.id === tabs.activeId);
    const selected = cur?.selection ?? [];
    if (selected.includes(entry.path)) {
      paths = [...selected];
    } else {
      paths = [entry.path];
      if (!additive) tabs.setSelection([entry.path], entry.path);
    }
    const byPath = new Map(getViewEntries().map((x) => [x.path, x]));
    known = new Map(paths.flatMap((p) => (byPath.has(p) ? [[p, byPath.get(p)!] as const] : [])));
    resetHover();
    useDrag.getState().start(paths, px, py);
    document.body.classList.add("dragging-files");
  };

  const outsideWindow = (x: number, y: number) =>
    x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight;

  const onMove = (ev: MouseEvent) => {
    px = ev.clientX;
    py = ev.clientY;
    alt = wantsCopy(ev);
    if (!active) {
      if (Math.hypot(px - startX, py - startY) < THRESHOLD) return;
      begin();
    }
    if (outsideWindow(px, py)) {
      startNativeDrag(paths);
      finish(false);
      return;
    }
    useDrag.getState().move(px, py);
    hoverTarget(resolveAt(px, py) ?? folderUnder(px, py, paths, alt), paths, alt);
    if (!raf) raf = requestAnimationFrame(loop);
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      if (!active) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    }
    else if (ev.key === "Alt") {
      alt = ev.type === "keydown";
      if (active) hoverTarget(resolveAt(px, py), paths, alt);
    }
  };

  const finish = (drop: boolean) => {
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("blur", onCancel);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    cancelCurrent = null;
    if (!active) return;
    const target = drop ? (resolveAt(px, py) ?? folderUnder(px, py, paths, alt)) : null;
    // The ghost goes into what it was dropped on; the listing's background
    // has no one place to go into.
    if (target && target.surface !== "content" && canDrop(target.spec, paths, alt)) {
      const el = document.elementFromPoint(px, py)?.closest("[data-drop]");
      if (el) absorb(el);
    }
    useDrag.getState().end();
    resetHover();
    document.body.classList.remove("dragging-files");
    const swallow = (ev: Event) => ev.stopPropagation();
    window.addEventListener("click", swallow, true);
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (target) dropOn(target.spec, paths, alt);
    known = new Map();
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);

  cancelCurrent?.();
  cancelCurrent = () => finish(false);
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("blur", onCancel);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
}

function dragImage(paths: string[]): string {
  const scale = 2;
  const w = 220;
  const h = 40;
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.scale(scale, scale);
  // Drawn in the current theme so it matches the in-app drag ghost.
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  ctx.fillStyle = token("--menu-solid");
  ctx.strokeStyle = token("--border-strong");
  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, w - 1, h - 1, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = token("--text");
  ctx.font = "13px -apple-system, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  let name = baseName(paths[0]);
  const room = paths.length > 1 ? w - 56 : w - 24;
  while (name.length > 1 && ctx.measureText(name).width > room) {
    name = name.slice(0, -2) + "…";
  }
  ctx.fillText(name, 12, h / 2);
  if (paths.length > 1) {
    ctx.fillStyle = token("--accent-btn");
    ctx.beginPath();
    ctx.roundRect(w - 40, h / 2 - 10, 30, 20, 10);
    ctx.fill();
    ctx.fillStyle = token("--on-accent");
    ctx.textAlign = "center";
    ctx.fillText(String(paths.length), w - 25, h / 2 + 0.5);
  }
  return canvas.toDataURL("image/png");
}

function startNativeDrag(paths: string[]) {
  const image = dragImage(paths);
  if (!image) return;
  invoke("plugin:drag|start_drag", {
    item: paths,
    image,
    options: { mode: "copy" },
    onEvent: new Channel(),
  }).catch(showError);
}

export function cancelDrag() {
  cancelCurrent?.();
}
