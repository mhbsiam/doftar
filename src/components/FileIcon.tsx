import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../ipc";
import { useSettings } from "../stores/settings";
import { useFileIds } from "../stores/fileIds";
import { folderStops, type FolderColorId } from "../util/folderColors";
import { extColor, fileKind, isFolder, isImageExt, isQuickLookExt } from "../util/kinds";
import type { FileEntry } from "../types";

/**
 * This folder's own color, if it has one. List entries carry their file id;
 * icons that only know a path look the id up.
 */
function useOwnFolderColor(path?: string, fileId?: string): FolderColorId | undefined {
  const looked = useFileIds((s) => (fileId || !path ? undefined : s.byPath[path]));
  useEffect(() => {
    if (!fileId && path) void useFileIds.getState().refresh([path]);
  }, [fileId, path]);
  const id = fileId ?? looked;
  return useSettings((s) => (id ? s.folderColors[id] : undefined));
}

/** The color id a folder at `path` is drawn in: its own, else the default. */
export function useFolderColor(path?: string): FolderColorId {
  const own = useOwnFolderColor(path);
  const fallback = useSettings((s) => s.folderColor);
  return own ?? fallback;
}

const TRASH_RED = "#d13438";
const TRASH_BODY =
  "M4.8 7h10.4l-.8 9a1.5 1.5 0 0 1-1.5 1.4H7.1A1.5 1.5 0 0 1 5.6 16z";

/**
 * A trash can that fills from the bottom as `fraction` (0–1) of its limit is
 * used, in the folder color; at the limit it is filled and outlined in red.
 */
export function TrashIcon({
  fraction,
  colorId,
  size = 20,
}: {
  fraction: number;
  colorId: FolderColorId;
  size?: number;
}) {
  const full = fraction >= 1;
  const level = fraction > 0 ? Math.min(1, Math.max(0.1, fraction)) : 0;
  const top = 17.4 - level * 10.4;
  const [, base] = folderStops(colorId);
  const clip = `wf-trash-clip-${size}`;
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <defs>
        <clipPath id={clip}>
          <path d={TRASH_BODY} />
        </clipPath>
      </defs>
      {level > 0 && (
        <rect
          x="0"
          y={top}
          width="20"
          height={20 - top}
          fill={full ? TRASH_RED : base}
          clipPath={`url(#${clip})`}
        />
      )}
      <g
        stroke={full ? TRASH_RED : "currentColor"}
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 5.5h14M7.6 5.5V4.3a.8.8 0 0 1 .8-.8h3.2a.8.8 0 0 1 .8.8v1.2" />
        <path d={TRASH_BODY} />
      </g>
    </svg>
  );
}

