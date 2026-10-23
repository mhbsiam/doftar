import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckmarkRegular, ChevronRightRegular } from "@fluentui/react-icons";
import { useUI, type CommandSpec, type MenuItemSpec } from "../stores/ui";
import { useExitGhost } from "../util/exitGhost";

interface Pos {
  left: number;
  top: number;
}

function FloatingMenu(props: {
  x: number;
  y: number;
  className: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos>({ left: props.x, top: props.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(props.x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(props.y, window.innerHeight - r.height - 4)),
    });
  }, [props.x, props.y]);
  return (
    <div
      ref={ref}
      className={props.className}
      style={{ left: pos.left, top: pos.top }}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
    >
      {props.children}
    </div>
  );
}

export function ContextMenuHost() {
  const ctx = useUI((s) => s.contextMenu);
  if (!ctx) return null;
  return (
    <Surface
      x={ctx.x}
      y={ctx.y}
      items={ctx.items}
      commands={ctx.commands}
    />
  );
}

interface Point {
  x: number;
  y: number;
}

function inTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const side = (u: Point, v: Point, w: Point) => (u.x - w.x) * (v.y - w.y) - (v.x - w.x) * (u.y - w.y);
  const d1 = side(p, a, b);
  const d2 = side(p, b, c);
  const d3 = side(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

const ITEM_SELECTOR =
  "[role=menuitem]:not(.disabled), [role=menuitemcheckbox]:not(.disabled), .ctx-cmd:not(:disabled)";

/** Rows of buttons that Left/Right move along: the command bar and colour dots. */
const ROW_ITEM = ".ctx-cmd, .ctx-swatch";

function moveFocus(root: HTMLElement | null, dir: 1 | -1 | "first" | "last") {
  if (!root) return;
  const items = Array.from(root.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (dir === "first") next = 0;
  else if (dir === "last") next = items.length - 1;
  else if (at < 0) next = dir === 1 ? 0 : items.length - 1;
  else next = (at + dir + items.length) % items.length;
  items[next].focus();
}

function Surface(props: {
  x: number;
  y: number;
  items: MenuItemSpec[];
  commands: CommandSpec[];
}) {
  const close = useUI((s) => s.closeContextMenu);
  const [sub, setSub] = useState<{ x: number; y: number; items: MenuItemSpec[] } | null>(null);
  const subCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const subOwner = useRef<HTMLElement | null>(null);
  const focusSubNext = useRef(false);
  const pointer = useRef<{ prev: Point | null; cur: Point | null }>({ prev: null, cur: null });

  useExitGhost(
    () => Array.from(document.querySelectorAll(".ctx-menu:not(.exit-ghost)")),
    "menu"
  );

  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
    return () => {
      const a = document.activeElement;
      if (
        opener &&
        document.contains(opener) &&
        (!a || a === document.body)
      ) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [opener]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (subRef.current) {
          setSub(null);
          subOwner.current?.focus();
        } else {
          close();
        }
      }
    };
    const onCtxMenu = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".ctx-menu")) close();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("contextmenu", onCtxMenu, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("contextmenu", onCtxMenu, true);
    };
  }, [close]);

  useEffect(() => {
    if (sub && focusSubNext.current) {
      focusSubNext.current = false;
      moveFocus(subRef.current, "first");
    }
  }, [sub]);

  const cancelSubClose = () => {
    if (subCloseTimer.current) clearTimeout(subCloseTimer.current);
  };
  const scheduleSubClose = () => {
    cancelSubClose();
    const rect = subRef.current?.getBoundingClientRect();
    const { prev, cur } = pointer.current;
    const aimed =
      rect &&
      prev &&
      cur &&
      inTriangle(
        cur,
        prev,
        { x: rect.left, y: rect.top - 24 },
        { x: rect.left, y: rect.bottom + 24 }
      );
    subCloseTimer.current = setTimeout(() => setSub(null), aimed ? 450 : 250);
  };
  const openSubmenu = (el: HTMLElement, item: MenuItemSpec) => {
    cancelSubClose();
    if (!item.items) return;
    const r = el.getBoundingClientRect();
    const flip = r.right + 240 > window.innerWidth;
    subOwner.current = el;
    setSub({
      x: flip ? r.left - 232 : r.right - 2,
      y: r.top - 5,
      items: item.items,
    });
  };
  const closeSubKeepFocus = () => {
    setSub(null);
    subOwner.current?.focus();
  };

  const runItem = (item: MenuItemSpec) => {
    if (item.disabled) return;
    item.onSelect?.();
    close();
  };

  const renderItems = (items: MenuItemSpec[]) =>
    items.flatMap((item) => {
      const divider = item.dividerBefore ? (
        <div key={`div-${item.key}`} className="ctx-divider" role="separator" />
      ) : null;
      const body = renderItem(item);
      return [divider, body].filter((n): n is React.ReactElement => n !== null);
    });

  const renderItem = (item: MenuItemSpec): React.ReactElement | null => {
      if (item.swatches) {
        return (
          <div key={item.key} className="ctx-swatches" role="group" aria-label={item.label}>
            {item.swatches.map((sw) => (
              <button
                key={sw.key}
                role="menuitemcheckbox"
                aria-checked={sw.state === "mixed" ? "mixed" : sw.state === "on"}
                aria-label={sw.label}
                title={sw.label}
                tabIndex={-1}
                className={`ctx-swatch ${sw.state}`}
                style={{ "--swatch": sw.color } as React.CSSProperties}
                onMouseEnter={scheduleSubClose}
                onClick={() => {
                  sw.onSelect();
                  close();
                }}
              />
            ))}
          </div>
        );
      }
      if (!item.label && !item.items) return null;
      if (item.items) {
        return (
          <div
            key={item.key}
            role="menuitem"
            tabIndex={-1}
            aria-haspopup="menu"
            aria-expanded={sub?.items === item.items}
            data-sub=""
            className="ctx-item"
            onMouseEnter={(e) => openSubmenu(e.currentTarget, item)}
            onClick={(e) => openSubmenu(e.currentTarget, item)}
          >
            <span className="ctx-icon">{item.icon}</span>
            <span className="ctx-label">{item.label}</span>
            <ChevronRightRegular className="ctx-sub-chevron" />
          </div>
        );
      }
      const toggle = typeof item.checked === "boolean";
      return (
        <div
          key={item.key}
          role={toggle ? "menuitemcheckbox" : "menuitem"}
          aria-checked={toggle ? item.checked : undefined}
          tabIndex={-1}
          aria-disabled={item.disabled || undefined}
          className={`ctx-item${item.disabled ? " disabled" : ""}`}
          onMouseEnter={scheduleSubClose}
          onClick={() => runItem(item)}
        >
          <span className="ctx-icon">{item.icon}</span>
          <span className="ctx-label">{item.label}</span>
          {item.checked && <CheckmarkRegular className="ctx-check" />}
        </div>
      );
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveFocus(menuRef.current, 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(menuRef.current, -1);
        break;
      case "Home":
        e.preventDefault();
        moveFocus(menuRef.current, "first");
        break;
      case "End":
        e.preventDefault();
        moveFocus(menuRef.current, "last");
        break;
      case "ArrowRight":
        if (target.hasAttribute("data-sub")) {
          e.preventDefault();
          focusSubNext.current = true;
          target.click();
        } else if (target.matches(ROW_ITEM)) {
          e.preventDefault();
          (target.nextElementSibling as HTMLElement | null)?.focus();
        }
        break;
      case "ArrowLeft":
        if (target.matches(ROW_ITEM)) {
          e.preventDefault();
          (target.previousElementSibling as HTMLElement | null)?.focus();
        }
        break;
      case "Enter":
      case " ":
        if (target.getAttribute("role")?.startsWith("menuitem")) {
          e.preventDefault();
          if (target.hasAttribute("data-sub")) focusSubNext.current = true;
          target.click();
        }
        break;
      case "Tab":
        e.preventDefault();
        break;
    }
  };

  const onSubKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveFocus(subRef.current, 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(subRef.current, -1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        closeSubKeepFocus();
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        (e.target as HTMLElement).click();
        break;
      case "Tab":
        e.preventDefault();
        break;
    }
  };

  return (
    <>
      <div className="ctx-overlay" onMouseDown={close} />
      <FloatingMenu
        x={props.x}
        y={props.y}
        className="ctx-menu"
        onMouseLeave={scheduleSubClose}
      >
        <div
          ref={menuRef}
          role="menu"
          tabIndex={-1}
          aria-label="Context menu"
          onKeyDown={onMenuKeyDown}
          onMouseMove={(e) => {
            const p = pointer.current;
            p.prev = p.cur;
            p.cur = { x: e.clientX, y: e.clientY };
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {props.commands.length > 0 && (
            <>
              <div className="ctx-commands">
                {props.commands.map((c) => (
                  <button
                    key={c.key}
                    className="ctx-cmd"
                    title={c.label}
                    aria-label={c.label}
                    disabled={c.disabled}
                    onClick={() => {
                      if (c.disabled) return;
                      c.onSelect?.();
                      close();
                    }}
                  >
                    {c.icon}
                  </button>
                ))}
              </div>
              <div className="ctx-divider" role="separator" />
            </>
          )}
          {renderItems(props.items)}
        </div>
      </FloatingMenu>
      {sub && (
        <FloatingMenu
          x={sub.x}
          y={sub.y}
          className="ctx-menu ctx-submenu"
          onMouseEnter={cancelSubClose}
          onMouseLeave={scheduleSubClose}
        >
          <div ref={subRef} role="menu" tabIndex={-1} onKeyDown={onSubKeyDown}>
            {renderItems(sub.items)}
          </div>
        </FloatingMenu>
      )}
    </>
  );
}
