import { useEffect, useMemo, useRef, useState } from "react";
import { Checkbox } from "@fluentui/react-components";
import {
  ArrowDownloadRegular,
  ArrowSyncRegular,
  ChevronDownRegular,
  CopyRegular,
  DeleteRegular,
  DismissRegular,
  FolderOpenRegular,
  ScanRegular,
} from "@fluentui/react-icons";
import { RollingNumber } from "./RollingNumber";
import { EntryIcon } from "./FileIcon";
import { FolderMap } from "./FolderMap";
import { DiskDuplicates } from "./DiskDuplicates";
import { useDisk } from "../stores/disk";
import { useUI } from "../stores/ui";
import { useDateFormat, useSettings } from "../stores/settings";
import { useAppData } from "../stores/appdata";
import { useTabs, usePaneStore, parentOf } from "../stores/tabs";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { api } from "../ipc";
import { confirmedIds, copyText, deleteNow, navigateTo, setViewEntries, showError, trashNow } from "../actions";
import { formatDate, formatSize } from "../util/format";
import { diskCsv } from "../util/diskCsv";
import type { DevFolder, DiskCategory, DiskFile, DiskReport, FileEntry, ScanProgress } from "../types";

const CATEGORY_LABEL: Record<DiskCategory, string> = {
  apps: "Apps",
  images: "Images",
  video: "Video",
  audio: "Audio",
  documents: "Documents",
  archives: "Archives",
  code: "Code",
  other: "Other",
};

const SYSTEM = "system";
const FREE = "free";

interface Segment {
  key: string;
  label: string;
  bytes: number;
}

const CIRCUMFERENCE = 2 * Math.PI * 80;

function colorOf(key: string): string {
  return `var(--disk-${key})`;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const p = (part / whole) * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}

function ago(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return formatDate(ms);
}

function Donut(props: {
  segments: Segment[];
  total: number;
  hovered: string | null;
  onHover: (key: string | null) => void;
  centerTop: string;
  centerBottom: string;
  scanning: boolean;
}) {
  const { segments, total, hovered, onHover, centerTop, centerBottom, scanning } = props;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  let offset = 0;
  return (
    <div className="disk-donut">
      <svg viewBox="0 0 200 200" role="img" aria-label="Disk usage by kind">
        <circle className="disk-donut-track" cx="100" cy="100" r="80" />
        {total > 0 &&
          segments.map((s) => {
            const len = ready ? (s.bytes / total) * CIRCUMFERENCE : 0;
            const arc = (
              <circle
                key={s.key}
                className={`disk-arc${hovered && hovered !== s.key ? " dim" : ""}`}
                cx="100"
                cy="100"
                r="80"
                stroke={colorOf(s.key)}
                strokeDasharray={`${len} ${CIRCUMFERENCE - len}`}
                strokeDashoffset={-offset}
                onMouseEnter={() => onHover(s.key)}
                onMouseLeave={() => onHover(null)}
              >
                <title>{`${s.label}: ${formatSize(s.bytes)}`}</title>
              </circle>
            );
            offset += ready ? len : (s.bytes / total) * CIRCUMFERENCE;
            return arc;
          })}
        {scanning && (
          <circle
            className="disk-donut-seek"
            cx="100"
            cy="100"
            r="80"
            strokeDasharray={`${CIRCUMFERENCE * 0.16} ${CIRCUMFERENCE * 0.84}`}
          />
        )}
      </svg>
      <div className="disk-donut-center">
        <div className="disk-donut-top">{centerTop}</div>
        <div className="disk-donut-bottom">{centerBottom}</div>
      </div>
    </div>
  );
}

