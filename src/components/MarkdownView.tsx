import { memo, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  CheckmarkRegular,
  CopyRegular,
  ErrorCircleRegular,
  ImageRegular,
  ImportantRegular,
  InfoRegular,
  LightbulbRegular,
  WarningRegular,
} from "@fluentui/react-icons";
import type { MdNode } from "../types";
import { highlight } from "./highlight";

/** Where a link or image in a document points. */
export type Target =
  | { kind: "anchor"; id: string }
  | { kind: "web"; url: string }
  | { kind: "file"; path: string; anchor: string };

/** `path` with `.` and `..` worked out, as an absolute path. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Resolves `href` written in a document in the folder `dir`. */
export function resolveHref(href: string, dir: string): Target | null {
  const h = href.trim();
  if (h.startsWith("#")) return { kind: "anchor", id: decode(h.slice(1)) };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(h)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto") return { kind: "web", url: h };
  if (scheme === "file") {
    try {
      const url = new URL(h);
      return { kind: "file", path: decode(url.pathname), anchor: decode(url.hash.slice(1)) };
    } catch {
      return null;
    }
  }
  // Any other scheme (javascript:, data:, app links) goes nowhere.
  if (scheme) return null;
  const hash = h.indexOf("#");
  const anchor = hash >= 0 ? decode(h.slice(hash + 1)) : "";
  const rel = decode((hash >= 0 ? h.slice(0, hash) : h).split("?")[0]);
  if (!rel) return null;
  return { kind: "file", path: normalize(rel.startsWith("/") ? rel : `${dir}/${rel}`), anchor };
}

/** The plain text of `nodes`. */
export function textOf(nodes: MdNode[]): string {
  return nodes
    .map((n) => {
      if ("v" in n) return n.v;
      if (n.t === "image") return n.alt;
      return "c" in n ? textOf(n.c) : "";
    })
    .join("");
}

/** Footnotes numbered in the order they are first referred to. */
function numberFootnotes(nodes: MdNode[], out = new Map<string, number>()) {
  for (const n of nodes) {
    if (n.t === "footnoteRef" && !out.has(n.label)) out.set(n.label, out.size + 1);
    else if ("c" in n) numberFootnotes(n.c, out);
  }
  return out;
}

const CodeBlock = memo(function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const code = text.endsWith("\n") ? text.slice(0, -1) : text;
  const body = useMemo(() => highlight(lang, code), [lang, code]);
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <figure className="md-code">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang || "text"}</span>
        <button className="md-code-copy" onClick={copy} title="Copy code">
          {copied ? <CheckmarkRegular /> : <CopyRegular />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre>
        <code className="hljs">{body}</code>
      </pre>
    </figure>
  );
});

const ALERTS = {
  note: { title: "Note", icon: <InfoRegular /> },
  tip: { title: "Tip", icon: <LightbulbRegular /> },
  important: { title: "Important", icon: <ImportantRegular /> },
  warning: { title: "Warning", icon: <WarningRegular /> },
  caution: { title: "Caution", icon: <ErrorCircleRegular /> },
};

