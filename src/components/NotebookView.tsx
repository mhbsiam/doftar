import { memo } from "react";
import type { Notebook, NbOutput } from "../types";
import { MarkdownView } from "./MarkdownView";
import { highlight } from "./highlight";

function imageSrc(o: Extract<NbOutput, { t: "image" }>): string {
  return o.mime === "image/svg+xml"
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(o.data)}`
    : `data:${o.mime};base64,${o.data}`;
}

function Output({ o, dir }: { o: NbOutput; dir: string }) {
  if (o.t === "image") return <img className="nb-img" src={imageSrc(o)} alt="Cell output" />;
  if (o.t === "markdown") return <MarkdownView blocks={o.blocks} dir={dir} />;
  return <pre className={`nb-out${o.error ? " err" : ""}`}>{o.text}</pre>;
}

/** A saved notebook, drawn as saved. Nothing in it runs. */
export const NotebookView = memo(function NotebookView({ nb, dir }: { nb: Notebook; dir: string }) {
  return (
    <>
      {nb.cells.map((cell, i) => {
        if (cell.t === "markdown") return <MarkdownView key={i} blocks={cell.blocks} dir={dir} />;
        if (cell.t === "raw") return <pre key={i} className="nb-raw">{cell.source}</pre>;
        return (
          <section key={i} className="nb-cell">
            <div className="nb-in">
              <span className="nb-count" aria-label={cell.count === null ? "Not run" : `Run ${cell.count}`}>
                [{cell.count ?? " "}]
              </span>
              <pre className="nb-src">
                <code className="hljs">{highlight(nb.lang, cell.source)}</code>
              </pre>
            </div>
            {cell.outputs.length > 0 && (
              <div className="nb-outs">
                {cell.outputs.map((o, j) => (
                  <Output key={j} o={o} dir={dir} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
});
