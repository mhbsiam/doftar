import { useEffect, useMemo, useRef, useState } from "react";
import { Checkbox, Spinner } from "@fluentui/react-components";
import {
  ArrowSyncRegular,
  DeleteRegular,
  DismissRegular,
  FolderOpenRegular,
} from "@fluentui/react-icons";
import { EntryIcon } from "./FileIcon";
import { FolderMap } from "./FolderMap";
import { useDisk } from "../stores/disk";
import { useUI } from "../stores/ui";
import { useTabs, usePaneStore, parentOf } from "../stores/tabs";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { api } from "../ipc";
import { deleteNow, navigateTo, setViewEntries, trashNow } from "../actions";
import { formatDate, formatSize } from "../util/format";
import type { DiskCategory, DiskFile, FileEntry } from "../types";

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
}) {
  const { segments, total, hovered, onHover, centerTop, centerBottom } = props;
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
      </svg>
      <div className="disk-donut-center">
        <div className="disk-donut-top">{centerTop}</div>
        <div className="disk-donut-bottom">{centerBottom}</div>
      </div>
    </div>
  );
}

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

export function DiskView() {
  const { report, scanning, progress, error } = useDisk();
  const info = useSystemInfo();
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Bumped when items leave the folder map, so it reloads. */
  const [mapVersion, setMapVersion] = useState(0);
  const lastIndex = useRef<number | null>(null);

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

  /** Items gone from the disk leave the report and the folder map. */
  const forget = (gone: string[]) => {
    if (gone.length === 0) return;
    useDisk.getState().removeFiles(gone);
    void api
      .diskMapForget(gone)
      .catch(() => {})
      .then(() => setMapVersion((v) => v + 1));
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
    useUI.getState().openConfirm({
      title: "Delete permanently?",
      message: `Permanently delete ${
        paths.length === 1 ? `"${selectedFiles[0].name}"` : `these ${paths.length} files`
      } (${formatSize(selectedBytes)})? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => void deleteNow(paths).then(() => settle(paths)),
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
    <div className="content disk">
      <div className="disk-head">
        <div>
          <h1 className="disk-title">Disk usage</h1>
          <div className="disk-sub">
            {report
              ? `${volume?.name ?? "Disk"} · scanned ${report.root} ${ago(report.scannedMs)} · ${report.totalFiles.toLocaleString()} files`
              : `${volume?.name ?? "Disk"} · not scanned yet`}
          </div>
        </div>
        {scanButton}
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
      {scanning && (
        <div className="disk-progress" role="status">
          <div className="disk-progress-bar" />
          <div className="disk-progress-text">
            <Spinner size="extra-tiny" />
            <span>
              Scanning · {formatSize(progress?.bytes ?? 0)} · {(progress?.files ?? 0).toLocaleString()} files
            </span>
            <span className="disk-progress-path">{progress?.current ?? ""}</span>
          </div>
        </div>
      )}
      {error && <div className="disk-error">{error}</div>}

      <div className="disk-grid">
        <section className="disk-card disk-overview" aria-label="Storage overview">
          <Donut
            segments={segments}
            total={total}
            hovered={hovered}
            onHover={setHovered}
            centerTop={centerTop}
            centerBottom={centerBottom}
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
          {shownFolders.length === 0 ? (
            <p className="disk-hint">{scanning ? "Measuring folders…" : "Run a scan to see this."}</p>
          ) : (
            <ul className="disk-bars">
              {shownFolders.map((f) => (
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
                        style={{ width: `${Math.max(1.5, (f.bytes / maxFolder) * 100)}%` }}
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

      {report && <FolderMap root={report.root} version={mapVersion} onForget={forget} />}

      <section className="disk-card disk-files" aria-label="Largest files">
        <div className="disk-files-head">
          <h2 className="disk-card-title">Largest files</h2>
          {files.length > 0 && (
            <Checkbox
              label="Select all"
              checked={allSelected ? true : selected.size > 0 ? "mixed" : false}
              onChange={() =>
                setSelected(allSelected ? new Set() : new Set(files.map((f) => f.path)))
              }
            />
          )}
        </div>
        {files.length === 0 ? (
          <p className="disk-hint">{scanning ? "Looking for big files…" : "Run a scan to see this."}</p>
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
