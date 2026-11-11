import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDownRegular, ArrowUpRegular, ChevronDownRegular, ChevronRightRegular } from "@fluentui/react-icons";
import { api } from "../ipc";
import { useSettings } from "../stores/settings";
import { columnStats, isNumeric, sortOrder, type ShownStats } from "../util/dataTable";
import type { AnnData, AnnSection, ColumnStats, DataBook, DataTable, H5Node } from "../types";
import { highlight } from "./highlight";
import { annSections } from "../util/diffTable";

const OVERSCAN = 12;
const JSON_PAGE = 200;
/** A book with more parts than this lists them down the side, not in tabs. */
const MAX_TABS = 8;

const count = (n: number) => n.toLocaleString();

function widthOf(table: DataTable, c: number): number {
  const col = table.columns[c];
  let w = col.name.length + (col.ty ? col.ty.length + 1 : 0) + 2;
  for (const row of table.rows.slice(0, 200)) w = Math.max(w, row[c]?.length ?? 4);
  return Math.min(Math.max(w, 4), 40) + 2;
}

function summary(table: DataTable): string {
  const cols = `${count(table.columns.length)} column${table.columns.length === 1 ? "" : "s"}`;
  const total = table.totalRows;
  if (total === null) return cols;
  const rows = `${table.more ? "at least " : ""}${count(total)} row${total === 1 ? "" : "s"}`;
  const shown = table.rows.length < total ? ` · showing the first ${count(table.rows.length)}` : "";
  return `${rows} × ${cols}${shown}`;
}

function statsLine(exact: ColumnStats | undefined, shown: ShownStats): string {
  const parts: string[] = [];
  const min = exact ? exact.min : shown.min;
  const max = exact ? exact.max : shown.max;
  const gone = exact ? exact.nulls : shown.missing;
  if (min != null && max != null) parts.push(min === max ? `all ${min}` : `${min} – ${max}`);
  else if (!exact && shown.distinct !== undefined) {
    parts.push(`${count(shown.distinct)}${shown.distinctMore ? "+" : ""} distinct`);
  }
  if (gone) parts.push(`${count(gone)} missing`);
  return parts.join(" · ");
}

type Sort = { col: number; desc: boolean } | null;

