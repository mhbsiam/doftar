import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Compartment, EditorSelection, EditorState, type Extension, type Text } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  deleteLineBoundaryBackward,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  indentWithTab,
  redo,
  selectAll,
  undo,
} from "@codemirror/commands";
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  type StreamParser,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import { api } from "../ipc";

export interface EditorControl {
  save: (force?: boolean) => Promise<boolean>;
  /** Runs a command from the menu bar. The menu bar takes its shortcuts first. */
  command: (id: string) => boolean;
}

/** The answer of write_text when the file changed on disk since it was read. */
const CHANGED = "changed-on-disk";

/** Runs one at a time. A call made during a run waits for it, and runs again if `stale` says it missed something. */
export async function joinRun(
  slot: { current: Promise<boolean> | null },
  run: () => Promise<boolean>,
  stale: () => boolean
): Promise<boolean> {
  const joined = slot.current !== null;
  const ok = await (slot.current ??= run().finally(() => {
    slot.current = null;
  }));
  return joined && ok && stale() ? joinRun(slot, run, stale) : ok;
}

const legacy = (load: () => Promise<StreamParser<unknown>>) => async () => StreamLanguage.define(await load());

const LANGS: Record<string, [string, () => Promise<Extension>]> = {};
function lang(name: string, keys: string[], load: () => Promise<Extension>) {
  for (const k of keys) LANGS[k] = [name, load];
}
lang("Markdown", ["md", "markdown", "mdown", "mkd", "mkdn", "mdwn"], () => import("@codemirror/lang-markdown").then((m) => m.markdown()));
lang("Python", ["py", "pyw", "pyi"], () => import("@codemirror/lang-python").then((m) => m.python()));
lang("JavaScript", ["js", "mjs", "cjs", "jsx"], () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })));
lang("TypeScript", ["ts", "mts", "cts", "tsx"], () =>
  import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true }))
);
lang("JSON", ["json", "jsonc"], () => import("@codemirror/lang-json").then((m) => m.json()));
lang("CSS", ["css", "scss", "less"], () => import("@codemirror/lang-css").then((m) => m.css()));
lang("HTML", ["html", "htm"], () => import("@codemirror/lang-html").then((m) => m.html()));
lang("XML", ["xml", "svg", "plist", "xib", "storyboard"], () => import("@codemirror/lang-xml").then((m) => m.xml()));
lang("YAML", ["yaml", "yml"], () => import("@codemirror/lang-yaml").then((m) => m.yaml()));
lang("Rust", ["rs"], () => import("@codemirror/lang-rust").then((m) => m.rust()));
lang("C++", ["c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx"], () => import("@codemirror/lang-cpp").then((m) => m.cpp()));
lang("Java", ["java"], () => import("@codemirror/lang-java").then((m) => m.java()));
lang("Go", ["go"], () => import("@codemirror/lang-go").then((m) => m.go()));
lang("PHP", ["php"], () => import("@codemirror/lang-php").then((m) => m.php()));
lang("SQL", ["sql"], () => import("@codemirror/lang-sql").then((m) => m.sql()));
lang("Shell", ["sh", "bash", "zsh", "ksh", ".zshrc", ".bashrc", ".bash_profile", ".zprofile", ".profile"], legacy(() =>
  import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell)
));
lang("TOML", ["toml"], legacy(() => import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml)));
lang("INI", ["ini", "cfg", "conf", "properties", ".env", ".gitconfig", ".editorconfig"], legacy(() =>
  import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties)
));
lang("Ruby", ["rb", "gemfile", "rakefile"], legacy(() => import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby)));
lang("Swift", ["swift"], legacy(() => import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift)));
lang("Lua", ["lua"], legacy(() => import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua)));
lang("Perl", ["pl", "pm"], legacy(() => import("@codemirror/legacy-modes/mode/perl").then((m) => m.perl)));
lang("R", ["r"], legacy(() => import("@codemirror/legacy-modes/mode/r").then((m) => m.r)));
lang("Diff", ["diff", "patch"], legacy(() => import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff)));
lang("Kotlin", ["kt", "kts"], legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin)));
lang("C#", ["cs"], legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.csharp)));
lang("Objective-C", ["m", "mm"], legacy(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.objectiveC)));
lang("Dockerfile", ["dockerfile"], legacy(() => import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile)));

