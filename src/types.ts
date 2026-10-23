export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isHidden: boolean;
  isSymlink: boolean;
  /** A Finder alias file; absent on synthetic entries. */
  isAlias?: boolean;
  isPackage: boolean;
  size: number;
  modifiedMs: number;
  createdMs: number;
  ext: string;
  /** Stable identity (device:inode); absent on synthetic entries. */
  fileId?: string;
  /** Finder tags, oldest first; absent when there are none. */
  tags?: Tag[];
}

export interface VolumeInfo {
  name: string;
  path: string;
  totalBytes: number;
  freeBytes: number;
  ejectable: boolean;
  isNetwork?: boolean;
}

export interface SystemInfo {
  home: string;
  bootVolumeName: string;
  volumes: VolumeInfo[];
}

export type Location =
  | { kind: "home" }
  | { kind: "disk" }
  | { kind: "path"; path: string }
  /** Every tagged item by tag, or all items with one tag. */
  | { kind: "tags"; tag?: string };

export type ViewMode = "details" | "grid";
export type SortKey = "name" | "modified" | "type" | "size";
export type GroupBy = "none" | "name" | "created" | "type" | "tags";
export type ContentFilter = "all" | "folders" | "files";

export interface FavItem {
  path: string;
  name: string;
  dirName: string;
  modifiedMs: number;
  isDir?: boolean;
}

export interface RecentItem {
  path: string;
  name: string;
  dirName: string;
  ts: number;
}

export interface PersistedStore {
  pins?: string[];
  favorites?: FavItem[];
  recents?: RecentItem[];
  trashOrigins?: Record<string, string>;
}

export interface Progress {
  bytesDone: number;
  bytesTotal: number;
  itemsDone: number;
  itemsTotal: number;
  current: string;
  scanning: boolean;
}

export type Step =
  // `id` names the item the backend made the step for; it refuses a step
  // whose path now holds another item.
  | { kind: "move"; from: string; to: string; id?: string }
  | { kind: "copy"; from: string; to: string }
  | { kind: "trash"; path: string; id?: string };

export interface OpResult {
  inverse: Step[];
  cancelled: boolean;
  errors: string[];
}

export interface PasteboardFiles {
  paths: string[];
  changeCount: number;
}

export type Resolution = "replace" | "skip" | "keepBoth";

export interface ConflictSide {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  modifiedMs: number;
}

export interface Conflict {
  source: ConflictSide;
  existing: ConflictSide;
  canReplace: boolean;
}

export type Resolutions = Record<string, Resolution>;

export interface SearchSummary {
  count: number;
  truncated: boolean;
  source: "spotlight" | "scan";
}

export interface Tag {
  name: string;
  /** Finder's label colour: 0 none, 1 gray, 2 green, 3 purple, 4 blue, 5 yellow, 6 red, 7 orange. */
  color: number;
}

/** A folder narrowed to tagged items. */
export interface TagFilter {
  /** Tag names to show (any of them); empty with `any` for every tagged item. */
  names: string[];
  any: boolean;
  /** Look through subfolders too (through Spotlight). */
  deep: boolean;
}

export interface TagEdit {
  /** Each item's tags after the edit, by path. */
  tags: Record<string, Tag[]>;
  errors: string[];
}

export interface ItemInfo {
  size: number;
  sizeOnDisk: number;
  mode: number;
  owner: string;
  group: string;
  createdMs: number;
  modifiedMs: number;
  accessedMs: number;
  symlinkTarget: string | null;
  tags: Tag[];
  defaultApp: string | null;
  /** Still carries macOS's download mark, so Gatekeeper checks it on first open. */
  quarantined: boolean;
  /** Where it was downloaded from, as the browser recorded it (file address first). */
  whereFroms: string[];
}

export interface SizeProgress {
  bytes: number;
  onDisk: number;
  files: number;
  folders: number;
  done: boolean;
  cancelled: boolean;
  /** A folder asked about couldn't be read at all, so the counts are not an answer. */
  denied: boolean;
}

export interface AppInfo {
  name: string;
  path: string;
  isDefault: boolean;
}

export interface ScanProgress {
  bytes: number;
  files: number;
  current: string;
}

export type DiskCategory =
  | "apps"
  | "images"
  | "video"
  | "audio"
  | "documents"
  | "archives"
  | "code"
  | "other";

export interface DiskFile {
  path: string;
  name: string;
  size: number;
  modifiedMs: number;
  category: DiskCategory;
}

export interface DiskFolder {
  name: string;
  path: string;
  bytes: number;
  isDir: boolean;
}