export function WinFolderIcon({
  size = 16,
  path,
  fileId,
}: {
  size?: number;
  path?: string;
  fileId?: string;
}) {
  const own = useOwnFolderColor(path, fileId);
  const fallback = useSettings((s) => s.folderColor);
  const colorId: FolderColorId = own ?? fallback;
  const [b1, b2, f1, f2] = folderStops(colorId);
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <defs>
        <linearGradient id={`wf-folder-${colorId}-back`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={b1} />
          <stop offset="1" stopColor={b2} />
        </linearGradient>
        <linearGradient id={`wf-folder-${colorId}-front`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={f1} />
          <stop offset="1" stopColor={f2} />
        </linearGradient>
      </defs>
      <path
        d="M2 7.5A2.5 2.5 0 0 1 4.5 5h7.1c.7 0 1.37.3 1.84.82L15.6 8.2H27.5A2.5 2.5 0 0 1 30 10.7V25a2.5 2.5 0 0 1-2.5 2.5h-23A2.5 2.5 0 0 1 2 25V7.5z"
        fill={`url(#wf-folder-${colorId}-back)`}
      />
      <path
        d="M2 13.2A2.2 2.2 0 0 1 4.2 11h23.6a2.2 2.2 0 0 1 2.2 2.2V25a2.5 2.5 0 0 1-2.5 2.5h-23A2.5 2.5 0 0 1 2 25V13.2z"
        fill={`url(#wf-folder-${colorId}-front)`}
      />
      <path d="M2 13.2A2.2 2.2 0 0 1 4.2 11h23.6a2.2 2.2 0 0 1 2.2 2.2v.6H2v-.6z" fill="#fff" opacity="0.35" />
    </svg>
  );
}

export type KnownFolder = "desktop" | "documents" | "downloads";

export function knownFolderKind(name: string): KnownFolder | null {
  switch (name) {
    case "Desktop":
      return "desktop";
    case "Documents":
      return "documents";
    case "Downloads":
      return "downloads";
    default:
      return null;
  }
}

const KNOWN_TINT: Record<KnownFolder, [string, string, string, string]> = {
  desktop: ["#5aa2f0", "#2f7fd6", "#9ccbfb", "#5fa6ef"],
  documents: ["#8c9bb3", "#64748f", "#c7d2e2", "#9aa9c0"],
  downloads: ["#5fc26b", "#33a04a", "#a9e4b0", "#6cc978"],
};

export function WinKnownFolderIcon({
  kind,
  size = 16,
  path,
  fileId,
}: {
  kind: KnownFolder;
  size?: number;
  path?: string;
  fileId?: string;
}) {
  const own = useOwnFolderColor(path, fileId);
  const [b1, b2, f1, f2] = own ? folderStops(own) : KNOWN_TINT[kind];
  const id = `wf-known-${kind}-${own ?? "default"}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <defs>
        <linearGradient id={`${id}-back`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={b1} />
          <stop offset="1" stopColor={b2} />
        </linearGradient>
        <linearGradient id={`${id}-front`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={f1} />
          <stop offset="1" stopColor={f2} />
        </linearGradient>
      </defs>
      <path
        d="M2 7.5A2.5 2.5 0 0 1 4.5 5h7.1c.7 0 1.37.3 1.84.82L15.6 8.2H27.5A2.5 2.5 0 0 1 30 10.7V25a2.5 2.5 0 0 1-2.5 2.5h-23A2.5 2.5 0 0 1 2 25V7.5z"
        fill={`url(#${id}-back)`}
      />
      <path
        d="M2 13.2A2.2 2.2 0 0 1 4.2 11h23.6a2.2 2.2 0 0 1 2.2 2.2V25a2.5 2.5 0 0 1-2.5 2.5h-23A2.5 2.5 0 0 1 2 25V13.2z"
        fill={`url(#${id}-front)`}
      />
      <g fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {kind === "desktop" && (
          <>
            <rect x="10" y="14.5" width="12" height="7.5" rx="1.2" fill="#fff" fillOpacity="0.35" />
            <path d="M16 22v2.3M13 24.3h6" />
          </>
        )}
        {kind === "documents" && (
          <>
            <path d="M12 14.5h5.5l3 3V24h-8.5z" fill="#fff" fillOpacity="0.35" />
            <path d="M14.3 19.2h3.4M14.3 21.6h3.4" strokeWidth="1.4" />
          </>
        )}
        {kind === "downloads" && (
          <>
            <path d="M16 14v7.2M12.6 18l3.4 3.4 3.4-3.4" />
            <path d="M12 24h8" />
          </>
        )}
      </g>
    </svg>
  );
}

function KindGlyph({ kind, color }: { kind: ReturnType<typeof fileKind>; color: string }) {
  switch (kind) {
    case "image":
      return (
        <>
          <rect x="8.5" y="12" width="15" height="12" rx="1.5" fill={color} opacity="0.18" />
          <path d="M9.5 22.5 14 17l3.2 3.6 2.2-2.3 3.1 4.2H9.5z" fill={color} />
          <circle cx="19.5" cy="15.2" r="1.6" fill={color} />
        </>
      );
    case "video":
      return (
        <>
          <rect x="8.5" y="12.5" width="15" height="11" rx="1.5" fill={color} opacity="0.18" />
          <path d="M14 14.8v6.4l5.2-3.2L14 14.8z" fill={color} />
        </>
      );
    case "audio":
      return (
        <>
          <path d="M13.6 22.3V13l8.4-1.7v8.7" fill="none" stroke={color} strokeWidth="1.7" strokeLinejoin="round" />
          <circle cx="11.8" cy="22.3" r="2" fill={color} />
          <circle cx="20.2" cy="20.2" r="2" fill={color} />
        </>
      );
    case "archive":
      return (
        <>
          <rect x="13.5" y="12" width="5" height="12" rx="1" fill={color} opacity="0.2" />
          <path d="M16 12.5v1.6M16 15.6v1.6M16 18.7v1.6" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
          <rect x="14" y="21" width="4" height="3" rx="0.8" fill={color} />
        </>
      );
    case "pdf":
      return (
        <>
          <rect x="7.5" y="14" width="17" height="8" rx="1.5" fill={color} />
          <text x="16" y="20.3" fontSize="6" fontWeight="700" fontFamily="system-ui, sans-serif" fill="#fff" textAnchor="middle">
            PDF
          </text>
        </>
      );
    case "code":
      return (
        <path
          d="m12.5 14.5-3.5 3.5 3.5 3.5M19.5 14.5l3.5 3.5-3.5 3.5M17.3 13l-2.6 10"
          fill="none"
          stroke={color}
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case "sheet":
      return (
        <>
          <rect x="8.5" y="12.5" width="15" height="11" rx="1" fill="none" stroke={color} strokeWidth="1.4" />
          <path d="M8.5 16.2h15M8.5 19.8h15M13.5 12.5v11" stroke={color} strokeWidth="1.2" />
        </>
      );
    case "slides":
      return (
        <>
          <rect x="8.5" y="12.5" width="15" height="9.5" rx="1" fill={color} opacity="0.18" />
          <rect x="11" y="15" width="6" height="4.5" rx="0.8" fill={color} />
          <path d="M16 22v2.5M13 24.5h6" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
        </>
      );
    case "doc":
    case "text":
      return (
        <>
          <rect x="8.5" y="13" width="15" height="2" rx="1" fill={color} />
          <rect x="8.5" y="17" width="15" height="2" rx="1" fill={color} opacity="0.55" />
          <rect x="8.5" y="21" width="9" height="2" rx="1" fill={color} opacity="0.55" />
        </>
      );
    default:
      return (
        <>
          <rect x="8.5" y="14" width="15" height="4.5" rx="1" fill={color} />
          <rect x="8.5" y="21" width="10" height="2" rx="1" fill="#c3c9cf" />
        </>
      );
  }
}

export function WinFileIcon({
  entry,
  size = 16,
}: {
  entry: Pick<FileEntry, "isDir" | "ext"> & { isPackage?: boolean };
  size?: number;
}) {
  const color = extColor(entry);
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <defs>
        <linearGradient id="wf-page" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#f1f3f6" />
        </linearGradient>
      </defs>
      <path
        d="M7 3h12.2L26 9.8V27c0 1.1-.9 2-2 2H7c-1.1 0-2-.9-2-2V5c0-1.1.9-2 2-2z"
        fill="url(#wf-page)"
        stroke="#a8aeb6"
        strokeWidth="1.2"
      />
      <path d="M19.2 3 26 9.8h-5.4c-.77 0-1.4-.63-1.4-1.4V3z" fill="#dde1e6" />
      <KindGlyph kind={fileKind(entry.ext)} color={color} />
    </svg>
  );
}

export function WinDriveIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <defs>
        <linearGradient id="wf-drive-top" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f2f4f8" />
          <stop offset="1" stopColor="#d7dce4" />
        </linearGradient>
        <linearGradient id="wf-drive-front" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8b93a1" />
          <stop offset="1" stopColor="#5f6773" />
        </linearGradient>
      </defs>
      <rect x="3" y="8" width="26" height="12" rx="2.5" fill="url(#wf-drive-top)" />
      <path d="M3 18h26v4.5a2.5 2.5 0 0 1-2.5 2.5h-21A2.5 2.5 0 0 1 3 22.5V18z" fill="url(#wf-drive-front)" />
      <circle cx="24.5" cy="21.5" r="1.4" fill="#6ccf5c" />
      <rect x="6.5" y="20.3" width="9" height="2.2" rx="1.1" fill="#fff" opacity="0.25" />
    </svg>
  );
}

