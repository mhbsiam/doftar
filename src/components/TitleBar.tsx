import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { useTabs, locationTitle, usePane, usePanes } from "../stores/tabs";
import { WinFolderIcon } from "./FileIcon";
import { ZOOM_EVENT } from "../hooks/useMenuEvents";
import { useDrag } from "../stores/drag";
import { SPRING, dur } from "../util/motion";
import { beginTabDrag } from "../tabDrag";
import { moveTabToNewWindow } from "../actions";
import { useUI } from "../stores/ui";
import { useIncomingTab } from "../tabTransfer";

/** The caret showing where a tab dragged from another window will land. */
function InsertCaret() {
  const m = useIncomingTab((s) => s.marker);
  // The caret is fixed to the window, so one pane draws it for both.
  if (usePane() !== 0) return null;
  if (!m) return null;
  return <span className="tab-insert" style={{ left: m.x - 1, top: m.top, height: m.height }} />;
}

function openTabMenu(x: number, y: number, id: number) {
  const tabs = useTabs.getState();
  const alone = tabs.tabs.length < 2;
  useUI.getState().openContextMenu(x, y, [
    { key: "new", label: "New tab", shortcut: "⌘T", onSelect: () => useTabs.getState().newTab() },
    {
      key: "window",
      label: "Move to new window",
      disabled: alone,
      onSelect: () => void moveTabToNewWindow(id),
    },
    { key: "close", label: "Close tab", shortcut: "⌘W", dividerBefore: true, onSelect: () => useTabs.getState().closeTab(id) },
  ]);
}

function CloseGlyph() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8">
      <path
        d="M0.7 0.7 L7.3 7.3 M7.3 0.7 L0.7 7.3"
        stroke="currentColor"
        strokeWidth="1"
        fill="none"
      />
    </svg>
  );
}

function MinimizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10">
      <path d="M0 5 H10" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}

function MaximizeGlyph({ restored }: { restored: boolean }) {
  if (restored) {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10">
        <path
          d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5 M0.5 2.5 H7.5 V9.5 H0.5 Z"
          stroke="currentColor"
          strokeWidth="1"
          fill="none"
        />
      </svg>
    );
  }
  return (
    <svg width="10" height="10" viewBox="0 0 10 10">
      <rect
        x="0.5"
        y="0.5"
        width="9"
        height="9"
        stroke="currentColor"
        strokeWidth="1"
        fill="none"
      />
    </svg>
  );
}

// getCurrentWindow() returns a fresh object on every call; resolve it once so
// the resize subscription below isn't torn down and re-created per render.
const win = getCurrentWindow();

function CaptionButtons() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // Moves between halves as split view opens and closes; catch up on mount.
    void win.isMaximized().then(setMaximized).catch(() => {});
    let nudgedFor = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unlisten = win
      .onResized(async () => {
        setMaximized(await win.isMaximized());
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            const s = await win.outerSize();
            const key = `${s.width}x${s.height}`;
            if (key === nudgedFor) return;
            nudgedFor = key;
            await win.setSize(new PhysicalSize(s.width, s.height));
          } catch {
          }
        }, 150);
      });
    return () => {
      if (timer) clearTimeout(timer);
      void unlisten.then((f) => f());
    };
  }, []);

  const toggleMaximize = () =>
    void invoke<boolean>("toggle_maximize_window")
      .then(setMaximized)
      .catch(() => {});

  useEffect(() => {
    const onZoom = () => toggleMaximize();
    window.addEventListener(ZOOM_EVENT, onZoom);
    return () => window.removeEventListener(ZOOM_EVENT, onZoom);
  }, []);

  return (
    <div className="caption-buttons">
      <button
        className="caption"
        title="Minimize"
        aria-label="Minimize"
        onClick={() => void win.minimize()}
      >
        <MinimizeGlyph />
      </button>
      <button
        className="caption"
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={toggleMaximize}
      >
        <MaximizeGlyph restored={maximized} />
      </button>
      <button
        className="caption close"
        title="Close"
        aria-label="Close window"
        onClick={() => void win.close()}
      >
        <CloseGlyph />
      </button>
    </div>
  );
}


