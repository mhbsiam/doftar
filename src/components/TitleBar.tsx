import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabs, locationTitle, usePane, usePanes, hasClosedTab, reopenClosedTab } from "../stores/tabs";
import { WinFolderIcon, WinKnownFolderIcon, knownFolderKind } from "./FileIcon";
import { CaptionButtons } from "./CaptionButtons";
import { useDrag } from "../stores/drag";
import { SPRING, dur } from "../util/motion";
import { beginTabDrag } from "../tabDrag";
import { moveTabToNewWindow } from "../actions";
import { useUI } from "../stores/ui";
import { useSettings } from "../stores/settings";
import { useIncomingTab } from "../tabTransfer";

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
  const last = tabs.tabs[tabs.tabs.length - 1]?.id === id;
  useUI.getState().openContextMenu(x, y, [
    { key: "new", label: "New tab", onSelect: () => useTabs.getState().newTab() },
    {
      key: "reopen",
      label: "Reopen closed tab",
      disabled: !hasClosedTab(),
      onSelect: () => void reopenClosedTab(),
    },
    {
      key: "window",
      label: "Move to new window",
      disabled: alone,
      onSelect: () => void moveTabToNewWindow(id),
    },
    { key: "close", label: "Close tab", dividerBefore: true, onSelect: () => useTabs.getState().closeTab(id) },
    { key: "others", label: "Close other tabs", disabled: alone, onSelect: () => useTabs.getState().closeOthers(id) },
    { key: "right", label: "Close tabs to the right", disabled: last, onSelect: () => useTabs.getState().closeOthers(id, true) },
  ]);
}

function TabIcon({ path, screenshots }: { path?: string; screenshots: boolean }) {
  const kind = screenshots ? "screenshots" : path ? knownFolderKind(path.slice(path.lastIndexOf("/") + 1)) : null;
  return kind ? <WinKnownFolderIcon kind={kind} size={16} path={path} /> : <WinFolderIcon size={16} path={path} />;
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

const win = getCurrentWindow();

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
    // Runs once per new tab (`key`), not when `ids` gets a new array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export function TitleBar() {
  const pane = usePane();
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const dropOver = useDrag((s) => s.overKey);
  const springMs = useDrag((s) => s.springMs);
  // Split view: the window buttons stay over the half at their side of the window.
  const split = usePanes((s) => s.split);
  const buttonsRight = useSettings((s) => s.windowButtons === "windows");
  const buttonsHere = pane === (split && buttonsRight ? 1 : 0);
  const focused = usePanes((s) => s.focused === pane);
  const listRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  useTabBirth(listRef, plusRef, tabs.map((t) => t.id));

  // Name the window after its open tab, for the Window menu and Mission Control.
  const active = tabs.find((t) => t.id === activeId);
  const title = active ? locationTitle(active.location) : "Doftar";
  useEffect(() => {
    if (focused) void win.setTitle(title).catch(() => {});
  }, [title, focused]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('.tab[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);
  const focusActiveTab = () =>
    requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>('.tab[aria-selected="true"]')?.focus()
    );

  return (
    <div className="titlebar" data-tauri-drag-region>
      {buttonsHere && <CaptionButtons />}
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
                    e.preventDefault();
                    e.stopPropagation();
                    store.moveTab(t.id, i + (e.key === "ArrowRight" ? 1 : -1));
                    focusActiveTab();
                  } else if (e.key === "ArrowRight") move(i + 1);
                  else if (e.key === "ArrowLeft") move(i - 1);
                  else if (e.key === "Home") move(0);
                  else if (e.key === "End") move(store.tabs.length - 1);
                  else if (e.key === "Enter" || e.key === " ") {
                    // Stop here. Otherwise the window-level shortcuts also open or delete the selection of the folder.
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
                <TabIcon
                  path={t.location.kind === "path" ? t.location.path : undefined}
                  screenshots={t.location.kind === "screenshots"}
                />
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
      <InsertCaret />
    </div>
  );
}