/** A data table that draws only the rows in view, so large files scroll smoothly. */
export const DataGrid = memo(function DataGrid({ table, scale }: { table: DataTable; scale: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [rowH, setRowH] = useState(26);
  const [view, setView] = useState({ top: 0, height: 600 });
  const [sort, setSort] = useState<Sort>(null);
  const showStats = useSettings((s) => s.columnStats);

  const numeric = useMemo(() => table.columns.map((_, c) => isNumeric(table, c)), [table]);

  const stats = useMemo(
    () =>
      showStats
        ? table.columns.map((col, c) => statsLine(col.stats, col.stats ? { missing: 0 } : columnStats(table.rows, c, numeric[c])))
        : null,
    [table, numeric, showStats]
  );

  // Columns fit their values and the stats line, which uses a smaller font, up to the same limit.
  const layout = useMemo(() => {
    const widths = table.columns.map((_, c) => Math.max(widthOf(table, c), Math.min(Math.ceil((stats?.[c].length ?? 0) * 0.86) + 2, 42)));
    const numDigits = String(table.rows.length).length + 1;
    return { template: [`${numDigits + 1}ch`, ...widths.map((w) => `${w}ch`)].join(" "), numeric };
  }, [table, numeric, stats]);

  const order = useMemo(
    () => (sort ? sortOrder(table.rows, sort.col, sort.desc, layout.numeric[sort.col]) : null),
    [table, sort, layout]
  );

  // Row size follows the page text size, which zoom changes.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setRowH(Math.round(parseFloat(getComputedStyle(el).fontSize) * 1.9));
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scale]);

  // Sort order: ascending, descending, then the file order.
  const sortBy = (col: number) =>
    setSort((s) => (s?.col !== col ? { col, desc: false } : s.desc ? null : { col, desc: true }));

  const first = Math.max(0, Math.floor(view.top / rowH) - OVERSCAN);
  const last = Math.min(table.rows.length, Math.ceil((view.top + view.height) / rowH) + OVERSCAN);
  const style = { gridTemplateColumns: layout.template, height: rowH };
  const partial = table.totalRows !== null && table.rows.length < table.totalRows;
  const counted = (sort || stats?.some((line, c) => line && !table.columns[c].stats)) && partial;

  return (
    <div className="dv-table">
      <div className="dv-facts">
        {table.columns.length > 0 && <span>{summary(table)}</span>}
        {table.facts.map(([label, value]) => (
          <span key={label}>
            {label}: <b>{value}</b>
          </span>
        ))}
        {counted && <span>Sorting and figures: first {count(table.rows.length)} rows</span>}
        {table.columns.length > 0 && (
          <button
            className={`dv-toggle${showStats ? " on" : ""}`}
            onClick={() => useSettings.getState().set({ columnStats: !showStats })}
            aria-pressed={showStats}
            title="Show each column's range and missing values"
          >
            Column figures
          </button>
        )}
      </div>
      <div
        ref={scroller}
        className="dv-grid"
        onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
        tabIndex={0}
        role="table"
        aria-rowcount={table.rows.length + 1}
        aria-colcount={table.columns.length}
      >
        <div className="dv-tr dv-head" style={{ ...style, height: stats ? rowH * 1.8 : rowH }} role="row">
          <span className="dv-td dv-num" />
          {table.columns.map((c, i) => {
            const sorted = sort?.col === i ? sort : null;
            return (
              <span
                key={i}
                className={`dv-td${layout.numeric[i] ? " right" : ""}`}
                role="columnheader"
                aria-sort={sorted ? (sorted.desc ? "descending" : "ascending") : undefined}
              >
                <button className="dv-sort" onClick={() => sortBy(i)} title={`Sort by ${c.name || c.ty || "this column"}`}>
                  <span className="dv-th-name">
                    {c.name}
                    {c.ty && <small>{c.ty}</small>}
                    {sorted && (sorted.desc ? <ArrowDownRegular /> : <ArrowUpRegular />)}
                  </span>
                  {stats && <span className="dv-th-stats">{stats[i]}</span>}
                </button>
              </span>
            );
          })}
        </div>
        <div className="dv-rows" style={{ height: table.rows.length * rowH, width: "max-content", minWidth: "100%" }}>
          {Array.from({ length: Math.max(0, last - first) }, (_, k) => {
            const r = first + k;
            const at = order ? order[r] : r;
            const row = table.rows[at];
            return (
              <div key={r} className="dv-tr" style={{ ...style, top: r * rowH }} role="row" aria-rowindex={r + 2}>
                <span className="dv-td dv-num">{table.zeroIndex ? at : at + 1}</span>
                {table.columns.map((_, c) => {
                  const v = row[c] ?? null;
                  return (
                    <span key={c} className={`dv-td${layout.numeric[c] ? " right" : ""}`} role="cell" title={v ?? undefined}>
                      {v === null ? <i className="dv-null">null</i> : v}
                    </span>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

function JsonValue({ value }: { value: unknown }) {
  if (value === null) return <span className="dv-j-null">null</span>;
  if (typeof value === "string") return <span className="dv-j-str">{JSON.stringify(value)}</span>;
  if (typeof value === "number") return <span className="dv-j-num">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="dv-j-bool">{String(value)}</span>;
  return null;
}

function JsonNode({ name, value, depth }: { name: string | null; value: unknown; depth: number }) {
  const branch = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < 2);
  const [shown, setShown] = useState(JSON_PAGE);
  const label = name !== null && <span className="dv-j-key">{name}: </span>;
  if (!branch) {
    return (
      <div className="dv-j-row">
        <span className="dv-j-twisty" />
        {label}
        <JsonValue value={value} />
      </div>
    );
  }
  const array = Array.isArray(value);
  const entries: [string, unknown][] = array
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const brief = array ? `[${count(entries.length)}]` : `{${count(entries.length)}}`;
  return (
    <div>
      <button className="dv-j-row dv-j-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="dv-j-twisty">{entries.length > 0 && (open ? <ChevronDownRegular /> : <ChevronRightRegular />)}</span>
        {label}
        <span className="dv-j-brief">{brief}</span>
      </button>
      {open && entries.length > 0 && (
        <div className="dv-j-kids">
          {entries.slice(0, shown).map(([k, v]) => (
            <JsonNode key={k} name={k} value={v} depth={depth + 1} />
          ))}
          {entries.length > shown && (
            <button className="dv-more" onClick={() => setShown((n) => n + JSON_PAGE)}>
              Show {count(Math.min(JSON_PAGE, entries.length - shown))} more of {count(entries.length - shown)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function JsonTree({ value }: { value: unknown }) {
  return (
    <div className="dv-json">
      <JsonNode name={null} value={value} depth={0} />
    </div>
  );
}

function H5Row({ node, depth }: { node: H5Node; depth: number }) {
  const kids = node.children ?? [];
  const attrs = node.attrs ?? [];
  const canOpen = kids.length > 0 || attrs.length > 0 || (node.hidden ?? 0) > 0;
  const [open, setOpen] = useState(depth < 1);
  const encoding = attrs.find(([k]) => k === "encoding-type")?.[1];
  const members = kids.length + (node.hidden ?? 0);
  const what =
    node.kind === "dataset"
      ? [node.shape?.length ? node.shape.map(count).join(" × ") : "scalar", node.dtype].filter(Boolean).join(" · ")
      : `${count(members)} member${members === 1 ? "" : "s"}`;
  return (
    <div>
      <button className="dv-j-row dv-j-toggle" onClick={() => setOpen((o) => !o)} disabled={!canOpen} aria-expanded={canOpen ? open : undefined}>
        <span className="dv-j-twisty">{canOpen && (open ? <ChevronDownRegular /> : <ChevronRightRegular />)}</span>
        <span className={node.kind === "group" ? "dv-h-group" : "dv-h-set"}>{node.name}</span>
        <span className="dv-j-brief">{what}</span>
        {encoding && <span className="dv-badge">{encoding}</span>}
      </button>
      {open && canOpen && (
        <div className="dv-j-kids">
          {attrs.map(([k, v]) => (
            <div key={`@${k}`} className="dv-j-row dv-h-attr">
              <span className="dv-j-twisty" />@{k} = {v}
            </div>
          ))}
          {kids.map((k) => (
            <H5Row key={k.name} node={k} depth={depth + 1} />
          ))}
          {(node.hidden ?? 0) > 0 && (
            <div className="dv-j-row dv-h-attr">
              <span className="dv-j-twisty" />…and {count(node.hidden ?? 0)} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReprLines({ sections }: { sections: AnnSection[] }) {
  return (
    <>
      {sections.map((s) => (
        <div key={s.name} className="dv-repr-line">
          {"    "}
          {s.name}: {s.keys.map((k, i) => (
            <span key={k.name}>
              {i > 0 && ", "}
              <span className="dv-j-str" title={k.detail}>
                '{k.name}'
              </span>
            </span>
          ))}
        </div>
      ))}
    </>
  );
}

function AnnSummary({ a }: { a: AnnData }) {
  const all = annSections(a);
  return (
    <div className="dv-ann">
      <pre className="dv-repr">
        <div className="dv-repr-line">
          AnnData object with n_obs × n_vars = {a.nObs} × {a.nVars}
        </div>
        <ReprLines sections={a.sections} />
        {a.raw && (
          <>
            <div className="dv-repr-line dv-repr-gap">
              Raw AnnData with n_obs × n_vars = {a.raw[0]} × {a.raw[1]}
            </div>
            <ReprLines sections={a.raw[2]} />
          </>
        )}
      </pre>
      <table className="dv-keys">
        <tbody>
          {a.x && (
            <tr>
              <th>X</th>
              <td />
              <td>
                {count(a.nObs)} × {count(a.nVars)} · {a.x}
              </td>
            </tr>
          )}
          {all.map((s) =>
            s.keys.map((k, i) => (
              <tr key={`${s.name}/${k.name}`} className={i === 0 ? "first" : undefined}>
                <th>{i === 0 ? s.name : ""}</th>
                <td>{k.name}</td>
                <td>{k.detail}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

type Tab = "summary" | "obs" | "var" | "structure";

export function Hdf5View({ root, anndata, scale }: { root: H5Node; anndata?: AnnData; scale: number }) {
  const [tab, setTab] = useState<Tab>(anndata ? "summary" : "structure");
  const tabs: [Tab, string][] = anndata
    ? [
        ["summary", "Summary"],
        ["obs", `obs · ${count(anndata.nObs)}`],
        ["var", `var · ${count(anndata.nVars)}`],
        ["structure", "Structure"],
      ]
    : [];
  const table = tab === "obs" ? anndata?.obs : tab === "var" ? anndata?.var : null;
  return (
    <div className="dv-h5">
      {tabs.length > 0 && (
        <div className="dv-tabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : undefined} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {table ? (
        <DataGrid key={tab} table={table} scale={scale} />
      ) : (
        <div className="dv-pane">
          {tab === "summary" && anndata ? (
            <AnnSummary a={anndata} />
          ) : (
            <div className="dv-json">
              <H5Row node={root} depth={0} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const SCHEMA = "\u0000schema";

/** A file of several tables. Each part is read on first show and kept. A SQLite database also has a Schema page. */
export function BookView({ path, book, scale }: { path: string; book: DataBook; scale: number }) {
  const [tab, setTab] = useState(book.parts[0]?.name ?? (book.schema ? SCHEMA : ""));
  const [loaded, setLoaded] = useState<Record<string, DataTable | { error: string }>>(() =>
    book.first && book.parts[0] ? { [book.parts[0].name]: book.first } : {}
  );

  useEffect(() => {
    if (tab === SCHEMA || !tab || loaded[tab]) return;
    let live = true;
    api
      .readDataPart(path, tab)
      .then((t) => live && setLoaded((l) => ({ ...l, [tab]: t })))
      .catch((e) => live && setLoaded((l) => ({ ...l, [tab]: { error: String(e) } })));
    return () => {
      live = false;
    };
  }, [path, tab, loaded]);

  const tabs: { id: string; label: string; detail: string }[] = [
    ...book.parts.map((p) => ({ id: p.name, label: p.name, detail: p.detail })),
    ...(book.schema ? [{ id: SCHEMA, label: "Schema", detail: "CREATE statements" }] : []),
  ];
  const side = book.parts.length > MAX_TABS;
  const shown = loaded[tab];
  const facts = book.facts.map(([k, v]) => `${k}: ${v}`).join(" · ");

  let body;
  if (tabs.length === 0) body = <div className="dv-empty">This file has no tables.</div>;
  else if (tab === SCHEMA) {
    body = (
      <div className="dv-pane">
        <pre className="dv-schema">
          <code className="hljs">{highlight("sql", book.schema ?? "")}</code>
        </pre>
      </div>
    );
  } else if (!shown) body = <div className="dv-empty">Reading “{tab}”…</div>;
  else if ("error" in shown) body = <div className="dv-empty">Doftar can't show “{tab}”: {shown.error}</div>;
  else body = <DataGrid key={tab} table={shown} scale={scale} />;

  return (
    <div className={`dv-book${side ? " side" : ""}`}>
      <div className={side ? "dv-parts" : "dv-tabs"} role="tablist" aria-orientation={side ? "vertical" : "horizontal"}>
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "on" : undefined}
            onClick={() => setTab(t.id)}
            title={`${t.label} · ${t.detail}`}
          >
            {t.label}
            {side && <small>{t.detail}</small>}
          </button>
        ))}
        {!side && facts && <span className="dv-tab-facts">{facts}</span>}
      </div>
      <div className="dv-book-body">{body}</div>
    </div>
  );
}