/** A drive for a share on another machine: the drive with a network link badge. */
export function WinNetworkDriveIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <defs>
        <linearGradient id="wf-net-top" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f2f4f8" />
          <stop offset="1" stopColor="#d7dce4" />
        </linearGradient>
        <linearGradient id="wf-net-front" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5b8fd6" />
          <stop offset="1" stopColor="#3a6bb0" />
        </linearGradient>
      </defs>
      <rect x="3" y="8" width="26" height="12" rx="2.5" fill="url(#wf-net-top)" />
      <path d="M3 18h26v4.5a2.5 2.5 0 0 1-2.5 2.5h-21A2.5 2.5 0 0 1 3 22.5V18z" fill="url(#wf-net-front)" />
      <circle cx="24.5" cy="21.5" r="1.4" fill="#fff" />
      <rect x="6.5" y="20.3" width="9" height="2.2" rx="1.1" fill="#fff" opacity="0.3" />
      <g fill="none" stroke="#3a6bb0" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="16" cy="12.6" r="3.1" />
        <path d="M12.9 12.6h6.2M16 9.5c-1.5 1.6-1.5 4.6 0 6.2M16 9.5c1.5 1.6 1.5 4.6 0 6.2" strokeWidth="1" />
      </g>
    </svg>
  );
}

