import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { FolderRegular, KeyCommandRegular } from "@fluentui/react-icons";
import { runCommand } from "../hooks/useMenuEvents";
import { goToTypedPath, openFile, pasteFromHistory, setTheme, showAbout } from "../actions";
import { copiedAgo, entryLabel, useClipboard } from "../stores/clipboard";
import { useAppData } from "../stores/appdata";
import { focusPane, locationTitle, paneStore, usePanes, useTabs } from "../stores/tabs";
import { useUI } from "../stores/ui";
import { PALETTE_COMMANDS, matchScore, visitBonus } from "../util/palette";

const MAX_RESULTS = 50;

interface Item {
  key: string;
  label: string;
  /** Muted text: the menu of a command, or the parent of a folder. */
  detail: string;
  keys?: string;
  /** Extra search words. */
  also?: string;
  folder?: boolean;
  /** Added to the match score. See `visitBonus`. */
  bonus?: number;
  run: () => void;
}

/** Recent folders listed before anything is typed. The rest appear once a query matches them. */
const IDLE_FOLDERS = 8;

const goTo = (path: string) => () => useTabs.getState().navigate({ kind: "path", path });

export function CommandPalette() {
  const setOpen = useUI((s) => s.setPaletteOpen);
  const favorites = useAppData((s) => s.favorites);
  const recentFolders = useAppData((s) => s.recentFolders);
  const recents = useAppData((s) => s.recents);
  const split = usePanes((s) => s.split);
  // Read once: the palette is modal, so tabs do not change while it is open.
  const openTabs = useMemo(
    () => [0, 1].slice(0, split ? 2 : 1).map((pane) => ({ pane, tabs: paneStore(pane).getState().tabs })),
    [split]
  );
  const history = useClipboard((s) => s.history);
  const inFolder = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.location.kind === "path");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  /** Focus before open. Focus returns to it on close. */
  const back = useRef(document.activeElement as HTMLElement | null);

  const items = useMemo<Item[]>(() => {
    const seen = new Set<string>();
    const folders: Item[] = [];
    const now = Date.now();
    for (const f of favorites.filter((f) => f.isDir !== false)) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      folders.push({ key: `dir:${f.path}`, label: f.name, detail: "Favorite", also: f.dirName, folder: true, run: goTo(f.path) });
    }
    const ranked = recentFolders
      .map((f) => ({ f, bonus: visitBonus(f.visits, f.ts, now) }))
      .sort((a, b) => b.bonus - a.bonus);
    for (const { f, bonus } of ranked) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      folders.push({ key: `dir:${f.path}`, label: f.name, detail: "Recent folder", also: f.dirName, folder: true, bonus, run: goTo(f.path) });
    }
    const clips: Item[] = inFolder
      ? history.map((e) => ({
          key: `clip:${e.paths.join("\0")}`,
          label: `Paste: ${entryLabel(e)}`,
          detail: `Clipboard · ${copiedAgo(e.at)}`,
          also: "clipboard history",
          run: () => void pasteFromHistory(e),
        }))
      : [];
    const commands: Item[] = PALETTE_COMMANDS.map((c) => ({
      key: c.id,
      label: c.label,
      detail: c.group,
      keys: c.keys,
      also: c.also,
      run: () => runCommand(c.id),
    }));
    const extras: Item[] = [
      ...(["light", "dark", "system"] as const).map((t) => ({
        key: `theme:${t}`,
        label: `Theme: ${t[0].toUpperCase()}${t.slice(1)}`,
        detail: "View",
        also: "appearance mode",
        run: () => setTheme(t),
      })),
      { key: "about", label: "About Doftar", detail: "Help", also: "version", run: () => void showAbout() },
    ];
    const files: Item[] = [];
    for (const f of [...favorites.filter((f) => f.isDir === false), ...recents]) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      files.push({ key: `file:${f.path}`, label: f.name, detail: "Recent file", also: f.dirName, run: () => openFile(f.path) });
    }
    const tabItems: Item[] = openTabs.flatMap(({ pane, tabs }) =>
      tabs.map((t) => ({
        key: `tab:${t.id}`,
        label: `Switch to ${locationTitle(t.location)}`,
        detail: openTabs.length > 1 ? (pane === 0 ? "Tab · left" : "Tab · right") : "Tab",
        also: t.location.kind === "path" ? t.location.path : undefined,
        folder: true,
        run: () => {
          focusPane(pane);
          paneStore(pane).getState().setActive(t.id);
        },
      }))
    );
    return [...tabItems, ...folders, ...files, ...clips, ...commands, ...extras];
  }, [favorites, recentFolders, recents, history, inFolder, openTabs]);

  const shown = useMemo(() => {
    const typed = query.trim();
    // A typed path goes first, so Enter jumps there.
    const jump: Item[] = /^(~|\/)/.test(typed)
      ? [{ key: "jump", label: `Go to ${typed}`, detail: "Path", folder: true, run: () => goToTypedPath(typed) }]
      : [];
    if (!typed) {
      let idle = 0;
      return items.filter((i) => i.bonus === undefined || idle++ < IDLE_FOLDERS);
    }
    return [...jump, ...items
      .map((item) => ({
        item,
        score: Math.max(matchScore(query, item.label), matchScore(query, `${item.detail} ${item.also ?? ""}`) - 12),
      }))
      .filter((r) => r.score >= 0)
      .map((r) => ({ item: r.item, score: r.score + (r.item.bonus ?? 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((r) => r.item)];
  }, [items, query]);

  const current = Math.min(active, shown.length - 1);

  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current, shown]);

  const close = () => {
    setOpen(false);
    back.current?.focus({ preventScroll: true });
  };
  // Close first. The command must run on the window, not on the palette.
  const run = (item: Item | undefined) => {
    if (!item) return;
    close();
    item.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = (d: number) => {
      e.preventDefault();
      if (shown.length) setActive((current + d + shown.length) % shown.length);
    };
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) step(1);
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) step(-1);
    else if (e.key === "Enter") {
      e.preventDefault();
      run(shown[current]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-field">
          <KeyCommandRegular />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a command, folder, tab or path"
            spellCheck={false}
            role="combobox"
            aria-expanded="true"
            aria-controls="wf-palette-list"
            aria-activedescendant={shown[current] ? `wf-palette-${current}` : undefined}
          />
        </div>
        <div ref={list} className="palette-list" id="wf-palette-list" role="listbox" aria-label="Commands">
          {shown.map((item, i) => (
            <div
              key={item.key}
              id={`wf-palette-${i}`}
              className="palette-item"
              role="option"
              aria-selected={i === current}
              onMouseMove={() => i !== current && setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(item)}
            >
              {item.folder && <FolderRegular className="palette-icon" />}
              <span className="palette-label">{item.label}</span>
              <span className="palette-detail">{item.folder ? item.also : item.detail}</span>
              {item.keys && <kbd>{item.keys}</kbd>}
            </div>
          ))}
          {shown.length === 0 && <div className="palette-empty">No commands or folders match “{query}”</div>}
        </div>
      </div>
    </div>
  );
}
