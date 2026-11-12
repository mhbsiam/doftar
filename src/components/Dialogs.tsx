import { useCallback, useEffect, useRef, useState } from "react";
import { WinFileIcon, WinFolderIcon } from "./FileIcon";
import { useUI } from "../stores/ui";
import { useShallow } from "zustand/react/shallow";
import { useSettings } from "../stores/settings";
import { currentEditors, useEditorChoices, useTerminalChoices, type TerminalApp } from "../stores/terminals";
import { useResolvedTheme } from "../hooks/useResolvedTheme";
import { accentFor } from "../util/accent";
import { TEXT_SCALES } from "../util/textScale";
import { useExitGhost } from "../util/exitGhost";
import { useFileIdsFor } from "../stores/fileIds";
import { FOLDER_COLORS, folderStops, type FolderColorId } from "../util/folderColors";
import { DATE_STYLES, formatSize, formatDate, basename, type DateStyle } from "../util/format";
import { isFolder, typeLabel } from "../util/kinds";
import { parentOf } from "../stores/tabs";
import { useFolderSize } from "../hooks/useFolderSize";
import { useItemInfo } from "../hooks/useItemInfo";
import { formatDuration, formatFps, isMedia, useMedia, useMediaOf } from "../stores/media";
import { clearAppCache, copyText, getViewEntries, openWithOther, renameMany, selectMatching, setAppearance, setTag, transfer, typedPath } from "../actions";
import { nameMatcher } from "../util/itemFilter";
import { rankNames, splitDraft, tabComplete } from "../util/pathComplete";
import { visitBonus } from "../util/palette";
import { useAppData } from "../stores/appdata";
import { useTabs } from "../stores/tabs";
import { api } from "../ipc";
import { planRename, type RenameRule } from "../util/batchRename";
import { SHORTCUTS } from "../util/shortcuts";
import { HELP } from "../util/help";
import { TAG_COLORS, COLOR_TAGS, isColorTag } from "../util/tags";
import type { Checksums, ConflictSide, MetaGroup, FileEntry, Resolution, Resolutions } from "../types";
import { CommandPalette } from "./CommandPalette";

const FOCUSABLE = "button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

