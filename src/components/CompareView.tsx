import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { EditRegular, OpenRegular } from "@fluentui/react-icons";
import { api } from "../ipc";
import { openFile, showError } from "../actions";
import { useFileWatch } from "../hooks/useVisibleFileWatch";
import { extOf, isDataFile } from "../util/kinds";
import { baseName, useActiveTab } from "../stores/tabs";
import { diffLines, splitLines, type DiffRow } from "../util/diffLines";
import { highlight } from "./highlight";
import { RollingNumber } from "./RollingNumber";
import { AnnCompare, TableCompare } from "./DataCompare";
import type { AnnData, DataTable } from "../types";

type Side = { text: string; lang: string } | { table: DataTable } | { ann: AnnData } | { error: string };

async function readSide(path: string): Promise<Side> {
  try {
    if (extOf(path) === "docx") return { text: await api.readDocxText(path), lang: "" };
    const doc = await api.readDocument(path);
    if (doc.kind === "table") return { table: doc };
    if (doc.kind === "hdf5") return doc.anndata ? { ann: doc.anndata } : { error: `${baseName(path)} isn't an AnnData file` };
    if (doc.kind === "code") return { text: doc.text, lang: doc.lang };
    if (doc.kind === "text") return { text: doc.text, lang: "" };
    return { text: (await api.readText(path)).text, lang: "" };
  } catch (e) {
    return { error: String(e) };
  }
}

/** Every row is highlighted and in the page, so a long comparison would freeze it. */
const MAX_ROWS = 5000;

function Cell({ line, lang, mark }: { line: DiffRow["left"]; lang: string; mark: "-" | "+" | " " }) {
  if (!line) return <div className="cmp-cell cmp-blank" />;
  return (
    <div className={`cmp-cell${mark === "-" ? " cmp-del" : mark === "+" ? " cmp-add" : ""}`}>
      <span className="cmp-n">{line.n}</span>
      <span className="cmp-mark" aria-hidden>{mark}</span>
      <span className="cmp-text">{highlight(lang, line.text)}{line.text === "" ? " " : null}</span>
    </div>
  );
}

function SideName({ path }: { path: string }) {
  const name = baseName(path);
  const data = isDataFile(extOf(path));
  const edit = () =>
    extOf(path) === "docx" || data ? openFile(path) : void api.openReader(path, null, null, true).catch(showError);
  return (
    <span className="cmp-side">
      <span className="cmp-file" title={path}>{name}</span>
      <button
        className="link-btn cmp-edit"
        aria-label={`${data ? "Open" : "Edit"} ${name}`}
        onClick={edit}
      >
        {data ? <><OpenRegular aria-hidden /> Open</> : <><EditRegular aria-hidden /> Edit</>}
      </button>
    </span>
  );
}

export function CompareView() {
  const tab = useActiveTab();
  const loc = tab.location;
  const a = loc.kind === "compare" ? loc.a : "";
  const b = loc.kind === "compare" ? loc.b : "";
  const [sides, setSides] = useState<[Side, Side] | null>(null);
  // Bumped when a file changes on disk.
  const [rev, setRev] = useState(0);
  useFileWatch([a, b], rev);

  useEffect(() => {
    const un = listen<string>("fs:file", (ev) => {
      if (ev.payload === a || ev.payload === b) setRev((r) => r + 1);
    });
    return () => void un.then((f) => f());
  }, [a, b]);

  useEffect(() => setSides(null), [a, b, tab.id]);

  useEffect(() => {
    let live = true;
    void Promise.all([readSide(a), readSide(b)]).then((s) => live && setSides(s));
    return () => {
      live = false;
    };
  }, [a, b, tab.id, rev]);

  const { rows, exact } = useMemo(() => {
    if (!sides || !("text" in sides[0]) || !("text" in sides[1])) return { rows: [], exact: true };
    return diffLines(splitLines(sides[0].text), splitLines(sides[1].text));
  }, [sides]);
  const notes = [
    !exact && "These files differ too much to line up, so the part between their matching start and end shows as one change.",
    rows.length > MAX_ROWS && `Showing the first ${MAX_ROWS.toLocaleString()} of ${rows.length.toLocaleString()} rows.`,
  ].filter(Boolean);

  const dels = rows.filter((r) => r.kind === "change" && r.left).length;
  const adds = rows.filter((r) => r.kind === "change" && r.right).length;
  const kinds = sides?.map((s) => ("table" in s ? "table" : "ann" in s ? "ann" : "text"));
  const failed =
    sides?.find((s): s is { error: string } => "error" in s) ??
    (kinds && kinds[0] !== kinds[1] ? { error: "one is a data file and the other isn't" } : undefined);
  const [l, r] = sides ?? [];

  return (
    <div className="cmp-page" role="region" aria-label="Compare files">
      <div className="cmp-head">
        <SideName path={a} />
        <span className="cmp-count">
          {sides && !failed && kinds![0] === "text" && (adds + dels === 0 ? "Identical" : (
            <>
              <span className="cmp-add-n">+<RollingNumber value={adds} /></span> <span className="cmp-del-n">−<RollingNumber value={dels} /></span>
            </>
          ))}
        </span>
        <SideName path={b} />
      </div>
      {failed ? (
        <p className="tags-note">Can't compare: {failed.error}</p>
      ) : !sides ? null : l && r && "table" in l && "table" in r ? (
        <TableCompare key={`${a}\u0000${b}`} a={l.table} b={r.table} />
      ) : l && r && "ann" in l && "ann" in r ? (
        <AnnCompare key={`${a}\u0000${b}`} a={l.ann} b={r.ann} />
      ) : (
        <>
          {notes.length > 0 && <p className="tags-note">{notes.join(" ")}</p>}
          <div className="cmp-body" key={`${a}\u0000${b}`}>
            {rows.slice(0, MAX_ROWS).map((r, i) => (
              <div key={i} className="cmp-row" style={{ animationDelay: `${Math.min(i, 40) * 12}ms` }}>
                <Cell line={r.left} lang={(sides[0] as { lang: string }).lang} mark={r.kind === "same" ? " " : "-"} />
                <Cell line={r.right} lang={(sides[1] as { lang: string }).lang} mark={r.kind === "same" ? " " : "+"} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
