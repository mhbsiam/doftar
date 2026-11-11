export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isHidden: boolean;
  isSymlink: boolean;
  /** Absent on synthetic entries. */
  isAlias?: boolean;
  isPackage: boolean;
  size: number;
  modifiedMs: number;
  createdMs: number;
  ext: string;
  /** Device and inode. Absent on synthetic entries. */
  fileId?: string;
  /** Oldest first. */
  tags?: Tag[];
  /** A cloud file with no content on this Mac. */
  isDataless?: boolean;
}

/** A "changed" folder has changes inside. */
export type GitCode = "modified" | "added" | "untracked" | "conflicted" | "changed";

export interface GitInfo {
  branch: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: number;
  /** Direct children only, by name. */
  files: Record<string, GitCode>;
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  summary: string;
  /** Unix seconds of the last commit. */
  time: number;
  /** Another worktree has it checked out. */
  worktree: string | null;
}

export interface GitWorktree {
  path: string;
  branch: string;
  main: boolean;
  current: boolean;
}

export interface GitCommit {
  id: string;
  summary: string;
  author: string;
  time: number;
  parents: string[];
  refs: string[];
}

export interface GitOverview {
  root: string;
  branches: GitBranch[];
  remotes: number;
  worktrees: GitWorktree[];
  stashes: string[];
  commits: GitCommit[];
}

export interface GitRepo {
  path: string;
  branch: string;
  localOnly: boolean;
  /** Unix seconds. Null before the first commit. */
  lastCommit: number | null;
}

export interface Skill {
  name: string;
  /** The skill folder, or the symlink to it. */
  path: string;
  description: string;
  /** The folder with symlinks resolved. Copies that share it are one skill. */
  real: string;
  linked: boolean;
}

export interface SkillPlace {
  id: string;
  label: string;
  dir: string;
  skills: Skill[];
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
  | { kind: "tags"; tag?: string }
  | { kind: "screenshots" }
  | { kind: "skills" }
  | { kind: "repos" }
  | { kind: "compare"; a: string; b: string };

export type ViewMode = "details" | "grid" | "columns";
export type SortKey = "name" | "modified" | "created" | "type" | "size";
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
  /** Times opened. Only folders count them. */
  visits?: number;
}

/** Where a trashed item came from. `id` tells it apart from a later item at the same Trash path. */
export interface TrashOrigin {
  origin: string;
  id?: string;
}

export interface PersistedStore {
  pins?: string[];
  favorites?: FavItem[];
  recents?: RecentItem[];
  recentFolders?: RecentItem[];
  trashOrigins?: Record<string, TrashOrigin>;
  /** Oldest first. */
  history?: { label: string; steps: Step[]; at?: number; sources?: string[] }[];
  /** Actions that cannot be undone, such as permanent deletes. Oldest first. */
  activity?: { label: string; steps: Step[]; at?: number; sources?: string[] }[];
}

export interface ArchiveEntry {
  path: string;
  size: number;
  isDir: boolean;
}

export interface ArchiveListing {
  entries: ArchiveEntry[];
  truncated: boolean;
}

export interface DupeGroup {
  size: number;
  paths: string[];
}

export interface DupeReport {
  groups: DupeGroup[];
  wasted: number;
  cancelled: boolean;
  truncated: boolean;
}

export interface Progress {
  bytesDone: number;
  bytesTotal: number;
  itemsDone: number;
  itemsTotal: number;
  current: string;
  scanning: boolean;
  paused?: boolean;
}

export type Step =
  // The backend refuses a step if the item at the path no longer has this `id`.
  | { kind: "move"; from: string; to: string; id?: string }
  | { kind: "copy"; from: string; to: string }
  | { kind: "trash"; path: string; id?: string };

export type TrashStep = Extract<Step, { kind: "trash" }>;

export interface OpResult {
  inverse: Step[];
  cancelled: boolean;
  errors: string[];
  /** Items left in place. Their volume has no Trash. */
  noTrash?: string[];
  /** Steps a cancelled undo or redo did not reach. */
  left?: Step[];
  /** Steps that failed. The user can try them again. */
  failed?: Step[];
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
  /** Finder label color: 0 none, 1 gray, 2 green, 3 purple, 4 blue, 5 yellow, 6 red, 7 orange. */
  color: number;
}

export interface TagFilter {
  /** Tag names to show. Empty with `any` means every tagged item. */
  names: string[];
  any: boolean;
  /** Also search subfolders, with Spotlight. */
  deep: boolean;
}

export interface TagEdit {
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
  /** Has the macOS download mark. Gatekeeper checks it on first open. */
  quarantined: boolean;
  /** Download sources the browser recorded. The file address is first. */
  whereFroms: string[];
}

export interface MediaInfo {
  durationS: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  camera: string | null;
}

export interface MetaGroup {
  title: string;
  rows: { label: string; text: string; dateMs: number | null }[];
}

export interface Checksums {
  sha256: string;
  sha1: string;
  md5: string;
}

