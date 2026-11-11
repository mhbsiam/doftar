import { useMemo, useState } from "react";
import type { AnnData, DataTable } from "../types";
import { diffAnnData, diffTables, type RowDiff } from "../util/diffTable";

/** Limits for rows and cells drawn. The rest are only counted. */
// shortcut: no virtual scrolling, so a long diff is cut here. Virtualise like DataGrid if people need every row.
const SHOW_ROWS = 500;
const SHOW_CELLS = 100_000;
/** Menu value for matching by whole row. No column name can be it. */
const WHOLE_ROW = "\u0000";

const count = (n: number) => n.toLocaleString();
/** An AnnData index column has no name. */
const colName = (n: string) => n || "index";
const loaded = (t: DataTable) => t.more || (t.totalRows ?? t.rows.length) > t.rows.length;
const rowsOf = (t: DataTable) => `${count(t.totalRows ?? t.rows.length)}${t.more ? "+" : ""}`;

function Change({ from, to }: { from: string | number; to: string | number }) {
  if (from === to) return <>{from}</>;
  return (
    <>
      <span className="dcmp-old">{from}</span> → <span className="dcmp-new">{to}</span>
    </>
  );
}

function Cells({ d }: { d: RowDiff }) {
  if (d.kind !== "change") return d.row.map((v, i) => <td key={i}>{v ?? ""}</td>);
  const changed = new Set(d.cells);
  return d.left.map((v, i) =>
    changed.has(i) ? (
      <td key={i} className="dcmp-changed">
        <Change from={v ?? ""} to={d.right[i] ?? ""} />
      </td>
    ) : (
      <td key={i}>{v ?? ""}</td>
    )
  );
}

export function TableCompare({ a, b }: { a: DataTable; b: DataTable }) {
  // undefined: the diff picks a key. null: match rows by their whole content.
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const d = useMemo(() => diffTables(a, b, key), [a, b, key]);
  const adds = d.rows.filter((r) => r.kind === "add").length;
  const dels = d.rows.filter((r) => r.kind === "del").length;
  const changes = d.rows.length - adds - dels;
  const schemaSame = !d.added.length && !d.removed.length && !d.retyped.length;
  const shown = Math.min(SHOW_ROWS, Math.max(1, Math.floor(SHOW_CELLS / Math.max(1, d.shared.length))));
  return (
    <div className="dcmp">
      <div className="dv-facts">
        <span>
          Rows <b><Change from={rowsOf(a)} to={rowsOf(b)} /></b>
        </span>
        <span>
          Columns <b><Change from={a.columns.length} to={b.columns.length} /></b>
        </span>
        {(loaded(a) || loaded(b)) && (
          <span>
            Compared the first <b>{count(a.rows.length)}</b> and <b>{count(b.rows.length)}</b> rows
          </span>
        )}
      </div>
      <div className="dcmp-schema">
        {schemaSame && <span className="dcmp-quiet">Same columns</span>}
        {d.added.map((n) => (
          <span key={`+${n}`} className="dcmp-chip dcmp-add">+ {colName(n)}</span>
        ))}
        {d.removed.map((n) => (
          <span key={`-${n}`} className="dcmp-chip dcmp-del">− {colName(n)}</span>
        ))}
        {d.retyped.map((t) => (
          <span key={`~${t.name}`} className="dcmp-chip dcmp-mod">
            {colName(t.name)}: {t.from} → {t.to}
          </span>
        ))}
      </div>
      {d.shared.length > 0 && (
        <div className="dcmp-bar">
          <label>
            Match rows by{" "}
            <select value={d.key ?? WHOLE_ROW} onChange={(e) => setKey(e.target.value === WHOLE_ROW ? null : e.target.value)}>
              {d.keys.map((k) => (
                <option key={k} value={k}>{colName(k)}</option>
              ))}
              <option value={WHOLE_ROW}>Whole row</option>
            </select>
          </label>
          <span className="cmp-add-n">+{count(adds)} added</span>
          <span className="cmp-del-n">−{count(dels)} removed</span>
          {d.key !== null && <span className="dcmp-mod-n">~{count(changes)} changed</span>}
          <span className="dcmp-quiet">{count(d.same)} the same</span>
        </div>
      )}
      {d.shared.length === 0 ? (
        <p className="tags-note">The files share no columns, so their rows can't be compared.</p>
      ) : d.rows.length === 0 ? (
        <p className="tags-note">No rows differ in the columns both files have.</p>
      ) : (
        <div className="dcmp-grid">
          <table>
            <thead>
              <tr>
                <th aria-label="Change" />
                {d.shared.map((n) => (
                  <th key={n}>{colName(n)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.rows.slice(0, shown).map((r, i) => (
                <tr key={i} className={`dcmp-${r.kind}`}>
                  <td className="cmp-mark">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : "~"}</td>
                  <Cells d={r} />
                </tr>
              ))}
            </tbody>
          </table>
          {d.rows.length > shown && (
            <p className="tags-note">Showing the first {count(shown)} of {count(d.rows.length)} rows that differ.</p>
          )}
        </div>
      )}
    </div>
  );
}

type AnnTab = "summary" | "obs" | "var";

export function AnnCompare({ a, b }: { a: AnnData; b: AnnData }) {
  const [tab, setTab] = useState<AnnTab>("summary");
  const keys = useMemo(() => diffAnnData(a, b), [a, b]);
  const tabs: [AnnTab, string][] = [["summary", "Summary"]];
  if (a.obs && b.obs) tabs.push(["obs", "obs"]);
  if (a.var && b.var) tabs.push(["var", "var"]);
  const table = tab === "obs" ? [a.obs, b.obs] : tab === "var" ? [a.var, b.var] : null;
  const top: [string, string, string][] = [
    ["n_obs", count(a.nObs), count(b.nObs)],
    ["n_vars", count(a.nVars), count(b.nVars)],
    ["X", a.x ?? "none", b.x ?? "none"],
  ];
  if (a.raw || b.raw) {
    const raw = (x: AnnData) => (x.raw ? `${count(x.raw[0])} × ${count(x.raw[1])}` : "none");
    top.push(["raw", raw(a), raw(b)]);
  }
  return (
    <div className="dcmp">
      {tabs.length > 1 && (
        <div className="dv-tabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : undefined} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {table?.[0] && table[1] ? (
        <TableCompare key={tab} a={table[0]} b={table[1]} />
      ) : (
        <div className="dcmp-grid">
          <table className="dcmp-keys">
            <thead>
              <tr>
                <th aria-label="Change" />
                <th>Section</th>
                <th>Key</th>
                <th>Left</th>
                <th>Right</th>
              </tr>
            </thead>
            <tbody>
              {top.map(([name, l, r]) => (
                <tr key={name} className={l === r ? undefined : "dcmp-change"}>
                  <td className="cmp-mark">{l === r ? "" : "~"}</td>
                  <th>{name}</th>
                  <td />
                  <td>{l}</td>
                  <td>{r}</td>
                </tr>
              ))}
              {keys.map((k, i) => {
                const kind = k.left === null ? "add" : k.right === null ? "del" : k.left !== k.right ? "change" : null;
                return (
                  <tr key={`${k.section}/${k.name}`} className={kind ? `dcmp-${kind}` : undefined}>
                    <td className="cmp-mark">{kind === "add" ? "+" : kind === "del" ? "−" : kind ? "~" : ""}</td>
                    <th>{keys[i - 1]?.section === k.section ? "" : k.section}</th>
                    <td>{k.name}</td>
                    <td>{k.left ?? ""}</td>
                    <td>{k.right ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
