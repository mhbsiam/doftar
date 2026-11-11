import { useEffect, useState } from "react";
import {
  TextBulletListLtrRegular,
  GridDotsRegular,
  ColumnTripleRegular,
} from "@fluentui/react-icons";
import { useActiveTab, useTabs } from "../stores/tabs";
import { useGit } from "../stores/git";
import { GitPanel } from "./GitPanel";
import { setFolderView, useFolderView } from "../hooks/useFolderView";
import { formatSize } from "../util/format";
import { RollingNumber } from "./RollingNumber";
import { useFolderSize } from "../hooks/useFolderSize";
import { api } from "../ipc";

const MEASURE_MAX = 10;

export function StatusBar() {
  const tab = useActiveTab();
  const listingCount = useTabs((s) => s.listingCount);
  const selectionBytes = useTabs((s) => s.selectionBytes);
  const { viewMode } = useFolderView();
  const selCount = tab.selection.length;
  const here = tab.location.kind === "path" ? tab.location.path : null;
  const git = useGit((s) => (here ? s.byDir[here] : null));
  const refreshTick = useTabs((s) => s.refreshTick);
  const selectionDirs = useTabs((s) => s.selectionDirs);
  // Wait for the selection to rest, so arrowing through folders does not start a scan each step.
  const [measured, setMeasured] = useState<string[]>([]);
  useEffect(() => {
    const t = setTimeout(() => setMeasured(selectionDirs), selectionDirs.length ? 300 : 0);
    return () => clearTimeout(t);
  }, [selectionDirs]);
  // More folders than this, as after ⌘A, could mean walking a whole drive. ⌘I still measures them.
  const tooMany = selectionDirs.length > MEASURE_MAX;
  const dirSize = useFolderSize(measured, measured.length > 0 && !tooMany && measured === selectionDirs);
  const [free, setFree] = useState<number | null>(null);
  useEffect(() => {
    if (!here) return setFree(null);
    let live = true;
    api.freeSpace(here).then((n) => live && setFree(n)).catch(() => live && setFree(null));
    return () => {
      live = false;
    };
  }, [here, refreshTick, listingCount]);
  // The counts are a live region, so the text changes once when done, not with each progress step.
  const sizing = selectionDirs.length > 0;
  const bytes = selectionBytes + (dirSize?.bytes ?? 0);
  const sizeText = tooMany
    ? ""
    : sizing && !dirSize?.done
      ? "  (calculating…)"
      : bytes > 0
        ? `  (${formatSize(bytes)})`
        : "";

  return (
    <div className="statusbar">
      {/* Only the counts are a live region. The view buttons are not. */}
      <span className="status-counts" role="status">
        <span>
          {listingCount > 0 && (
            <>
              <RollingNumber value={listingCount} /> item{listingCount === 1 ? "" : "s"}
            </>
          )}
        </span>
        {selCount > 0 && (
          <span>
            <RollingNumber value={selCount} /> item{selCount === 1 ? "" : "s"} selected
            {sizeText}
          </span>
        )}
      </span>
      <span className="status-right">
        {free !== null && <span className="status-free">{formatSize(free)} available</span>}
        {git && here && <GitPanel dir={here} info={git} />}
        <button
          className={`viewtoggle${viewMode === "details" ? " active" : ""}`}
          title="List view"
          aria-label="List view"
          aria-pressed={viewMode === "details"}
          onClick={() => setFolderView({ viewMode: "details" })}
        >
          <TextBulletListLtrRegular />
        </button>
        <button
          className={`viewtoggle${viewMode === "grid" ? " active" : ""}`}
          title="Icons view"
          aria-label="Icons view"
          aria-pressed={viewMode === "grid"}
          onClick={() => setFolderView({ viewMode: "grid" })}
        >
          <GridDotsRegular />
        </button>
        <button
          className={`viewtoggle${viewMode === "columns" ? " active" : ""}`}
          title="Columns view"
          aria-label="Columns view"
          aria-pressed={viewMode === "columns"}
          onClick={() => setFolderView({ viewMode: "columns" })}
        >
          <ColumnTripleRegular />
        </button>
      </span>
    </div>
  );
}