function useTabBirth(
  listRef: React.RefObject<HTMLDivElement | null>,
  plusRef: React.RefObject<HTMLButtonElement | null>,
  ids: number[]
) {
  const lefts = useRef<Map<number, number> | null>(null);
  const plusLeft = useRef(0);
  const key = ids.join(",");
  useLayoutEffect(() => {
    const list = listRef.current;
    const plus = plusRef.current;
    if (!list || !plus) return;
    const els = Array.from(list.children) as HTMLElement[];
    const now = new Map<number, number>();
    ids.forEach((id, i) => {
      if (els[i]) now.set(id, els[i].getBoundingClientRect().left);
    });
    const was = lefts.current;
    const plusWas = plusLeft.current;
    const plusNow = plus.getBoundingClientRect().left;
    lefts.current = now;
    plusLeft.current = plusNow;
    if (
      !was ||
      now.size <= was.size ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const birthMs = dur("long");
    const born = ids.findIndex((id) => !was.has(id));
    const baby = els[born];
    if (born < 0 || !baby) return;

    ids.forEach((id, i) => {
      const before = was.get(id);
      const dx = before === undefined ? 0 : before - (now.get(id) ?? before);
      if (Math.abs(dx) > 0.5) {
        els[i].animate(
          [{ transform: `translateX(${dx}px)` }, { transform: "none" }],
          { duration: birthMs, easing: SPRING }
        );
      }
    });
    const dPlus = plusWas - plusNow;
    if (Math.abs(dPlus) > 0.5) {
      plus.animate(
        [{ transform: `translateX(${dPlus}px)` }, { transform: "none" }],
        { duration: birthMs, easing: SPRING }
      );
    }

    baby.animate(
      [
        {
          clipPath: "inset(-4px calc(100% + 4px) -4px -4px round 4px)",
          transform: "translateX(-0.857rem)",
        },
        { clipPath: "inset(-4px -4px -4px -4px round 4px)", transform: "none" },
      ],
      { duration: birthMs, easing: SPRING }
    );
    for (const child of Array.from(baby.children)) {
      child.animate(
        [
          { opacity: 0, transform: "translateX(-1.143rem)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: birthMs - 60, delay: 60, easing: SPRING, fill: "backwards" }
      );
    }
  }, [key]);
}

export function TitleBar() {
  const pane = usePane();
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const dropOver = useDrag((s) => s.overKey);
  const springMs = useDrag((s) => s.springMs);
  // Split view: the window's caption buttons sit at the far right, over the right half.
  const split = usePanes((s) => s.split);
  const focused = usePanes((s) => s.focused === pane);
  const lastPane = !split || pane === 1;
  const listRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  useTabBirth(listRef, plusRef, tabs.map((t) => t.id));

  // Names the window after its open tab, for the Window menu and Mission Control.
  const active = tabs.find((t) => t.id === activeId);
  const title = active ? locationTitle(active.location) : "Doftar";
  useEffect(() => {
    if (focused) void win.setTitle(title).catch(() => {});
  }, [title, focused]);
  const focusActiveTab = () =>
    requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>('.tab[aria-selected="true"]')?.focus()
    );

  return (
    <div className="titlebar">
      <div className="tabs" data-tauri-drag-region>
        <div ref={listRef} className="tablist" role="tablist" aria-label="Folders">
          {tabs.map((t, i) => {
            const isActive = t.id === activeId;
            const dropHere = dropOver === `tab|tab:${t.id}#${pane}`;
            const spring = dropHere && springMs > 0;
            return (
              <div
                key={t.id}
                className={`tab${isActive ? " active" : ""}${dropHere ? " drop-hover" : ""}${spring ? " spring" : ""}`}
                style={spring ? ({ "--wf-spring": `${springMs}ms` } as CSSProperties) : undefined}
                data-drop={`tab|tab:${t.id}`}
                data-tab-id={t.id}
                id={`wf-tab-${t.id}`}
                role="tab"
                aria-selected={isActive}
                aria-controls={`wf-tabpanel-${pane}`}
                tabIndex={isActive ? 0 : -1}
                onMouseDown={(e) => {
                  if (e.button === 0) useTabs.getState().setActive(t.id);
                }}
                onPointerDown={(e) => beginTabDrag(e, t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openTabMenu(e.clientX, e.clientY, t.id);
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) useTabs.getState().closeTab(t.id);
                }}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  const store = useTabs.getState();
                  const move = (to: number) => {
                    e.preventDefault();
                    const next = store.tabs[(to + store.tabs.length) % store.tabs.length];
                    store.setActive(next.id);
                    focusActiveTab();
                  };
                  if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && e.shiftKey && (e.metaKey || e.ctrlKey)) {
                    // ⌘⇧← / ⌘⇧→ move the tab itself along the strip.
                    e.preventDefault();
                    e.stopPropagation();
                    store.moveTab(t.id, i + (e.key === "ArrowRight" ? 1 : -1));
                    focusActiveTab();
                  } else if (e.key === "ArrowRight") move(i + 1);
                  else if (e.key === "ArrowLeft") move(i - 1);
                  else if (e.key === "Home") move(0);
                  else if (e.key === "End") move(store.tabs.length - 1);
                  else if (e.key === "Enter" || e.key === " ") {
                    // Stop here: the window-level shortcuts would otherwise
                    // also open / delete the folder's selection.
                    e.preventDefault();
                    e.stopPropagation();
                    store.setActive(t.id);
                  } else if (e.key === "Delete") {
                    e.preventDefault();
                    e.stopPropagation();
                    store.closeTab(t.id);
                  }
                }}
                title={t.location.kind === "path" ? t.location.path : locationTitle(t.location)}
              >
                <WinFolderIcon size={16} path={t.location.kind === "path" ? t.location.path : undefined} />
                <span className="tab-title" id={`wf-tab-title-${t.id}`}>
                  {locationTitle(t.location)}
                </span>
                <button
                  className="tab-close"
                  title="Close tab"
                  aria-label={`Close ${locationTitle(t.location)}`}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    useTabs.getState().closeTab(t.id);
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <CloseGlyph />
                </button>
              </div>
            );
          })}
        </div>
        <button
          ref={plusRef}
          className="new-tab"
          title="New tab (Ctrl+T)"
          aria-label="New tab"
          onClick={() => useTabs.getState().newTab()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path
              d="M6 1 V11 M1 6 H11"
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
            />
          </svg>
        </button>
        <span data-tauri-drag-region style={{ flex: 1 }} />
      </div>
      {lastPane && <CaptionButtons />}
      <InsertCaret />
    </div>
  );
}
