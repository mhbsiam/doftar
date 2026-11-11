import { memo, useMemo } from "react";
import type { ReaderDoc } from "../types";
import { MarkdownView } from "./MarkdownView";
import { BookView, DataGrid, Hdf5View, JsonTree } from "./DataView";
import { NotebookView } from "./NotebookView";
import { highlight } from "./highlight";

const MAX_NUMBERED_LINES = 200_000;

export type Doc = ReaderDoc & { path: string };

export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

const CodeFile = memo(function CodeFile({ lang, text }: { lang: string; text: string }) {
  const body = useMemo(() => highlight(lang, text), [lang, text]);
  const numbers = useMemo(() => {
    let lines = 1;
    for (let i = text.indexOf("\n"); i !== -1 && lines <= MAX_NUMBERED_LINES; i = text.indexOf("\n", i + 1)) {
      if (i < text.length - 1) lines += 1;
    }
    // Millions of short lines stall the window on the gutter alone.
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

export function docClass(doc: Doc): string {
  if (doc.kind === "markdown") return "md-doc";
  if (doc.kind === "notebook") return "md-doc nb-doc";
  return doc.kind === "table" || doc.kind === "hdf5" || doc.kind === "book" ? "rd-doc dv-doc" : "rd-doc";
}

/** `tree` shows parsed JSON as a tree, not as source. */
export function DocBody({ doc, scale, tree }: { doc: Doc; scale: number; tree?: { value: unknown } }) {
  return (
    <>
      {doc.kind === "markdown" && <MarkdownView blocks={doc.blocks} dir={dirOf(doc.path)} />}
      {doc.kind === "notebook" && <NotebookView nb={doc} dir={dirOf(doc.path)} />}
      {doc.kind === "text" && <pre className="rd-text">{doc.text}</pre>}
      {doc.kind === "code" && !tree && <CodeFile lang={doc.lang} text={doc.text} />}
      {tree && <JsonTree value={tree.value} />}
      {doc.kind === "table" && <DataGrid table={doc} scale={scale} />}
      {doc.kind === "hdf5" && <Hdf5View root={doc.root} anndata={doc.anndata} scale={scale} />}
      {doc.kind === "book" && <BookView key={doc.modified} path={doc.path} book={doc} scale={scale} />}
    </>
  );
}

/** The preview bar loads this module only when it first shows a document. */
export default function DocArticle({ doc, tree, className, zoom }: { doc: Doc; tree?: { value: unknown }; className?: string; zoom: number }) {
  return (
    <article className={`${docClass(doc)}${className ? ` ${className}` : ""}`} style={{ fontSize: `${zoom}rem` }}>
      <DocBody doc={doc} scale={zoom} tree={tree} />
    </article>
  );
}