function useDialogKeys(onEscape: () => void, onEnter: () => void) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useExitGhost(() => [dialogRef.current?.closest(".overlay")], "dialog");
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    primaryRef.current?.focus();
    return () => {
      if (opener && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onEscape();
      } else if (e.key === "Enter") {
        // Enter on a button presses it. On a checkbox or a dropdown it must not press the default button.
        const t = e.target;
        if (t instanceof HTMLButtonElement || t instanceof HTMLSelectElement) return;
        if (t instanceof HTMLInputElement && t.type === "checkbox") return;
        e.stopPropagation();
        onEnter();
      } else if (e.key === "Tab") {
        const items = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (!items || items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (!dialogRef.current?.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onEscape, onEnter]);
  return { primaryRef, dialogRef };
}

export function DialogHost() {
  const confirm = useUI((s) => s.confirm);
  const properties = useUI((s) => s.properties);
  const conflictSpec = useUI((s) => s.conflictSpec);
  const newTagFor = useUI((s) => s.newTagFor);
  const batchRename = useUI((s) => s.batchRename);
  const selectPatternOpen = useUI((s) => s.selectPatternOpen);
  const sendTo = useUI((s) => s.sendTo);
  const shortcutsOpen = useUI((s) => s.shortcutsOpen);
  const settingsOpen = useUI((s) => s.settingsOpen);
  const helpOpen = useUI((s) => s.helpOpen);
  const paletteOpen = useUI((s) => s.paletteOpen);

  return (
    <>
      {confirm && <ConfirmDialog key="confirm" />}
      {conflictSpec && <ConflictDialog key={`conflicts-${conflictSpec.id}`} />}
      {properties && <PropertiesDialog key="props" />}
      {newTagFor && <NewTagDialog key="new-tag" />}
      {batchRename && <BatchRenameDialog key="batch-rename" />}
      {selectPatternOpen && <SelectPatternDialog key="select-pattern" />}
      {sendTo && <SendToDialog key="send-to" />}
      {shortcutsOpen && <ShortcutsDialog key="shortcuts" />}
      {settingsOpen && <SettingsDialog key="settings" />}
      {helpOpen && <HelpDialog key="help" />}
      {paletteOpen && <CommandPalette key="palette" />}
    </>
  );
}

function ConfirmDialog() {
  const confirm = useUI((s) => s.confirm)!;
  const close = useUI((s) => s.closeConfirm);
  const cancel = useCallback(() => {
    confirm.onCancel?.();
    close();
  }, [confirm, close]);
  const { primaryRef, dialogRef } = useDialogKeys(cancel, () => {
    confirm.onConfirm();
    close();
  });
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div
        ref={dialogRef}
        className="dialog"
        role={confirm.hideCancel ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby="wf-dialog-title"
        aria-describedby="wf-dialog-body"
      >
        <div className="dialog-title" id="wf-dialog-title">{confirm.title}</div>
        <div className="dialog-body" id="wf-dialog-body">{confirm.message}</div>
        <div className="dialog-actions">
          {!confirm.hideCancel && (
            <button className="btn subtle" onClick={cancel}>
              Cancel
            </button>
          )}
          {confirm.alt && (
            <button
              className="btn subtle"
              onClick={() => {
                confirm.alt?.onSelect();
                close();
              }}
            >
              {confirm.alt.label}
            </button>
          )}
          <button
            ref={primaryRef}
            className={`btn accent${confirm.danger ? " danger" : ""}`}
            onClick={() => {
              confirm.onConfirm();
              close();
            }}
          >
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewTagDialog() {
  const entries = useUI((s) => s.newTagFor)!;
  const close = useUI((s) => s.closeNewTag);
  const [name, setName] = useState("");
  const [color, setColor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();
  // A tag cannot have the name of a colour tag (Finder treats it as that tag).
  // The attribute stores each tag as "name\ncolour".
  const problem = !trimmed
    ? null
    : trimmed.includes("\n")
      ? "A tag name can't contain a line break."
      : isColorTag({ name: trimmed, color: 0 })
        ? `“${trimmed}” is a colour tag; pick it from the dots instead.`
        : null;
  const create = () => {
    if (!trimmed || problem) return;
    const tag = { name: trimmed, color };
    useSettings.getState().addCustomTag(tag);
    setTag(entries, tag, true);
    close();
  };
  const { primaryRef, dialogRef } = useDialogKeys(close, create);
  useEffect(() => inputRef.current?.focus(), []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wf-dialog-title"
      >
        <div className="dialog-title" id="wf-dialog-title">New Tag</div>
        <div className="dialog-body new-tag">
          <input
            ref={inputRef}
            className="text-input"
            aria-label="Tag name"
            aria-invalid={problem !== null}
            aria-describedby={problem ? "wf-new-tag-error" : undefined}
            placeholder="Tag name"
            value={name}
            maxLength={128}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
          />
          {problem && (
            <p className="field-error" id="wf-new-tag-error" role="alert">
              {problem}
            </p>
          )}
          <span className="color-picker" role="radiogroup" aria-label="Tag colour">
            <button
              role="radio"
              aria-checked={color === 0}
              title="No colour"
              aria-label="No colour"
              className={`color-swatch tag-none${color === 0 ? " selected" : ""}`}
              onClick={() => setColor(0)}
            />
            {COLOR_TAGS.map((t) => (
              <button
                key={t.color}
                role="radio"
                aria-checked={color === t.color}
                title={t.name}
                aria-label={t.name}
                className={`color-swatch${color === t.color ? " selected" : ""}`}
                style={{ background: TAG_COLORS[t.color] }}
                onClick={() => setColor(t.color)}
              />
            ))}
          </span>
        </div>
        <div className="dialog-actions">
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <button
            ref={primaryRef}
            className="btn accent"
            disabled={!trimmed || problem !== null}
            onClick={create}
          >
            Add Tag
          </button>
        </div>
      </div>
    </div>
  );
}

function SelectPatternDialog() {
  const close = useUI((s) => s.setSelectPatternOpen);
  const [pattern, setPattern] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const test = nameMatcher(pattern);
  const count = test ? getViewEntries().filter((e) => test(e.name)).length : 0;
  const select = () => {
    if (count === 0) return;
    selectMatching(pattern);
    close(false);
  };
  const { primaryRef, dialogRef } = useDialogKeys(() => close(false), select);
  useEffect(() => inputRef.current?.focus(), []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="wf-dialog-title">
        <div className="dialog-title" id="wf-dialog-title">Select by Pattern</div>
        <div className="dialog-body new-tag">
          <input
            ref={inputRef}
            className="text-input"
            aria-label="Name pattern"
            aria-describedby="wf-select-count"
            placeholder="*.csv, report-??"
            value={pattern}
            spellCheck={false}
            onChange={(e) => setPattern(e.target.value)}
          />
          <p className="field-hint" id="wf-select-count" aria-live="polite">
            {test
              ? `${count} of the items shown ${count === 1 ? "matches" : "match"}.`
              : "* is any text, ? is one character. Separate patterns with commas."}
          </p>
        </div>
        <div className="dialog-actions">
          <button className="btn subtle" onClick={() => close(false)}>
            Cancel
          </button>
          <button ref={primaryRef} className="btn accent" disabled={count === 0} onClick={select}>
            Select
          </button>
        </div>
      </div>
    </div>
  );
}

function SendToDialog() {
  const { paths, mode } = useUI((s) => s.sendTo)!;
  const close = useUI((s) => s.closeSendTo);
  const home = useAppData((s) => s.home);
  const favorites = useAppData((s) => s.favorites);
  const recentFolders = useAppData((s) => s.recentFolders);
  const cwd = useTabs((s) => {
    const t = s.tabs.find((t) => t.id === s.activeId);
    return t?.location.kind === "path" ? t.location.path : home;
  });
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [names, setNames] = useState<{ dir: string; list: string[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const parts = draft ? splitDraft(draft, home, cwd) : null;
  const dir = parts?.dir ?? null;
  useEffect(() => {
    if (dir === null) return;
    let stale = false;
    api
      .listDir(dir, false)
      .then((list) => !stale && setNames({ dir, list: list.filter(isFolder).map((e) => e.name) }))
      .catch(() => !stale && setNames(null));
    return () => {
      stale = true;
    };
  }, [dir]);
  const inDir = parts && names?.dir === parts.dir ? names.list : [];
  // Typing lists the folders inside the typed one. Before that, the usual places.
  const rows: { key: string; label: string; detail: string; pick: () => void }[] = parts
    ? rankNames(parts.prefix, inDir).map((n) => ({
        key: n,
        label: n,
        detail: parts.dir,
        pick: () => {
          setDraft(`${parts.typedDir}${n}/`);
          inputRef.current?.focus();
        },
      }))
    : [
        ...favorites.filter((f) => f.isDir !== false),
        ...[...recentFolders].sort((a, b) => visitBonus(b.visits, b.ts, Date.now()) - visitBonus(a.visits, a.ts, Date.now())),
      ]
        .filter((f, i, all) => all.findIndex((x) => x.path === f.path) === i)
        .slice(0, 8)
        .map((f) => ({ key: f.path, label: f.name, detail: f.dirName, pick: () => void send(f.path) }));
  const send = async (target: string) => {
    if (!(await api.isFolder(target).catch(() => false))) {
      setProblem(`Can't find the folder “${target}”.`);
      return;
    }
    close();
    void transfer(mode, paths, target);
  };
  const sendDraft = () => {
    if (draft.trim()) void send(typedPath(draft, cwd));
  };
  const { primaryRef, dialogRef } = useDialogKeys(close, sendDraft);
  useEffect(() => inputRef.current?.focus(), []);
  const verb = mode === "move" ? "Move" : "Copy";
  const what = paths.length === 1 ? `“${basename(paths[0])}”` : `${paths.length} items`;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="wf-dialog-title">
        <div className="dialog-title" id="wf-dialog-title">
          {verb} {what} to…
        </div>
        <div className="dialog-body send-to">
          <input
            ref={inputRef}
            className="text-input"
            aria-label="Destination folder"
            aria-invalid={problem !== null}
            aria-describedby={problem ? "wf-send-error" : undefined}
            placeholder="~/Documents/…  (Tab completes)"
            value={draft}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => {
              setDraft(e.target.value);
              setProblem(null);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Tab" || e.shiftKey || !parts) return;
              const next = tabComplete(parts, inDir);
              if (next === null) return;
              e.preventDefault();
              setDraft(next);
            }}
          />
          {problem && (
            <p className="field-error" id="wf-send-error" role="alert">
              {problem}
            </p>
          )}
          <div className="send-to-list" role="group" aria-label={parts ? "Folders" : "Favorites and frequent folders"}>
            {rows.map((r) => (
              <button key={r.key} className="send-to-row" onClick={r.pick}>
                <WinFolderIcon size={16} />
                <span className="send-to-name">{r.label}</span>
                <span className="send-to-detail">{r.detail}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="dialog-actions">
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <button ref={primaryRef} className="btn accent" disabled={!draft.trim()} onClick={sendDraft}>
            {verb}
          </button>
        </div>
      </div>
    </div>
  );
}

function ShortcutsDialog() {
  const setOpen = useUI((s) => s.setShortcutsOpen);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const { primaryRef, dialogRef } = useDialogKeys(close, close);
  const [windows, setWindows] = useState(false);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={dialogRef}
        className="dialog wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wf-dialog-title"
      >
        <div className="dialog-title">
          <span id="wf-dialog-title">Keyboard shortcuts</span>
          <span className="seg" role="radiogroup" aria-label="Keyboard style">
            {(["Mac", "Windows"] as const).map((label) => (
              <button
                key={label}
                role="radio"
                aria-checked={windows === (label === "Windows")}
                className={windows === (label === "Windows") ? "on" : undefined}
                onClick={() => setWindows(label === "Windows")}
              >
                {label}
              </button>
            ))}
          </span>
        </div>
        <div className="dialog-body shortcuts" tabIndex={0} aria-label="Shortcuts">
          {SHORTCUTS.map(({ group, keys }) => (
            <section key={group}>
              <h3>{group}</h3>
              <dl>
                {keys.map(([what, mac, win]) => (
                  <div key={what}>
                    <dt>{what}</dt>
                    <dd>
                      <kbd>{windows ? (win ?? mac) : mac}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          <p className="rename-note">
            {windows
              ? "Keys with ⌘ have no Windows-style version; on a PC keyboard ⌘ is the Windows key."
              : "Most Windows keys work too, with Ctrl in place of ⌘."}
          </p>
        </div>
        <div className="dialog-actions">
          <button ref={primaryRef} className="btn accent" onClick={close}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function HelpDialog() {
  const setOpen = useUI((s) => s.setHelpOpen);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const { primaryRef, dialogRef } = useDialogKeys(close, close);
  const [at, setAt] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const section = HELP[at];
  const show = (i: number) => {
    setAt(i);
    body.current?.scrollTo(0, 0);
  };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={dialogRef} className="dialog help" role="dialog" aria-modal="true" aria-labelledby="wf-dialog-title">
        <div className="dialog-title">
          <span id="wf-dialog-title">Help</span>
        </div>
        <div className="help-layout">
          <nav className="help-nav" aria-label="Help topics">
            {HELP.map((s, i) => (
              <button key={s.title} aria-current={i === at ? "true" : undefined} onClick={() => show(i)}>
                {s.title}
              </button>
            ))}
          </nav>
          <div ref={body} className="dialog-body help-body" tabIndex={0} aria-label={section.title}>
            <h2>{section.title}</h2>
            {section.topics.map((t) => (
              <section key={t.title}>
                <h3>{t.title}</h3>
                <ul>
                  {t.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                {t.tip && (
                  <p className="help-tip">
                    <strong>Tip:</strong> {t.tip}
                  </p>
                )}
                {t.limits && (
                  <div className="help-limits">
                    <strong>Limits</strong>
                    <ul>
                      {t.limits.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            ))}
          </div>
        </div>
        <div className="dialog-actions">
          <button ref={primaryRef} className="btn accent" onClick={close}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

const RENAME_MODES: [RenameRule["mode"], string][] = [
  ["replace", "Replace text"],
  ["add", "Add text"],
  ["number", "Number"],
  ["case", "Change case"],
];

const CASES: [Extract<RenameRule, { mode: "case" }>["to"], string][] = [
  ["lower", "lowercase"],
  ["upper", "UPPERCASE"],
  ["title", "Title Case"],
];

function BatchRenameDialog() {
  const entries = useUI((s) => s.batchRename)!;
  const close = useUI((s) => s.closeBatchRename);
  const [mode, setMode] = useState<RenameRule["mode"]>("replace");
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [regex, setRegex] = useState(false);
  const [to, setTo] = useState<Extract<RenameRule, { mode: "case" }>["to"]>("lower");
  const [text, setText] = useState("");
  const [where, setWhere] = useState<"before" | "after">("after");
  const first = entries[0];
  const [base, setBase] = useState(() =>
    isFolder(first) || first.name.lastIndexOf(".") <= 0
      ? first.name
      : first.name.slice(0, first.name.lastIndexOf("."))
  );
  const [start, setStart] = useState(1);
  const rule: RenameRule =
    mode === "replace"
      ? { mode, find, replace, matchCase, regex }
      : mode === "add"
        ? { mode, text, where }
        : mode === "case"
          ? { mode, to }
          : { mode, base, start };
  // Ask once about clips and photos, for {camera}, {res} and {fps}.
  useEffect(() => void useMedia.getState().fetch(entries.filter(isMedia).map((e) => e.path)), [entries]);
  const mediaByPath = useMedia((s) => s.byPath);
  useMedia((s) => s.rev);
  const items = entries.map((e) => ({
    name: e.name,
    folder: isFolder(e),
    dir: parentOf(e.path) ?? "",
    modifiedMs: e.modifiedMs,
    media: mediaByPath.get(e.path) ?? null,
  }));
  // The listing shows what is known of each folder. The backend still refuses a name that is taken.
  const taken = (dir: string) =>
    new Set(getViewEntries().filter((e) => parentOf(e.path) === dir).map((e) => e.name));
  const plan = planRename(items, rule, taken);
  const ready = plan.problem === null && plan.changed > 0;
  const run = () => {
    if (!ready) return;
    close();
    void renameMany(entries, plan.names);
  };
  const { primaryRef, dialogRef } = useDialogKeys(close, run);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), [mode]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={dialogRef}
        className="dialog wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wf-dialog-title"
      >
        <div className="dialog-title" id="wf-dialog-title">
          Rename {entries.length} items
        </div>
        <div className="dialog-body batch-rename">
          <span className="seg" role="radiogroup" aria-label="How to rename">
            {RENAME_MODES.map(([m, label]) => (
              <button
                key={m}
                role="radio"
                aria-checked={mode === m}
                className={mode === m ? "on" : undefined}
                onClick={() => setMode(m)}
              >
                {label}
              </button>
            ))}
          </span>
          {mode === "replace" ? (
            <div className="rename-fields">
              <label>
                Find
                <input ref={inputRef} className="text-input" value={find} spellCheck={false} onChange={(e) => setFind(e.target.value)} />
              </label>
              <label>
                Replace with
                <input className="text-input" value={replace} spellCheck={false} onChange={(e) => setReplace(e.target.value)} />
              </label>
              <label className="check">
                <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
                Match case
              </label>
              <label className="check">
                <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
                Regular expression
              </label>
            </div>
          ) : mode === "add" ? (
            <div className="rename-fields">
              <label>
                Text
                <input ref={inputRef} className="text-input" value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
              </label>
              <span className="seg" role="radiogroup" aria-label="Where to add it">
                {(["before", "after"] as const).map((w) => (
                  <button
                    key={w}
                    role="radio"
                    aria-checked={where === w}
                    className={where === w ? "on" : undefined}
                    onClick={() => setWhere(w)}
                  >
                    {w === "before" ? "Before name" : "After name"}
                  </button>
                ))}
              </span>
            </div>
          ) : mode === "case" ? (
            <div className="rename-fields">
              <span className="seg" role="radiogroup" aria-label="Letter case">
                {CASES.map(([c, label]) => (
                  <button
                    key={c}
                    role="radio"
                    aria-checked={to === c}
                    className={to === c ? "on" : undefined}
                    onClick={() => setTo(c)}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </div>
          ) : (
            <div className="rename-fields">
              <label>
                Name
                <input ref={inputRef} className="text-input" value={base} spellCheck={false} onChange={(e) => setBase(e.target.value)} />
              </label>
              <label>
                Start at
                <input
                  className="text-input narrow"
                  type="number"
                  min={0}
                  value={start}
                  onChange={(e) => setStart(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                />
              </label>
            </div>
          )}
          <p className="rename-note">
            {mode === "number"
              ? "Use {n}, {name}, {date}, {folder}, {camera}, {res} and {fps} to build the name. The extension stays as it is."
              : mode === "replace" && regex
                ? "Use $1, $2… in Replace with for the matched groups. The extension stays as it is."
                : "The extension stays as it is."}
          </p>
          {plan.problem && (
            <p className="field-error" role="alert">
              {plan.problem}
            </p>
          )}
          <ul className="rename-preview" aria-label="Preview">
            {entries.slice(0, 200).map((e, i) => (
              <li key={e.path} className={plan.names[i] !== e.name ? "changed" : undefined}>
                <span className="was">{e.name}</span>
                <span aria-hidden>→</span>
                <span className="now">{plan.names[i]}</span>
              </li>
            ))}
            {entries.length > 200 && <li className="more">and {entries.length - 200} more</li>}
          </ul>
        </div>
        <div className="dialog-actions">
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <button ref={primaryRef} className="btn accent" disabled={!ready} onClick={run}>
            {plan.changed > 0 ? `Rename ${plan.changed}` : "Rename"}
          </button>
        </div>
      </div>
    </div>
  );
}

function accessLabel(bits: number): string {
  const r = (bits & 4) !== 0;
  const w = (bits & 2) !== 0;
  const x = (bits & 1) !== 0;
  const base = r && w ? "Read & Write" : r ? "Read only" : w ? "Write only" : "No access";
  return x && (r || w) ? `${base}, execute` : base;
}

function bytesLabel(bytes: number): string {
  return `${formatSize(bytes)}${bytes >= 1024 ? ` (${bytes.toLocaleString()} bytes)` : ""}`;
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="prop-row">
      <span className="prop-label">{label}</span>
      <span className="prop-value">{children}</span>
    </div>
  );
}

const folderPaint = (id: FolderColorId) => `linear-gradient(${folderStops(id)[2]}, ${folderStops(id)[1]})`;

/** One swatch per folder color. `match` adds a first, square swatch that stands for "no color of its own" (null). */
function Swatches({
  label,
  value,
  paint,
  match,
  disabled,
  onPick,
}: {
  label: string;
  /** undefined: nothing is selected, as for folders of different colors. */
  value: FolderColorId | null | undefined;
  paint: (id: FolderColorId) => string;
  match?: { label: string; id: FolderColorId };
  disabled?: boolean;
  onPick: (id: FolderColorId | null, from: Element) => void;
}) {
  const swatch = (id: FolderColorId | null, name: string, color: FolderColorId) => (
    <button
      key={id ?? "match"}
      role="radio"
      aria-checked={value === id}
      title={name}
      aria-label={name}
      disabled={disabled}
      className={`color-swatch${id === null ? " default" : ""}${value === id ? " selected" : ""}`}
      style={{ background: paint(color) }}
      onClick={(e) => onPick(id, e.currentTarget)}
    />
  );
  return (
    <span className="color-picker" role="radiogroup" aria-label={label}>
      {match && swatch(null, match.label, match.id)}
      {FOLDER_COLORS.map((c) => swatch(c.id, c.label, c.id))}
    </span>
  );
}

function Seg<T extends string | number>({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onPick: (value: T, from: Element) => void;
}) {
  return (
    <span className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={v}
          role="radio"
          aria-checked={v === value}
          className={v === value ? "on" : undefined}
          onClick={(e) => onPick(v, e.currentTarget)}
        >
          {text}
        </button>
      ))}
    </span>
  );
}

const OTHER_APP = "other";

function AppSelect({
  label,
  choices,
  appKey,
  extrasKey,
}: {
  label: string;
  choices: { list: TerminalApp[]; def: TerminalApp | null };
  appKey: "terminalApp" | "editorApp";
  extrasKey: "terminalExtras" | "editorExtras";
}) {
  const choose = async (value: string) => {
    const s = useSettings.getState();
    if (value !== OTHER_APP) return s.set({ [appKey]: value });
    const app = await api.pickApplication().catch(() => null);
    if (!app) return;
    // The terminal list leaves out code editors, so such a pick would be saved and never shown.
    if (appKey === "terminalApp" && currentEditors().list.some((t) => t.path === app)) {
      return useUI.getState().pushToast("That app is a code editor. Choose it under Code editor.");
    }
    s.set({ [appKey]: app, [extrasKey]: s[extrasKey].includes(app) ? s[extrasKey] : [...s[extrasKey], app] });
  };
  return (
    <select className="iv-select" aria-label={label} value={choices.def?.path ?? ""} onChange={(e) => void choose(e.target.value)}>
      {!choices.def && (
        <option value="" disabled>
          None found
        </option>
      )}
      {choices.list.map((t) => (
        <option key={t.path} value={t.path}>
          {t.name}
        </option>
      ))}
      <option value={OTHER_APP}>Choose another app…</option>
    </select>
  );
}

type Toggle =
  | "showHidden"
  | "showCheckboxes"
  | "gridItemInfo"
  | "searchContents"
  | "columnStats"
  | "verifyCopies"
  | "swipeNavigation"
  | "externalThumbnails";

function Check({ k, label, note }: { k: Toggle; label: string; note?: string }) {
  const on = useSettings((s) => s[k]);
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => useSettings.getState().set({ [k]: e.target.checked })} />
        {label}
      </label>
      {note && <p className="rename-note">{note}</p>}
    </>
  );
}

const THEMES = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
] as const;
const WINDOW_BUTTONS = [
  ["macos", "macOS"],
  ["windows", "Windows"],
] as const;
const CLOCKS = [
  ["12", "12-hour"],
  ["24", "24-hour"],
] as const;
const TEXT_SIZES = TEXT_SCALES.map((t) => [t.value, t.label] as const);

/** Every preference in one place (⌘,). Each change applies at once, so there is no Cancel. */
function SettingsDialog() {
  const setOpen = useUI((s) => s.setSettingsOpen);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const { primaryRef, dialogRef } = useDialogKeys(close, close);
  const s = useSettings(
    useShallow((s) => ({
      theme: s.theme,
      textScale: s.textScale,
      windowButtons: s.windowButtons,
      folderColor: s.folderColor,
      selectionColor: s.selectionColor,
      dateStyle: s.dateStyle,
      clock: s.clock,
      set: s.set,
    }))
  );
  const mode = useResolvedTheme();
  const terminals = useTerminalChoices();
  const editors = useEditorChoices();
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="wf-dialog-title">
        <div className="dialog-title" id="wf-dialog-title">
          Settings
        </div>
        <div className="dialog-body props settings">
          <h3>Appearance</h3>
          <Row label="Theme">
            <Seg label="Theme" value={s.theme} options={THEMES} onPick={(theme, from) => setAppearance({ theme }, from)} />
          </Row>
          <Row label="Text size">
            <Seg label="Text size" value={s.textScale} options={TEXT_SIZES} onPick={(textScale) => s.set({ textScale })} />
          </Row>
          <Row label="Window buttons">
            <Seg
              label="Window buttons"
              value={s.windowButtons}
              options={WINDOW_BUTTONS}
              onPick={(windowButtons) => s.set({ windowButtons })}
            />
          </Row>
          <Row label="Folder color">
            <Swatches
              label="Folder color"
              value={s.folderColor}
              paint={folderPaint}
              onPick={(id, from) => id && setAppearance({ folderColor: id }, from)}
            />
          </Row>
          <Row label="Selection color">
            <Swatches
              label="Selection color"
              value={s.selectionColor}
              paint={(id) => accentFor(id, mode).vars["--accent"]}
              match={{ label: "Match folder color", id: s.folderColor }}
              onPick={(selectionColor, from) => setAppearance({ selectionColor }, from)}
            />
          </Row>
          <h3>Dates</h3>
          <Row label="Date format">
            <select
              className="iv-select"
              aria-label="Date format"
              value={s.dateStyle}
              onChange={(e) => s.set({ dateStyle: e.target.value as DateStyle })}
            >
              {DATE_STYLES.map(([key, text]) => (
                <option key={key} value={key}>
                  {text}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Clock">
            <Seg label="Clock" value={s.clock} options={CLOCKS} onPick={(clock) => s.set({ clock })} />
          </Row>
          <h3>Open in</h3>
          <Row label="Terminal">
            <AppSelect label="Terminal" choices={terminals} appKey="terminalApp" extrasKey="terminalExtras" />
          </Row>
          <Row label="Code editor">
            <AppSelect label="Code editor" choices={editors} appKey="editorApp" extrasKey="editorExtras" />
          </Row>
          <h3>Files</h3>
          <Check k="showHidden" label="Show hidden files" />
          <Check k="showCheckboxes" label="Show selection checkboxes" />
          <Check k="gridItemInfo" label="Show each file's size in Icons view" />
          <Check k="searchContents" label="Search inside files, not only names" />
          <Check k="columnStats" label="Show min, max and missing counts in data tables" />
          <Check k="swipeNavigation" label="Swipe with two fingers to go back and forward" />
          <Check
            k="verifyCopies"
            label="Verify copies and moves to other drives"
            note="Reads both sides back and compares them. Takes about twice as long."
          />
          <h3>Privacy</h3>
          <Check
            k="externalThumbnails"
            label="Make thumbnails for files on external drives"
            note="When off, a private drive leaves no previews on this Mac."
          />
          <button className="btn subtle" onClick={() => void clearAppCache()}>
            Clear cache
          </button>
        </div>
        <div className="dialog-actions">
          <button ref={primaryRef} className="btn accent" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function FolderColorPicker({ folders }: { folders: FileEntry[] }) {
  const ids = useFileIdsFor(folders);
  const ready = ids.every((id): id is string => !!id);
  const current = useSettings((s) => {
    const set = new Set(ids.map((id) => (id ? (s.folderColors[id] ?? null) : null)));
    return set.size === 1 ? [...set][0] : undefined;
  });
  const setFolderColor = useSettings((s) => s.setFolderColor);
  const globalId = useSettings((s) => s.folderColor);
  const apply = (color: FolderColorId | null) => {
    if (ready) setFolderColor(ids as string[], color);
  };
  return (
    <Swatches
      label="Folder color"
      value={current}
      paint={folderPaint}
      match={{ label: "Default", id: globalId }}
      disabled={!ready}
      onPick={apply}
    />
  );
}

let nextHashJob = 3_000_000;

const CHECKSUM_NAMES: [keyof Checksums, string][] = [
  ["sha256", "SHA-256"],
  ["sha1", "SHA-1"],
  ["md5", "MD5"],
];

function ChecksumRows({ path }: { path: string }) {
  const [state, setState] = useState<{ sums?: Checksums; error?: string; running?: boolean }>({});
  const [expected, setExpected] = useState("");
  const job = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (job.current !== null) void api.cancelSize(job.current).catch(() => {});
    },
    []
  );
  const start = () => {
    const id = nextHashJob++;
    job.current = id;
    setState({ running: true });
    api
      .fileChecksums(path, id)
      .then((sums) => sums && setState({ sums }))
      .catch((err) => setState({ error: String(err) }))
      .finally(() => {
        if (job.current === id) job.current = null;
      });
  };
  const sums = state.sums;
  if (!sums) {
    return (
      <Row label="Checksums">
        {state.running ? (
          <span className="prop-note">Calculating…</span>
        ) : (
          <>
            {state.error && <span className="prop-note">{state.error} </span>}
            <button className="link-btn" onClick={start}>
              Calculate
            </button>
          </>
        )}
      </Row>
    );
  }
  const want = expected.trim().toLowerCase();
  const match = want ? CHECKSUM_NAMES.find(([k]) => sums[k] === want) : undefined;
  return (
    <>
      {CHECKSUM_NAMES.map(([k, label]) => (
        <Row key={k} label={label}>
          <span className={`prop-hash${match?.[0] === k ? " match" : ""}`}>{sums[k]}</span>
          <button
            className="link-btn prop-change"
            onClick={() =>
              void copyText(sums[k]).then((ok) => ok && useUI.getState().pushToast(`Copied ${label}`))
            }
          >
            Copy
          </button>
        </Row>
      ))}
      <Row label="Verify">
        <input
          className="text-input prop-verify"
          placeholder="Paste a checksum to compare"
          aria-label="Checksum to compare"
          spellCheck={false}
          value={expected}
          onChange={(e) => setExpected(e.target.value)}
        />
        {want && (
          <span className={`prop-verdict ${match ? "ok" : "bad"}`} role="status">
            {match ? `Matches ${match[1]}` : "Doesn't match"}
          </span>
        )}
      </Row>
    </>
  );
}

export function MetadataRows({ path }: { path: string }) {
  const [groups, setGroups] = useState<MetaGroup[]>([]);
  useEffect(() => {
    let live = true;
    api
      .itemMetadata(path)
      .then((g) => live && setGroups(g))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path]);
  return groups.map((g) => (
    <details key={g.title} className="prop-meta" open>
      <summary>
        {g.title} <span className="prop-note">{g.rows.length}</span>
      </summary>
      {g.rows.map((r) => (
        <Row key={r.label} label={r.label}>
          {r.dateMs !== null ? formatDate(r.dateMs) : r.text}
        </Row>
      ))}
    </details>
  ));
}

function PropertiesDialog() {
  const entries = useUI((s) => s.properties)!;
  const close = useUI((s) => s.closeProperties);
  const { primaryRef, dialogRef } = useDialogKeys(close, close);
  const single = entries.length === 1 ? entries[0] : null;
  const folders = entries.filter((e) => e.isDir);
  const info = useItemInfo(single ? single.path : null);
  const media = useMediaOf(single && isMedia(single) ? single.path : null);
  useEffect(() => {
    if (single && isMedia(single)) void useMedia.getState().fetch([single.path]);
  }, [single]);
  // Several files are also walked, but only one item's size on disk is looked up.
  const needsWalk = folders.length > 0 || !single;
  const walked = useFolderSize(
    entries.map((e) => e.path),
    needsWalk
  );
  const fileBytes = entries.filter((e) => !e.isDir).reduce((n, e) => n + e.size, 0);
  const total = needsWalk ? (walked ? walked.bytes : null) : fileBytes;
  const onDisk = needsWalk ? (walked ? walked.onDisk : null) : (info?.sizeOnDisk ?? null);
  const parents = new Set(entries.map((e) => parentOf(e.path)));
  const where = parents.size === 1 ? [...parents][0] : "Multiple locations";
  const fileCount = entries.length - entries.filter(isFolder).length;
  const title = single
    ? `${basename(single.path)} Properties`
    : `${entries.length} items Properties`;

  const sizeText = (bytes: number | null, counting: boolean) =>
    bytes === null
      ? "Calculating…"
      : `${bytesLabel(bytes)}${counting && walked && !walked.done ? " …" : ""}`;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={dialogRef}
        className="dialog wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wf-dialog-title"
      >
        <div className="dialog-title" id="wf-dialog-title">
          {single &&
            (isFolder(single) ? (
              <WinFolderIcon size={20} path={single.path} fileId={single.fileId} />
            ) : (
              <WinFileIcon entry={single} size={20} />
            ))}{" "}
          {title}
        </div>
        <div className="dialog-body props" tabIndex={0} aria-label="Details">
          {single ? (
            <>
              <Row label="Name">{single.name}</Row>
              <Row label="Type">{typeLabel(single)}</Row>
              {info?.symlinkTarget && <Row label="Links to">{info.symlinkTarget}</Row>}
            </>
          ) : (
            <Row label="Contains">
              {fileCount > 0 && `${fileCount} file${fileCount === 1 ? "" : "s"}`}
              {fileCount > 0 && entries.length - fileCount > 0 && ", "}
              {entries.length - fileCount > 0 &&
                `${entries.length - fileCount} folder${entries.length - fileCount === 1 ? "" : "s"}`}
            </Row>
          )}
          {entries.every(isFolder) && (
            <Row label="Color">
              <FolderColorPicker folders={entries} />
            </Row>
          )}
          <Row label="Size">{sizeText(total, needsWalk)}</Row>
          <Row label="Size on disk">{sizeText(onDisk, needsWalk)}</Row>
          {needsWalk && walked && (
            <Row label="Inside">
              {walked.files.toLocaleString()} file{walked.files === 1 ? "" : "s"},{" "}
              {walked.folders.toLocaleString()} folder{walked.folders === 1 ? "" : "s"}
              {!walked.done && !walked.cancelled ? " so far" : ""}
              {walked.unreadable > 0 &&
                ` · ${walked.unreadable.toLocaleString()} folder${walked.unreadable === 1 ? "" : "s"} couldn't be read`}
            </Row>
          )}
          <Row label="Where">
            <span className="prop-path">{where}</span>
          </Row>
          {single && (
            <>
              <Row label="Created">{formatDate(info?.createdMs ?? single.createdMs) || "–"}</Row>
              <Row label="Modified">{formatDate(info?.modifiedMs ?? single.modifiedMs) || "–"}</Row>
              {info && <Row label="Opened">{formatDate(info.accessedMs) || "–"}</Row>}
              {info && !isFolder(single) && (
                <Row label="Opens with">
                  {info.defaultApp ? basename(info.defaultApp).replace(/\.app$/, "") : "No default app"}
                  <button
                    className="link-btn prop-change"
                    onClick={() => void openWithOther([single.path])}
                  >
                    Change…
                  </button>
                </Row>
              )}
              {media?.durationS != null && <Row label="Duration">{formatDuration(media.durationS)}</Row>}
              {media?.width && media.height && (
                <Row label="Dimensions">
                  {media.width}×{media.height}
                </Row>
              )}
              {media?.fps && <Row label="Frame rate">{formatFps(media.fps)} fps</Row>}
              {media?.codec && <Row label="Codec">{media.codec}</Row>}
              {media?.camera && <Row label="Camera">{media.camera}</Row>}
              {!single.isDir && <ChecksumRows path={single.path} />}
              {info && (info.whereFroms.length > 0 || info.quarantined) && (
                <Row label="Downloaded">
                  {info.whereFroms.length > 0 ? (
                    <span className="prop-path">{info.whereFroms[0]}</span>
                  ) : (
                    "From the internet"
                  )}
                  {info.quarantined && (
                    <span className="prop-note">
                      {" "}
                      · not yet opened, macOS will check it first
                    </span>
                  )}
                </Row>
              )}
              {info && info.tags.length > 0 && (
                <Row label="Tags">
                  <span className="prop-tags">
                    {info.tags.map((t) => (
                      <span key={t.name} className="prop-tag">
                        {t.color > 0 && (
                          <span
                            className="prop-tag-dot"
                            style={{ background: TAG_COLORS[t.color] }}
                            aria-hidden
                          />
                        )}
                        {t.name}
                      </span>
                    ))}
                  </span>
                </Row>
              )}
              {info && (
                <>
                  <Row label="Owner">
                    {info.owner} — {accessLabel((info.mode >> 6) & 7)}
                  </Row>
                  <Row label="Group">
                    {info.group} — {accessLabel((info.mode >> 3) & 7)}
                  </Row>
                  <Row label="Everyone">{accessLabel(info.mode & 7)}</Row>
                </>
              )}
              <MetadataRows path={single.path} />
            </>
          )}
        </div>
        <div className="dialog-actions">
          <button ref={primaryRef} className="btn accent" onClick={close}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function SideCard({ label, side }: { label: string; side: ConflictSide }) {
  return (
    <div className="conflict-card">
      <span className="conflict-card-label">{label}</span>
      <span className="conflict-card-name">{side.name}</span>
      <span className="conflict-card-meta">
        {side.isDir ? "Folder" : formatSize(side.size)}
        {side.modifiedMs ? ` · Modified ${formatDate(side.modifiedMs)}` : ""}
      </span>
    </div>
  );
}

function ConflictDialog() {
  const spec = useUI((s) => s.conflictSpec)!;
  const close = useUI((s) => s.closeConflicts);
  const { conflicts, resolve } = spec;
  const [index, setIndex] = useState(0);
  const [applyAll, setApplyAll] = useState(false);
  const chosen = useRef<Resolutions>({});
  const current = conflicts[index];
  const remaining = conflicts.length - index;

  const cancel = useCallback(() => {
    resolve(null);
    close();
  }, [resolve, close]);

  const choose = (r: Resolution) => {
    const last = applyAll ? conflicts.length : index + 1;
    for (let i = index; i < last; i++) {
      const c = conflicts[i];
      chosen.current[c.source.path] = r === "replace" && !c.canReplace ? "keepBoth" : r;
    }
    if (last >= conflicts.length) {
      resolve(chosen.current);
      close();
    } else {
      setIndex(last);
    }
  };

  const { primaryRef, dialogRef } = useDialogKeys(cancel, () => choose("keepBoth"));
  const where = basename(parentOf(current.existing.path) ?? "") || "this folder";

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div
        ref={dialogRef}
        className="dialog wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wf-dialog-title"
        aria-describedby="wf-dialog-body"
      >
        <div className="dialog-title" id="wf-dialog-title">
          {current.existing.isDir ? <WinFolderIcon size={20} /> : null}
          {current.existing.isDir ? "A folder" : "A file"} named “{current.existing.name}” already exists
        </div>
        <div className="dialog-body" id="wf-dialog-body">
          <p className="conflict-lede">
            {!current.canReplace
              ? "A file and a folder can't replace each other. Keep both or skip it."
              : `Replacing it moves the existing item in “${where}” to the Trash.`}
          </p>
          <SideCard label="Existing" side={current.existing} />
          <SideCard label="Incoming" side={current.source} />
          {conflicts.length > 1 && (
            <label className="conflict-all">
              <input
                type="checkbox"
                checked={applyAll}
                onChange={(e) => setApplyAll(e.target.checked)}
              />
              Do this for all {remaining} remaining conflicts
            </label>
          )}
        </div>
        <div className="dialog-actions compact">
          <button className="btn subtle" onClick={cancel}>
            Cancel
          </button>
          <button className="btn subtle" onClick={() => choose("skip")}>
            Skip
          </button>
          <button
            className="btn subtle"
            disabled={!current.canReplace}
            onClick={() => choose("replace")}
          >
            Replace
          </button>
          <button ref={primaryRef} className="btn accent" onClick={() => choose("keepBoth")}>
            Keep both
          </button>
        </div>
      </div>
    </div>
  );
}