function Picture({
  node,
  dir,
  linked,
}: {
  node: Extract<MdNode, { t: "image" }>;
  dir: string;
  /** Inside a link, which a click follows instead (a badge). */
  linked: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const target = resolveHref(node.src, dir);
  const label = node.alt || node.title || "Image";
  const inline = node.src.startsWith("data:image/");
  // Doftar never goes online, so web images show as a link instead.
  if (!inline && (failed || !target || target.kind !== "file")) {
    const url = target?.kind === "web" ? target.url : undefined;
    if (linked) {
      return (
        <span className="md-img-missing">
          <ImageRegular />
          {label}
        </span>
      );
    }
    return (
      <a
        className="md-img-missing"
        href={url ?? "#"}
        data-href={url}
        title={url ? `Image from ${url}` : "Doftar can't show this image"}
      >
        <ImageRegular />
        {label}
      </a>
    );
  }
  return (
    <img
      src={inline ? node.src : convertFileSrc((target as { path: string }).path)}
      alt={node.alt}
      title={node.title || undefined}
      width={node.width ?? undefined}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

interface Ctx {
  dir: string;
  notes: Map<string, number>;
  /** Drawing a link's contents. */
  inLink?: boolean;
}

function Nodes({ nodes, ctx }: { nodes: MdNode[]; ctx: Ctx }) {
  return (
    <>
      {nodes.map((n, i) => (
        <Node key={i} node={n} ctx={ctx} />
      ))}
    </>
  );
}

function Node({ node: n, ctx }: { node: MdNode; ctx: Ctx }): ReactNode {
  switch (n.t) {
    case "para":
      return (
        <p>
          <Nodes nodes={n.c} ctx={ctx} />
        </p>
      );
    case "heading": {
      const H = `h${Math.min(6, Math.max(1, n.level))}` as "h1";
      return (
        <H id={n.id}>
          <Nodes nodes={n.c} ctx={ctx} />
          <a
            className="md-anchor"
            href={`#${n.id}`}
            data-href={`#${n.id}`}
            aria-label="Link to this section"
          >
            #
          </a>
        </H>
      );
    }
    case "code":
      return <CodeBlock lang={n.lang} text={n.text} />;
    case "quote": {
      if (!n.kind) {
        return (
          <blockquote>
            <Nodes nodes={n.c} ctx={ctx} />
          </blockquote>
        );
      }
      const a = ALERTS[n.kind];
      return (
        <div className={`md-alert ${n.kind}`} role="note">
          <p className="md-alert-title">
            {a.icon}
            {a.title}
          </p>
          <Nodes nodes={n.c} ctx={ctx} />
        </div>
      );
    }
    case "list": {
      const tasks = n.c.some((i) => i.t === "item" && i.task !== null);
      const cls = tasks ? "md-tasks" : undefined;
      return n.start !== null ? (
        <ol start={n.start} className={cls}>
          <Nodes nodes={n.c} ctx={ctx} />
        </ol>
      ) : (
        <ul className={cls}>
          <Nodes nodes={n.c} ctx={ctx} />
        </ul>
      );
    }
    case "item":
      return (
        <li className={n.task !== null ? "md-task" : undefined}>
          {n.task !== null && (
            <input type="checkbox" checked={n.task} disabled aria-label={n.task ? "Done" : "Not done"} />
          )}
          <Nodes nodes={n.c} ctx={ctx} />
        </li>
      );
    case "table": {
      const [head, ...rows] = n.c;
      const cells = (row: MdNode, Cell: "th" | "td") =>
        "c" in row &&
        row.c.map((cell, j) => (
          <Cell key={j} style={n.align[j] ? { textAlign: n.align[j] } : undefined}>
            {"c" in cell && <Nodes nodes={cell.c} ctx={ctx} />}
          </Cell>
        ));
      return (
        <div className="md-table">
          <table>
            {head && (
              <thead>
                <tr>{cells(head, "th")}</tr>
              </thead>
            )}
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>{cells(row, "td")}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "head":
    case "row":
    case "cell":
      return <Nodes nodes={n.c} ctx={ctx} />;
    case "rule":
      return <hr />;
    case "footnoteDef":
      // Gathered at the end of the document instead.
      return null;
    case "meta":
      return (
        <details className="md-meta">
          <summary>Front matter</summary>
          <pre>{n.text}</pre>
        </details>
      );
    case "htmlBlock":
      return (
        <p className={`md-html${n.center ? " center" : ""}`}>
          <Nodes nodes={n.c} ctx={ctx} />
        </p>
      );
    case "displayMath":
      return <pre className="md-math-block">{n.v}</pre>;
    case "text":
      return n.v;
    case "inlineCode":
      return <code>{n.v}</code>;
    case "inlineMath":
      return <code className="md-math">{n.v}</code>;
    case "emph":
      return (
        <em>
          <Nodes nodes={n.c} ctx={ctx} />
        </em>
      );
    case "strong":
      return (
        <strong>
          <Nodes nodes={n.c} ctx={ctx} />
        </strong>
      );
    case "strike":
      return (
        <del>
          <Nodes nodes={n.c} ctx={ctx} />
        </del>
      );
    case "sup":
      return (
        <sup>
          <Nodes nodes={n.c} ctx={ctx} />
        </sup>
      );
    case "sub":
      return (
        <sub>
          <Nodes nodes={n.c} ctx={ctx} />
        </sub>
      );
    case "kbd":
      return (
        <kbd>
          <Nodes nodes={n.c} ctx={ctx} />
        </kbd>
      );
    case "link":
      return (
        <a href={n.href} data-href={n.href} title={n.title || n.href}>
          <Nodes nodes={n.c} ctx={ctx.inLink ? ctx : { ...ctx, inLink: true }} />
        </a>
      );
    case "image":
      return <Picture node={n} dir={ctx.dir} linked={!!ctx.inLink} />;
    case "break":
      return <br />;
    case "footnoteRef": {
      const num = ctx.notes.get(n.label);
      return (
        <sup className="md-fnref" id={`fnref-${n.label}`}>
          <a href={`#fn-${n.label}`} data-href={`#fn-${n.label}`}>
            {num ?? n.label}
          </a>
        </sup>
      );
    }
  }
}

/**
 * A parsed Markdown document, drawn element by element. Links carry their
 * address in `data-href`; the reader handles clicks on them.
 */
export const MarkdownView = memo(function MarkdownView({
  blocks,
  dir,
}: {
  blocks: MdNode[];
  dir: string;
}) {
  const notes = useMemo(() => numberFootnotes(blocks), [blocks]);
  const defs = useMemo(() => {
    const found: Extract<MdNode, { t: "footnoteDef" }>[] = [];
    const walk = (nodes: MdNode[]) => {
      for (const n of nodes) {
        if (n.t === "footnoteDef") found.push(n);
        else if ("c" in n) walk(n.c);
      }
    };
    walk(blocks);
    return found.sort(
      (a, b) => (notes.get(a.label) ?? Infinity) - (notes.get(b.label) ?? Infinity)
    );
  }, [blocks, notes]);
  const ctx = useMemo(() => ({ dir, notes }), [dir, notes]);
  return (
    <>
      <Nodes nodes={blocks} ctx={ctx} />
      {defs.length > 0 && (
        <section className="md-footnotes" aria-label="Footnotes">
          <ol>
            {defs.map((d) => (
              <li key={d.label} id={`fn-${d.label}`} value={notes.get(d.label)}>
                <Nodes nodes={d.c} ctx={ctx} />
                {notes.has(d.label) && (
                  <a
                    className="md-fnback"
                    href={`#fnref-${d.label}`}
                    data-href={`#fnref-${d.label}`}
                    aria-label="Back to the text"
                  >
                    ↩
                  </a>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
});
