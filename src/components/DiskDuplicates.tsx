import { useState } from "react";
import { Checkbox } from "@fluentui/react-components";
import { DeleteRegular } from "@fluentui/react-icons";
import { api } from "../ipc";
import { runJob } from "../jobs";
import { showError, trashNow } from "../actions";
import { useAppData } from "../stores/appdata";
import { parentOf, useTabs } from "../stores/tabs";
import { useUI } from "../stores/ui";
import { formatSize } from "../util/format";
import type { DupeReport } from "../types";

/** Smaller files are not worth the reading. Most of what a disk loses to copies is in big ones. */
const MIN_BYTES = 1_000_000;

/**
 * Files in the home folder with the same content, found on request. Never selects every copy of a file:
 * one always stays. Hidden items and the insides of apps are not searched.
 */
export function DiskDuplicates({ title, open }: { title: React.ReactNode; open: boolean }) {
  const home = useAppData((s) => s.home);
  const [report, setReport] = useState<DupeReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const find = () => {
    setBusy(true);
    setSelected(new Set());
    runJob("Looking for duplicate files", (id, on) => api.findDuplicates(home, MIN_BYTES, id, on))
      .then((r) => setReport(r.cancelled ? null : r))
      .catch(showError)
      .finally(() => setBusy(false));
  };

  const toggle = (path: string, group: string[]) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.delete(path)) return next;
      if (group.every((p) => p === path || next.has(p))) {
        useUI.getState().pushToast("One copy of each file stays, so nothing is lost.");
        return cur;
      }
      next.add(path);
      return next;
    });

  const selectExtras = () => report && setSelected(new Set(report.groups.flatMap((g) => g.paths.slice(1))));

  const trash = () => {
    const asked = [...selected];
    void trashNow(asked, { fly: false }).then(async () => {
      // Keep the rows of files that are still there, for example when their drive has no Trash.
      const still = await Promise.all(asked.map((p) => api.pathExists(p).catch(() => true)));
      const gone = asked.filter((_, i) => !still[i]);
      setSelected(new Set());
      setReport(
        (r) =>
          r && {
            ...r,
            groups: r.groups
              .map((g) => ({ ...g, paths: g.paths.filter((p) => !gone.includes(p)) }))
              .filter((g) => g.paths.length > 1),
          }
      );
    });
  };

  const freed = report?.groups.reduce((n, g) => n + g.size * g.paths.filter((p) => selected.has(p)).length, 0) ?? 0;

  return (
    <section className="disk-card disk-files" aria-label="Duplicate files">
      <div className="disk-files-head">
        {title}
        {open && (
          <span className="disk-dupes-actions">
            {report && report.groups.length > 0 && (
              <button className="btn subtle compact" onClick={selectExtras}>
                Select all but one of each
              </button>
            )}
            {selected.size > 0 && (
              <button className="btn subtle compact" onClick={trash}>
                <DeleteRegular className="btn-icon" />
                Move {selected.size} to Trash · {formatSize(freed)}
              </button>
            )}
            <button className="btn subtle compact" disabled={busy || !home} onClick={find}>
              {busy ? "Looking…" : report ? "Look again" : "Find duplicates"}
            </button>
          </span>
        )}
      </div>
      {!open ? null : !report ? (
        <p className="disk-hint">
          Compares the content of files of 1 MB and more in your home folder. It reads a lot of data, so it runs only
          when you ask. Hidden items and the insides of apps are left out.
        </p>
      ) : report.groups.length === 0 ? (
        <p className="disk-hint">No duplicate files of 1 MB or more.</p>
      ) : (
        <>
          <p className="disk-hint">
            {report.groups.length.toLocaleString()} sets{report.truncated ? " (the largest 500)" : ""}, up to{" "}
            {formatSize(report.wasted)} taken by extra copies. A copy made in Finder or Doftar on this disk shares its
            storage with the original, so removing it may free less than shown.
          </p>
          <ul className="disk-filelist">
            {report.groups.map((g) => (
              <li key={g.paths[0]} className="disk-dupe">
                <div className="disk-dupe-head">
                  <span className="disk-file-name">{g.paths[0].slice(g.paths[0].lastIndexOf("/") + 1)}</span>
                  <span className="disk-file-path">
                    {g.paths.length} copies · {formatSize(g.size)} each
                  </span>
                </div>
                {g.paths.map((p) => (
                  <label key={p} className="disk-dupe-row" title={p} onDoubleClick={() => useTabs.getState().reveal(p)}>
                    <Checkbox checked={selected.has(p)} onChange={() => toggle(p, g.paths)} />
                    <span className="disk-file-name">{p.slice(p.lastIndexOf("/") + 1)}</span>
                    <span className="disk-file-path">{parentOf(p)}</span>
                  </label>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