export function DriveMeter({
  usedBytes,
  totalBytes,
}: {
  usedBytes: number;
  totalBytes: number;
}) {
  const frac = totalBytes > 0 ? Math.min(1, usedBytes / totalBytes) : 0;
  return (
    <span
      className={`drive-meter${frac >= 0.9 ? " full" : ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(frac * 100)}
    >
      <span className="drive-meter-fill" style={{ transform: `scaleX(${frac})` }} />
    </span>
  );
}

export function WinTerminalIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect
        x="1"
        y="2.5"
        width="14"
        height="11"
        rx="1.8"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M4 6l2.5 2L4 10"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 10.5h4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ShortcutBadge({ size }: { size: number }) {
  const s = Math.max(10, Math.round(size * 0.42));
  return (
    <svg className="shortcut-badge" width={s} height={s} viewBox="0 0 16 16">
      <rect x="0.5" y="0.5" width="15" height="15" rx="2" fill="#fff" stroke="#8a8f98" />
      <path
        d="M5 11.5V9a3 3 0 0 1 3-3h3M9 3.8 11.5 6 9 8.2"
        fill="none"
        stroke="#0067c0"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const THUMB_PX = 160;
const NATIVE_FALLBACK = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const NATIVE_FALLBACK_MAX_BYTES = 2 * 1024 * 1024;
const THUMB_CACHE_MAX = 3000;

const thumbKey = (e: FileEntry) => `${e.path}|${e.modifiedMs}|${e.size}`;
const settled = new Map<string, string | null>();

function remember(key: string, url: string | null) {
  settled.set(key, url);
  while (settled.size > THUMB_CACHE_MAX) {
    settled.delete(settled.keys().next().value as string);
  }
}

/** Forgets `entry`'s remembered thumbnail; true when there was one. */
function forgetThumbnail(entry: FileEntry): boolean {
  return settled.delete(thumbKey(entry));
}

/** Forgets the in-memory thumbnail results (the disk cache is cleared separately). */
export function clearThumbnailMemory() {
  settled.clear();
}

interface ThumbJob {
  id: number;
  refs: number;
  done: boolean;
  promise: Promise<string | null | typeof CANCELLED>;
}
const CANCELLED = Symbol("cancelled");
const jobs = new Map<string, ThumbJob>();
let nextThumbId = Date.now(); // see nextStreamId in ipc.ts

/**
 * Starts (or joins) making a thumbnail. `release` says this row no longer
 * needs it; once nobody does, the request is cancelled, so scrolling past
 * hundreds of images leaves no queue of work behind.
 */
function acquireThumb(entry: FileEntry): { promise: ThumbJob["promise"]; release: () => void } {
  const key = thumbKey(entry);
  let job = jobs.get(key);
  if (!job) {
    const id = nextThumbId++;
    // A failure that may pass (a cloud file not downloaded yet, a timeout)
    // isn't remembered, so the icon asks again next time it's shown.
    let transient = false;
    const made: ThumbJob = {
      id,
      refs: 0,
      done: false,
      promise: api
        .thumbnail(entry.path, THUMB_PX, id)
        .then((file) => convertFileSrc(file) as string | null | typeof CANCELLED)
        .catch((err) => {
          if (String(err) === "cancelled") return CANCELLED;
          transient = String(err).startsWith("transient: ");
          return !transient &&
            NATIVE_FALLBACK.has(entry.ext) &&
            entry.size <= NATIVE_FALLBACK_MAX_BYTES
            ? convertFileSrc(entry.path)
            : null;
        })
        .then((url) => {
          made.done = true;
          if (jobs.get(key) === made) jobs.delete(key);
          if (url !== CANCELLED && !transient) remember(key, url);
          return url;
        }),
    };
    jobs.set(key, made);
    job = made;
  }
  const mine = job;
  mine.refs++;
  let released = false;
  return {
    promise: mine.promise,
    release: () => {
      if (released) return;
      released = true;
      if (--mine.refs === 0 && !mine.done) {
        // Nobody is looking any more: stop it, and let a later row start fresh.
        if (jobs.get(key) === mine) jobs.delete(key);
        void api.cancelThumbnail(mine.id).catch(() => {});
      }
    },
  };
}

/**
 * The thumbnail's URL, and whether it was made just now. One remembered, or
 * read from the disk cache, shows at once; a fresh one arrives late and so
 * fades in rather than popping into a row already drawn.
 */
function useThumbnail(
  entry: FileEntry,
  wanted: boolean,
  attempt: number
): { url: string | null; fresh: boolean } {
  const key = thumbKey(entry);
  const [state, setState] = useState<{ url: string | null; fresh: boolean }>(() => ({
    url: wanted ? (settled.get(key) ?? null) : null,
    fresh: false,
  }));
  const setUrl = (url: string | null, fresh = false) => setState({ url, fresh });
  useEffect(() => {
    if (!wanted) {
      setUrl(null);
      return;
    }
    if (settled.has(key)) {
      setUrl(settled.get(key) ?? null);
      return;
    }
    setUrl(null);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let release: (() => void) | null = null;
    const generate = () => {
      const job = acquireThumb(entry);
      release = job.release;
      void job.promise.then((u) => {
        if (live && u !== CANCELLED) setUrl(u, true);
      });
    };
    // What is already on disk (everything, after a restart) shows at once.
    // Only a miss waits out the scroll before spending effort on making it.
    api
      .thumbnailCached(entry.path, THUMB_PX)
      .then((file) => {
        if (!live) return;
        if (file) {
          const u = convertFileSrc(file);
          remember(key, u);
          setUrl(u);
        } else {
          timer = setTimeout(generate, 80);
        }
      })
      .catch(() => {
        if (live) timer = setTimeout(generate, 80);
      });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      release?.();
    };
  }, [key, wanted, attempt]);
  return state;
}

export function EntryIcon({ entry, size = 20 }: { entry: FileEntry; size?: number }) {
  const icon = <BaseIcon entry={entry} size={size} />;
  if (!entry.isSymlink && !entry.isAlias) return icon;
  return (
    <span className="icon-badged" style={{ width: size, height: size }}>
      {icon}
      <ShortcutBadge size={size} />
    </span>
  );
}

function BaseIcon({ entry, size }: { entry: FileEntry; size: number }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const isApp = entry.isDir && entry.ext === "app";
  // Options → Privacy can keep previews of other volumes off this Mac entirely.
  const externalThumbs = useSettings((s) => s.externalThumbnails);
  const allowed = externalThumbs || !entry.path.startsWith("/Volumes/");
  const wanted =
    allowed &&
    (isApp ||
      (!isFolder(entry) &&
        ((isImageExt(entry.ext) && entry.ext !== "svg") || isQuickLookExt(entry.ext))));
  const { url, fresh } = useThumbnail(entry, wanted && !failed, attempt);
  if (isFolder(entry)) return <WinFolderIcon size={size} path={entry.path} fileId={entry.fileId} />;
  if (url) {
    return (
      <img
        className={`thumb${isApp ? " app" : ""}${fresh ? " fresh" : ""}`}
        style={{ width: size, height: size }}
        src={url}
        alt=""
        decoding="async"
        draggable={false}
        onError={() => {
          // A remembered thumbnail can vanish from disk (a drive's previews
          // are deleted when it is unplugged): make it again, once.
          if (attempt === 0 && forgetThumbnail(entry)) setAttempt(1);
          else setFailed(true);
        }}
      />
    );
  }
  return <WinFileIcon entry={entry} size={size} />;
}