function langOf(path: string): [string, (() => Promise<Extension>) | null] {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const hit = LANGS[name] ?? (dot > 0 ? LANGS[name.slice(dot + 1)] : undefined);
  return hit ?? ["Plain Text", null];
}

export function detectIndent(text: string, path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "makefile" || name.endsWith(".mk") || name === "go.mod" || name.endsWith(".go")) return "\t";
  let tabs = 0;
  let spaces = 0;
  let step = 0;
  for (const line of text.split("\n", 2000)) {
    if (line.startsWith("\t")) tabs++;
    else {
      const n = /^ +(?=\S)/.exec(line)?.[0].length ?? 0;
      if (n >= 2) {
        spaces++;
        step = step === 0 ? n : Math.min(step, n);
      }
    }
  }
  if (tabs > spaces) return "\t";
  if (step === 2 || step === 4 || step === 8) return " ".repeat(step);
  return /\.(js|jsx|ts|tsx|mjs|cjs|json|ya?ml|md|css|scss|html?|rb)$/.test(name) ? "  " : "    ";
}

const highlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--hl-comment)", fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier, t.self], color: "var(--hl-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.escape], color: "var(--hl-string)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: "var(--hl-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.labelName], color: "var(--hl-title)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName), t.macroName], color: "var(--hl-type)" },
  { tag: [t.propertyName, t.attributeName, t.tagName, t.definition(t.propertyName)], color: "var(--hl-attr)" },
  { tag: [t.meta, t.annotation, t.processingInstruction, t.documentMeta], color: "var(--hl-meta)" },
  { tag: t.heading, color: "var(--hl-title)", fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: [t.quote, t.contentSeparator], color: "var(--hl-comment)" },
  { tag: t.inserted, color: "var(--hl-string)" },
  { tag: t.deleted, color: "var(--hl-keyword)" },
  { tag: t.invalid, color: "var(--danger, #d13438)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "inherit", backgroundColor: "var(--md-page)", color: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', lineHeight: "1.6", overscrollBehavior: "contain" },
  ".cm-content": { padding: "0.857rem 0 40vh", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 1.429rem 0 0.857rem" },
  ".cm-gutters": { backgroundColor: "var(--md-page)", color: "var(--text-3)", border: "none", borderRight: "1px solid var(--md-rule)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 0.571rem 0 1.143rem", minWidth: "2.5em" },
  ".cm-activeLine": { backgroundColor: "var(--ed-line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--ed-line)", color: "var(--text)" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--accent)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--ed-selection) !important",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--ed-match)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--ed-match)", outline: "1px solid var(--border-strong)" },
  ".cm-searchMatch": { backgroundColor: "var(--ed-match)", outline: "1px solid var(--border-strong)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--ed-selection)" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 0.286rem", color: "var(--text-3)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--bg-active)", border: "none", color: "var(--text-2)", padding: "0 0.429rem", borderRadius: "4px" },
  ".cm-panels": { backgroundColor: "var(--bg-card)", color: "var(--text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
});

interface Status {
  line: number;
  col: number;
  selected: number;
}

/**
 * Saves with the file's own encoding and line endings, and a final newline.
 * A save never half-writes.
 */