/** A piece of the folder map: a folder, app or big file, or a folder's smaller items. */
export interface DiskMapNode {
  name: string;
  /** None for "Smaller items". */
  path?: string;
  bytes: number;
  kind: "dir" | "app" | "file" | "rest";
  cat: DiskCategory;
  children?: DiskMapNode[];
}

export interface DiskReport {
  root: string;
  totalBytes: number;
  totalFiles: number;
  folders: DiskFolder[];
  categories: { key: DiskCategory; bytes: number; files: number }[];
  topFiles: DiskFile[];
  scannedMs: number;
  cancelled: boolean;
  skipped?: string[];
  /** Folders that couldn't be read, so their contents aren't counted. */
  unreadable?: number;
}

/** A rect in CSS pixels from the window's top-left. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A rect in CSS pixels from the window's top-left, for anchoring native popovers. */
export interface ShareAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A tab's history and selection, handed to the window it is dragged into. */
export interface PortableTab {
  history: Location[];
  historyIndex: number;
  selection: string[];
  anchor: string | null;
}

/** What the image viewer is asked to show. */
export interface ViewerOpen {
  path: string;
  /** The folder's paths in the order Doftar lists them, when opened from a listing. */
  order: string[] | null;
  /** Its thumbnail is flying in: tell the backend once the image is drawn. */
  flown?: boolean;
}

/** What the reader is asked to show. */
export interface ReaderOpen {
  path: string;
}

/** A node of a parsed Markdown document; see `Node` in src-tauri/src/markdown.rs. */
export type MdNode =
  | { t: "para"; c: MdNode[] }
  | { t: "heading"; level: number; id: string; c: MdNode[] }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; kind: "note" | "tip" | "important" | "warning" | "caution" | null; c: MdNode[] }
  | { t: "list"; start: number | null; c: MdNode[] }
  | { t: "item"; task: boolean | null; c: MdNode[] }
  | { t: "table"; align: ("left" | "center" | "right" | "")[]; c: MdNode[] }
  | { t: "head" | "row" | "cell"; c: MdNode[] }
  | { t: "rule" }
  | { t: "footnoteDef"; label: string; c: MdNode[] }
  | { t: "meta"; text: string }
  | { t: "htmlBlock"; center: boolean; c: MdNode[] }
  | { t: "displayMath" | "text" | "inlineCode" | "inlineMath"; v: string }
  | { t: "emph" | "strong" | "strike" | "sup" | "sub" | "kbd"; c: MdNode[] }
  | { t: "link"; href: string; title: string; c: MdNode[] }
  | { t: "image"; src: string; alt: string; title: string; width: number | null }
  | { t: "break" }
  | { t: "footnoteRef"; label: string };

/** A file as the reader shows it; see `Document` in src-tauri/src/reader.rs. */
export type ReaderDoc = {
  /** Last modified, in milliseconds since 1970. */
  modified: number;
} & (
  | { kind: "markdown"; blocks: MdNode[] }
  | { kind: "text"; text: string }
  | { kind: "code"; lang: string; text: string }
);

/** The PDF viewer's toolbar state; see `PdfState` in src-tauri/src/pdf.rs. */
export interface PdfState {
  path: string | null;
  /** Why the document isn't showing, when it isn't. */
  error: string | null;
  locked: boolean;
  pages: number;
  /** The page in view, from 0. */
  page: number;
  /** 1 is actual size. */
  scale: number;
  fit: boolean;
  twoUp: boolean;
  thumbnails: boolean;
  /** Whether the last search found anything; null before a search. */
  found: boolean | null;
}

/** A request from the PDF viewer's toolbar; see `PdfAction` in src-tauri/src/pdf.rs. */
export type PdfAction =
  | { do: "page"; index: number }
  | { do: "step"; delta: number }
  | { do: "zoomIn" | "zoomOut" | "fit" | "actualSize" | "selectAll" | "focus" }
  | { do: "twoUp" | "thumbnails"; on: boolean }
  | { do: "find"; query: string; backwards: boolean }
  | { do: "unlock"; password: string }
  | { do: "inset"; top: number }
  | { do: "theme"; dark: boolean };

/** A rectangle in image pixels. */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A turn, flip and crop of an image, applied in that order to it as shown. */
export interface ImageEdit {
  /** Quarter turns clockwise. */
  turns: number;
  /** Mirrored left to right after turning. */
  mirror: boolean;
  /** The part to keep, in pixels of the turned and mirrored image. */
  crop: PixelRect | null;
}