function ScanStatus({ progress }: { progress: ScanProgress | null }) {
  const latest = useRef(progress?.current ?? "");
  latest.current = progress?.current ?? "";
  const [path, setPath] = useState(latest.current);
  useEffect(() => {
    const t = setInterval(() => setPath(latest.current), 350);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="disk-scan" role="status">
      <div className="disk-scan-line">
        <ScanRegular className="disk-scan-icon" />
        <span className="shimmer-text">Scanning your home folder</span>
        <span className="disk-scan-count">
          {formatSize(progress?.bytes ?? 0)} · <RollingNumber value={progress?.files ?? 0} /> files
        </span>
      </div>
      {/* The marks stop the right-to-left ellipsis from moving the leading "/" to the end. */}
      <div key={path} className="disk-scan-path">
        {path ? `\u200e${path}\u200e` : "\u00a0"}
      </div>
    </div>
  );
}

const RIPPLE_WIDTHS = [92, 78, 66, 55, 46, 38, 30, 24];

function toEntry(f: DiskFile): FileEntry {
  const dot = f.name.lastIndexOf(".");
  return {
    name: f.name,
    path: f.path,
    isDir: false,
    isHidden: false,
    isSymlink: false,
    isPackage: false,
    size: f.size,
    modifiedMs: f.modifiedMs,
    createdMs: 0,
    ext: dot > 0 ? f.name.slice(dot + 1).toLowerCase() : "",
  };
}

function useCollapsible(label: string) {
  const key = `disk:${label}`;
  const open = !useSettings((s) => s.collapsedSections).includes(key);
  const title = (
    <h2 className="disk-card-title">
      <button
        className="section-toggle"
        aria-expanded={open}
        onClick={() => useSettings.getState().toggleSection(key)}
      >
        <span className={`navchev${open ? " open" : ""}`} aria-hidden>
          <ChevronDownRegular />
        </span>
        {label}
      </button>
    </h2>
  );
  return [open, title] as const;
}

async function exportCsv(report: DiskReport) {
  const day = new Date(report.scannedMs).toISOString().slice(0, 10);
  try {
    const path = await api.createTextFile(
      `${useAppData.getState().home}/Downloads`,
      `Disk usage ${day}`,
      ".csv",
      diskCsv(report)
    );
    useTabs.getState().reveal(path);
  } catch (e) {
    showError(`Couldn't save the CSV: ${e}`);
  }
}

function DevFolders({ items, onTrash }: { items: DevFolder[]; onTrash: (path: string) => void }) {
  const total = items.reduce((n, j) => n + j.bytes, 0);
  const [open, title] = useCollapsible("Developer folders");
  return (
    <section className="disk-card disk-files" aria-label="Developer folders">
      <div className="disk-files-head">
        {title}
        <span className="disk-file-date">{formatSize(total)}</span>
      </div>
      {open && <ul className="disk-filelist">
        {items.map((j) => (
          <li key={j.path} className="disk-file disk-dev" onDoubleClick={() => useTabs.getState().reveal(j.path)}>
            <span className="disk-file-text" title={j.path}>
              <span className="disk-file-name">{j.label}</span>
              <span className="disk-file-path">{j.path}</span>
            </span>
            <span className="disk-file-date">{j.note}</span>
            <span className="disk-file-size">{formatSize(j.bytes)}</span>
            <span className="disk-dev-actions">
              <button className="btn subtle compact" onClick={() => useTabs.getState().reveal(j.path)}>
                <FolderOpenRegular className="btn-icon" />
                Show
              </button>
              {j.safe ? (
                <button className="btn subtle compact" onClick={() => onTrash(j.path)}>
                  <DeleteRegular className="btn-icon" />
                  Move to Trash
                </button>
              ) : (
                <button
                  className="btn subtle compact"
                  onClick={() =>
                    void copyText(`conda env remove -p '${j.path.replace(/'/g, "'\\''")}'`).catch(() =>
                      showError("Couldn't copy the command to the clipboard.")
                    )
                  }
                >
                  <CopyRegular className="btn-icon" />
                  Copy command
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>}
    </section>
  );
}

export function DiskView() {
  useDateFormat();
  const { report, scanning, progress, error } = useDisk();
  const info = useSystemInfo();
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Bump to reload the folder map. */
  const [mapVersion, setMapVersion] = useState(0);
  const lastIndex = useRef<number | null>(null);
  const [mapOpen, mapTitle] = useCollapsible("Folder map");
  const [filesOpen, filesTitle] = useCollapsible("Largest files");
  const [dupesOpen, dupesTitle] = useCollapsible("Duplicate files");

  const paneTabs = usePaneStore();
  useEffect(() => {
    const s = paneTabs.getState();
    setViewEntries(s.pane, []);
    s.setListingCount(0);
    s.setSelectionBytes(0);
  }, [paneTabs]);

  useEffect(() => {
    if (!report) return;
    const live = new Set(report.topFiles.map((f) => f.path));
    setSelected((cur) => {
      const next = new Set([...cur].filter((p) => live.has(p)));
      return next.size === cur.size ? cur : next;
    });
  }, [report]);

  const volume = info?.volumes[0] ?? null;
  const volTotal = volume?.totalBytes ?? 0;
  const volUsed = volume ? Math.max(0, volume.totalBytes - volume.freeBytes) : 0;

  const { segments, total } = useMemo(() => {
    const segs: Segment[] = [];
    const scanned = report ? Math.min(report.totalBytes, volUsed || report.totalBytes) : 0;
    if (report) {
      for (const c of report.categories) {
        if (c.bytes > 0) segs.push({ key: c.key, label: CATEGORY_LABEL[c.key], bytes: c.bytes });
      }
    }
    if (volume) {
      if (report) {
        segs.push({ key: SYSTEM, label: "System & other", bytes: Math.max(0, volUsed - scanned) });
      } else {
        segs.push({ key: SYSTEM, label: "Used", bytes: volUsed });
      }
      segs.push({ key: FREE, label: "Free", bytes: volume.freeBytes });
    }
    const sum = volume ? volTotal : segs.reduce((n, s) => n + s.bytes, 0);
    return { segments: segs, total: sum };
  }, [report, volume, volTotal, volUsed]);

  const hot = hovered ? segments.find((s) => s.key === hovered) : null;
  const centerTop = hot ? formatSize(hot.bytes) : volume ? formatSize(volUsed) : "—";
  const centerBottom = hot
    ? `${hot.label} · ${pct(hot.bytes, total)}`
    : volume
      ? `used of ${formatSize(volTotal)}`
      : "";

  const folders = report?.folders ?? [];
  const shownFolders = folders.slice(0, 8);
  const restBytes = folders.slice(8).reduce((n, f) => n + f.bytes, 0);
  const maxFolder = Math.max(1, ...shownFolders.map((f) => f.bytes));

  const files = report?.topFiles ?? [];
  const maxFile = Math.max(1, ...files.map((f) => f.size));
  const selectedFiles = files.filter((f) => selected.has(f.path));
  const selectedBytes = selectedFiles.reduce((n, f) => n + f.size, 0);

  const toggle = (index: number, shift: boolean) => {
    setSelected((cur) => {
      const next = new Set(cur);
      const f = files[index];
      if (shift && lastIndex.current !== null) {
        const [a, b] = [lastIndex.current, index].sort((x, y) => x - y);
        const on = !cur.has(f.path);
        for (let i = a; i <= b; i++) {
          if (on) next.add(files[i].path);
          else next.delete(files[i].path);
        }
      } else if (next.has(f.path)) {
        next.delete(f.path);
      } else {
        next.add(f.path);
      }
      return next;
    });
    lastIndex.current = index;
  };

  const allSelected = files.length > 0 && selected.size === files.length;

  // Animate the results in (blur, growing donut and bars) only for a scan that finishes while the page is open.
  const scannedMs = report?.scannedMs ?? null;
  const openedWith = useRef(scannedMs);
  const fresh = scannedMs !== null && scannedMs !== openedWith.current;

  const forget = (gone: string[]) => {
    if (gone.length === 0) return;
    void api
      .diskMapForget(gone)
      .catch(() => [])
      .then((sizes) => {
        useDisk.getState().removeFiles(gone, sizes);
        setMapVersion((v) => v + 1);
      });
  };

  const settle = async (paths: string[]) => {
    const exists = await Promise.all(paths.map((p) => api.pathExists(p).catch(() => true)));
    forget(paths.filter((_, i) => !exists[i]));
  };

  const trashSelected = () => {
    const paths = selectedFiles.map((f) => f.path);
    void trashNow(paths).then(() => settle(paths));
  };

  const deleteSelected = () => {
    const paths = selectedFiles.map((f) => f.path);
    const ids = confirmedIds(paths);
    useUI.getState().openConfirm({
      title: "Delete permanently?",
      message: `Permanently delete ${
        paths.length === 1 ? `"${selectedFiles[0].name}"` : `these ${paths.length} files`
      } (${formatSize(selectedBytes)})? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => void ids.then((ids) => deleteNow(paths, ids)).then(() => settle(paths)),
    });
  };

  const scanButton = scanning ? (
    <button className="btn subtle" onClick={() => useDisk.getState().cancel()}>
      <DismissRegular className="btn-icon" />
      Cancel
    </button>
  ) : (
    <button className="btn accent" onClick={() => void useDisk.getState().scan()}>
      <ArrowSyncRegular className="btn-icon" />
      {report ? "Scan again" : "Scan"}
    </button>
  );

  return (
    <div className={`content disk${scanning ? " scanning" : ""}${scanning && report ? " rescan" : ""}`}>
      <div className="disk-head">
        <div>
          <h1 className="disk-title">Disk usage</h1>
          <div className="disk-sub">
            {report
              ? `${volume?.name ?? "Disk"} · scanned ${report.root} ${ago(report.scannedMs)} · ${report.totalFiles.toLocaleString()} files`
              : `${volume?.name ?? "Disk"} · not scanned yet`}
          </div>
        </div>
        <div className="disk-head-actions">
          {report && !scanning && (
            <button
              className="btn subtle"
              title="Save the largest files and developer folders to a CSV in Downloads"
              onClick={() => void exportCsv(report)}
            >
              <ArrowDownloadRegular className="btn-icon" />
              Export CSV
            </button>
          )}
          {scanButton}
        </div>
      </div>

      {report?.skipped && report.skipped.length > 0 && !scanning && (
        <div className="disk-note">
          Skipped cloud storage: {report.skipped.join(", ")}
        </div>
      )}
      {report?.unreadable ? (
        !scanning && (
          <div className="disk-note">
            {report.unreadable.toLocaleString()}{" "}
            {report.unreadable === 1 ? "folder couldn't" : "folders couldn't"} be read and
            {report.unreadable === 1 ? " isn't" : " aren't"} counted
          </div>
        )
      ) : null}
      {scanning && <ScanStatus progress={progress} />}
      {error && <div className="disk-error">{error}</div>}

      {/* Keys must differ. Otherwise React mixes up the two remounted blocks. */}
      <div key={`grid:${fresh ? scannedMs : "opened"}`} className={`disk-grid${fresh ? " disk-reveal" : ""}`}>
        <section className="disk-card disk-overview" aria-label="Storage overview">
          <Donut
            segments={segments}
            total={total}
            hovered={hovered}
            onHover={setHovered}
            centerTop={centerTop}
            centerBottom={centerBottom}
            scanning={scanning}
          />
          <ul className="disk-legend">
            {segments.map((s) => (
              <li
                key={s.key}
                className={hovered && hovered !== s.key ? "dim" : undefined}
                onMouseEnter={() => setHovered(s.key)}
                onMouseLeave={() => setHovered(null)}
              >
                <span className="disk-dot" style={{ background: colorOf(s.key) }} />
                <span className="disk-legend-name">{s.label}</span>
                <span className="disk-legend-size">{formatSize(s.bytes)}</span>
                <span className="disk-legend-pct">{pct(s.bytes, total)}</span>
              </li>
            ))}
          </ul>
          {!report && !scanning && (
            <p className="disk-hint">
              Scan your home folder to see which kinds of files and which folders use the space.
            </p>
          )}
        </section>

        <section className="disk-card disk-folders" aria-label="Largest folders">
          <h2 className="disk-card-title">Largest folders</h2>
          {shownFolders.length === 0 && scanning ? (
            <ul className="disk-bars disk-ripple" aria-label="Measuring folders">
              {RIPPLE_WIDTHS.map((w, i) => (
                <li key={i} className="disk-bar-rest">
                  <span className="sk-bar" style={{ width: `${40 + ((i * 37) % 45)}%` }} />
                  <span className="disk-bar-track">
                    <span
                      className="disk-ripple-fill"
                      style={{ width: `${w}%`, animationDelay: `${i * 110}ms` }}
                    />
                  </span>
                  <span className="sk-bar" />
                </li>
              ))}
            </ul>
          ) : shownFolders.length === 0 ? (
            <p className="disk-hint">Run a scan to see this.</p>
          ) : (
            <ul className="disk-bars">
              {shownFolders.map((f, i) => (
                <li key={f.path}>
                  <button
                    className="disk-bar-row"
                    title={f.path}
                    onClick={() => navigateTo({ kind: "path", path: f.path })}
                  >
                    <span className="disk-bar-name">{f.name}</span>
                    <span className="disk-bar-track">
                      <span
                        className="disk-bar-fill"
                        style={{
                          width: `${Math.max(1.5, (f.bytes / maxFolder) * 100)}%`,
                          animationDelay: fresh ? `${i * 45}ms` : undefined,
                        }}
                      />
                    </span>
                    <span className="disk-bar-size">{formatSize(f.bytes)}</span>
                  </button>
                </li>
              ))}
              {restBytes > 0 && (
                <li className="disk-bar-rest">
                  <span className="disk-bar-name">{folders.length - 8} more</span>
                  <span className="disk-bar-track" />
                  <span className="disk-bar-size">{formatSize(restBytes)}</span>
                </li>
              )}
            </ul>
          )}
        </section>
      </div>

      {/* Key by scan. A new scan loads its map from its root. */}
      {report &&
        (mapOpen ? (
          <FolderMap
            key={report.scannedMs}
            root={report.root}
            version={mapVersion}
            onForget={forget}
            title={mapTitle}
          />
        ) : (
          <section className="disk-card fmap" aria-label="Folder map">
            <div className="fmap-head">{mapTitle}</div>
          </section>
        ))}

      <section
        key={`files:${fresh ? scannedMs : "opened"}`}
        className={`disk-card disk-files${fresh ? " disk-reveal" : ""}`}
        aria-label="Largest files"
      >
        <div className="disk-files-head">
          {filesTitle}
          {filesOpen && files.length > 0 && (
            <Checkbox
              label="Select all"
              checked={allSelected ? true : selected.size > 0 ? "mixed" : false}
              onChange={() =>
                setSelected(allSelected ? new Set() : new Set(files.map((f) => f.path)))
              }
            />
          )}
        </div>
        {!filesOpen ? null : files.length === 0 && scanning ? (
          <div aria-label="Looking for big files">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skel-row" aria-hidden>
                <span className="sk-thumb" />
                <span className="sk-lines">
                  <span />
                  <span />
                </span>
                <span className="sk-meta" />
              </div>
            ))}
          </div>
        ) : files.length === 0 ? (
          <p className="disk-hint">Run a scan to see this.</p>
        ) : (
          <ul className="disk-filelist">
            {files.map((f, i) => {
              const on = selected.has(f.path);
              return (
                <li
                  key={f.path}
                  className={`disk-file${on ? " selected" : ""}`}
                  onClick={(e) => toggle(i, e.shiftKey)}
                  onDoubleClick={() => useTabs.getState().reveal(f.path)}
                >
                  <Checkbox
                    checked={on}
                    aria-label={`Select ${f.name}`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggle(i, false)}
                  />
                  <span className="ficon">
                    <EntryIcon entry={toEntry(f)} size={22} />
                  </span>
                  <span className="disk-file-text" title={f.path}>
                    <span className="disk-file-name">{f.name}</span>
                    <span className="disk-file-path">{parentOf(f.path)}</span>
                  </span>
                  <span className="disk-chip">
                    <span className="disk-dot" style={{ background: colorOf(f.category) }} />
                    {CATEGORY_LABEL[f.category]}
                  </span>
                  <span className="disk-file-date">{formatDate(f.modifiedMs)}</span>
                  <span className="disk-file-bar" aria-hidden>
                    <span
                      style={{
                        width: `${Math.max(2, (f.size / maxFile) * 100)}%`,
                        background: colorOf(f.category),
                      }}
                    />
                  </span>
                  <span className="disk-file-size">{formatSize(f.size)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {report?.devFolders && report.devFolders.length > 0 && (
        <DevFolders items={report.devFolders} onTrash={(p) => void trashNow([p]).then(() => settle([p]))} />
      )}

      <DiskDuplicates title={dupesTitle} open={dupesOpen} />

      {selectedFiles.length > 0 && (
        <div className="disk-actionbar" role="toolbar" aria-label="Selected files">
          <span className="disk-actionbar-count">
            {selectedFiles.length} selected · {formatSize(selectedBytes)}
          </span>
          {selectedFiles.length === 1 && (
            <button
              className="btn subtle compact"
              onClick={() => useTabs.getState().reveal(selectedFiles[0].path)}
            >
              <FolderOpenRegular className="btn-icon" />
              Show in folder
            </button>
          )}
          <button className="btn subtle compact" onClick={trashSelected}>
            <DeleteRegular className="btn-icon" />
            Move to Trash
          </button>
          <button className="btn subtle compact disk-danger" onClick={deleteSelected}>
            Delete permanently
          </button>
          <button className="btn ghost compact" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