export interface SizeProgress {
  bytes: number;
  onDisk: number;
  files: number;
  folders: number;
  done: boolean;
  cancelled: boolean;
  /** The folder could not be read, so the counts are wrong. */
  denied: boolean;
  /** Inner folders that could not be read. The counts leave them out. */
  unreadable: number;
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

export interface DiskMapNode {
  name: string;
  /** Absent for "Smaller items". */
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
  /** Folders that could not be read. Their content is not counted. */
  unreadable?: number;
  /** Absent in reports saved before the scan looked for it. */
  devFolders?: DevFolder[];
}

export interface DevFolder {
  path: string;
  label: string;
  bytes: number;
  /** Safe to move to the Trash. The tool makes it again. */
  safe: boolean;
  note: string;
}

/** In CSS pixels from the window top-left. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** In CSS pixels from the window top-left. Anchors native popovers. */
export interface ShareAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PortableTab {
  history: Location[];
  historyIndex: number;
  selection: string[];
  anchor: string | null;
  columns?: boolean;
}

export interface ViewerOpen {
  path: string;
  /** Folder paths in listing order. Null when not opened from a listing. */
  order: string[] | null;
  /** The thumbnail flies in. Tell the backend when the image is drawn. */
  flown?: boolean;
}

export interface ReaderOpen {
  path: string;
  edit?: boolean;
}

/** Mirrors `Node` in src-tauri/src/markdown.rs. */
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

/** Mirrors `Document` in src-tauri/src/reader.rs. */
export type ReaderDoc = {
  /** In milliseconds since 1970. */
  modified: number;
} & (
  | { kind: "markdown"; blocks: MdNode[] }
  | { kind: "text"; text: string }
  | { kind: "code"; lang: string; text: string }
  | ({ kind: "table" } & DataTable)
  | { kind: "hdf5"; root: H5Node; anndata?: AnnData }
  | ({ kind: "book" } & DataBook)
  | ({ kind: "notebook" } & Notebook)
);

/** Mirrors `Notebook` in src-tauri/src/notebook.rs. */
export interface Notebook {
  lang: string;
  cells: NbCell[];
}

export type NbCell =
  | { t: "markdown"; blocks: MdNode[] }
  | { t: "code"; source: string; count: number | null; outputs: NbOutput[] }
  | { t: "raw"; source: string };

export type NbOutput =
  | { t: "text"; text: string; error: boolean }
  /** Base64 for PNG and JPEG. Markup text for SVG. */
  | { t: "image"; mime: string; data: string }
  | { t: "markdown"; blocks: MdNode[] };

/** Mirrors `Table` in src-tauri/src/data.rs. */
export interface DataTable {
  columns: { name: string; ty?: string; stats?: ColumnStats }[];
  rows: (string | null)[][];
  totalRows: number | null;
  /** The file has at least `totalRows` rows. It is too big to count. */
  more: boolean;
  facts: [string, string][];
  /** Rows start at 0, as in NumPy. */
  zeroIndex?: boolean;
}

export interface ColumnStats {
  min: string | null;
  max: string | null;
  nulls: number | null;
}

/** Mirrors `Book` in src-tauri/src/data.rs. */
export interface DataBook {
  parts: { name: string; detail: string }[];
  first: DataTable | null;
  schema?: string;
  facts: [string, string][];
}

/** Mirrors `H5Node` in src-tauri/src/data.rs. */
export interface H5Node {
  name: string;
  kind: "group" | "dataset";
  shape?: number[];
  dtype?: string;
  attrs?: [string, string][];
  children?: H5Node[];
  /** Members left out of a big group. */
  hidden?: number;
}

/** Mirrors `AnnData` in src-tauri/src/data.rs. */
export interface AnnData {
  nObs: number;
  nVars: number;
  x: string | null;
  sections: AnnSection[];
  raw: [number, number, AnnSection[]] | null;
  obs: DataTable | null;
  var: DataTable | null;
}

export interface AnnSection {
  name: string;
  keys: { name: string; detail: string }[];
}

/** Mirrors `PdfState` in src-tauri/src/pdf.rs. */
export interface PdfState {
  path: string | null;
  error: string | null;
  locked: boolean;
  pages: number;
  /** From 0. */
  page: number;
  /** 1 is actual size. */
  scale: number;
  fit: boolean;
  twoUp: boolean;
  thumbnails: boolean;
  /** Null before a search. */
  found: boolean | null;
}

/** Mirrors `PdfAction` in src-tauri/src/pdf.rs. */
export type PdfAction =
  | { do: "page"; index: number }
  | { do: "step"; delta: number }
  | { do: "zoomIn" | "zoomOut" | "fit" | "actualSize" | "selectAll" | "focus" }
  | { do: "twoUp" | "thumbnails"; on: boolean }
  | { do: "find"; query: string; backwards: boolean }
  | { do: "unlock"; password: string }
  | { do: "inset"; top: number }
  | { do: "theme"; dark: boolean };

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Apply the turn, the flip and the crop in that order. */
export interface ImageEdit {
  /** Quarter turns clockwise. */
  turns: number;
  /** Left to right, after the turns. */
  mirror: boolean;
  /** In pixels of the turned and mirrored image. */
  crop: PixelRect | null;
}

declare global {
  /** Set by vite.config.ts: when this copy was built. Missing in tests. */
  const __BUILD_MS__: number;
}