export default function TextEditor(props: {
  path: string;
  fontSize: string;
  control: MutableRefObject<EditorControl | null>;
  onDirty: (dirty: boolean) => void;
  onNotice: (message: string) => void;
}) {
  const { path, control, onDirty, onNotice } = props;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const saved = useRef<{ doc: Text; rev: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ line: 1, col: 1, selected: 0 });
  const [dirty, setDirty] = useState(false);
  const [savedFlash, setSavedFlash] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [format, setFormat] = useState({ encoding: "UTF-8", crlf: false });
  const [language, load] = langOf(path);
  const indent = useRef("    ");
  const callbacks = useRef({ onDirty, onNotice });
  callbacks.current = { onDirty, onNotice };

  const markDirty = (d: boolean) => {
    setDirty(d);
    callbacks.current.onDirty(d);
  };

  const replaceText = (text: string, rev: string) => {
    const v = view.current;
    if (!v) return;
    const head = Math.min(v.state.selection.main.head, text.length);
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: text },
      selection: EditorSelection.cursor(head),
    });
    saved.current = { doc: v.state.doc, rev };
    markDirty(false);
  };

  const saving = useRef<Promise<boolean> | null>(null);
  const save = (force = false) =>
    joinRun(
      saving,
      () => write(force),
      () => !!view.current && !!saved.current && !view.current.state.doc.eq(saved.current.doc)
    );

  const write = async (force: boolean): Promise<boolean> => {
    const v = view.current;
    const last = saved.current;
    if (!v || !last) return false;
    const doc = v.state.doc;
    const fixes = [];
    if (doc.sliceString(0, 1) === "﻿") fixes.push({ from: 0, to: 1 });
    if (doc.length > 0 && doc.sliceString(doc.length - 1) !== "\n") fixes.push({ from: doc.length, insert: "\n" });
    if (fixes.length) v.dispatch({ changes: fixes });
    const text = v.state.doc;
    try {
      const rev = await api.writeText(path, text.toString(), force ? null : last.rev);
      saved.current = { doc: text, rev };
      markDirty(!v.state.doc.eq(text));
      setConflict(false);
      setSavedFlash((n) => n + 1);
      return true;
    } catch (err) {
      if (String(err) === CHANGED) setConflict(true);
      else callbacks.current.onNotice(`Couldn't save: ${err}`);
      return false;
    }
  };

  const reload = async () => {
    try {
      const file = await api.readText(path);
      replaceText(file.text, file.rev);
      setFormat({ encoding: file.encoding, crlf: file.crlf });
      setConflict(false);
    } catch (err) {
      callbacks.current.onNotice(`Couldn't read the file: ${err}`);
    }
  };

  const saveRef = useRef(save);
  saveRef.current = save;
  control.current = {
    save: (force) => saveRef.current(force),
    command: (id) => {
      const v = view.current;
      if (!v) return false;
      const run = {
        undo,
        redo,
        select_all: selectAll,
        move_to_trash: deleteLineBoundaryBackward,
        back: indentLess,
        forward: indentMore,
      }[id];
      if (!run) return false;
      run(v);
      v.focus();
      return true;
    },
  };

  useLayoutEffect(() => {
    let live = true;
    const language = new Compartment();
    void api
      .readText(path)
      .then(async (file) => {
        if (!live || !host.current) return;
        indent.current = detectIndent(file.text, path);
        setFormat({ encoding: file.encoding, crlf: file.crlf });
        const state = EditorState.create({
          doc: file.text,
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            foldGutter({ markerDOM: (open) => Object.assign(document.createElement("span"), { textContent: open ? "⌄" : "›" }) }),
            highlightSpecialChars(),
            history(),
            drawSelection(),
            dropCursor(),
            EditorState.allowMultipleSelections.of(true),
            indentOnInput(),
            indentUnit.of(indent.current),
            EditorState.tabSize.of(4),
            syntaxHighlighting(highlightStyle),
            bracketMatching(),
            closeBrackets(),
            rectangularSelection(),
            crosshairCursor(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            search({ top: true }),
            EditorView.lineWrapping,
            keymap.of([
              { key: "Mod-s", preventDefault: true, run: () => (void saveRef.current(), true) },
              ...closeBracketsKeymap,
              ...defaultKeymap,
              ...searchKeymap,
              ...historyKeymap,
              ...foldKeymap,
              indentWithTab,
            ]),
            language.of([]),
            theme,
            EditorView.contentAttributes.of({ "aria-label": `Editing ${path.slice(path.lastIndexOf("/") + 1)}`, spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
            EditorView.updateListener.of((u) => {
              if (u.docChanged && saved.current) markDirty(!u.state.doc.eq(saved.current.doc));
              if (u.docChanged || u.selectionSet) {
                const head = u.state.selection.main.head;
                const line = u.state.doc.lineAt(head);
                const selected = u.state.selection.ranges.reduce((n, r) => n + r.to - r.from, 0);
                setStatus({ line: line.number, col: head - line.from + 1, selected });
              }
            }),
          ],
        });
        saved.current = { doc: state.doc, rev: file.rev };
        const v = new EditorView({ state, parent: host.current });
        view.current = v;
        v.focus();
        if (load) {
          const support = await load().catch(() => null);
          if (live && support) v.dispatch({ effects: language.reconfigure(support) });
        }
      })
      .catch((err) => live && setFailed(String(err)));
    return () => {
      live = false;
      view.current?.destroy();
      view.current = null;
      saved.current = null;
      callbacks.current.onDirty(false);
    };
    // The editor is made once per file. `load` follows `path`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Apply the zoom of the reader. The editor measures the text again.
  useEffect(() => view.current?.requestMeasure(), [props.fontSize]);

  // If a file changed elsewhere and has no edits here, show the change on return.
  useEffect(() => {
    const un = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      const last = saved.current;
      if (!focused || !last || !view.current || !view.current.state.doc.eq(last.doc)) return;
      void api
        .readText(path)
        .then((file) => {
          if (file.rev !== last.rev && view.current?.state.doc.eq(last.doc)) {
            replaceText(file.text, file.rev);
            setFormat({ encoding: file.encoding, crlf: file.crlf });
          }
        })
        .catch(() => {});
    });
    return () => void un.then((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  if (failed) {
    return (
      <div className="ed ed-failed">
        <p>Doftar can't edit this file: {failed}</p>
      </div>
    );
  }

  const indentLabel = indent.current === "\t" ? "Tabs" : `Spaces: ${indent.current.length}`;
  return (
    <div className="ed" style={{ fontSize: props.fontSize }}>
      <div ref={host} className="ed-host" />
      <footer className="ed-status" aria-live="polite">
        <span>
          Ln {status.line}, Col {status.col}
          {status.selected > 0 && ` (${status.selected} selected)`}
        </span>
        <span className="ed-status-gap" />
        {savedFlash > 0 && !dirty && (
          <span key={savedFlash} className="ed-saved">
            Saved
          </span>
        )}
        <span>{indentLabel}</span>
        <span>{format.encoding}</span>
        <span title={format.crlf ? "Lines end in CRLF, the Windows way" : "Lines end in LF, the Unix way"}>
          {format.crlf ? "CRLF" : "LF"}
        </span>
        <span>{language}</span>
      </footer>
      {conflict && (
        <div className="iv-dialog-scrim">
          <div className="iv-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ed-conflict-title" aria-describedby="ed-conflict-text">
            <h2 id="ed-conflict-title">“{path.slice(path.lastIndexOf("/") + 1)}” changed on disk</h2>
            <p id="ed-conflict-text">Another app saved this file after you opened it. Keep your version, or load theirs and lose your edits?</p>
            <div className="iv-dialog-actions">
              <button className="iv-btn wide" onClick={() => void reload()}>
                Load Theirs
              </button>
              <span className="iv-dialog-gap" />
              <button className="iv-btn wide" onClick={() => setConflict(false)}>
                Cancel
              </button>
              <button className="iv-btn wide primary" onClick={() => void save(true)} autoFocus>
                Keep Mine
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
