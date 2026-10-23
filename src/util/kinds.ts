import type { FileEntry } from "../types";

const KIND_MAP: Record<string, string> = {
  txt: "Text Document",
  md: "Markdown File",
  rtf: "Rich Text Document",
  pdf: "PDF Document",
  png: "PNG Image",
  jpg: "JPEG Image",
  jpeg: "JPEG Image",
  gif: "GIF Image",
  webp: "WebP Image",
  bmp: "Bitmap Image",
  heic: "HEIC Image",
  tiff: "TIFF Image",
  svg: "SVG Document",
  icns: "Icon File",
  zip: "Compressed (zipped) Folder",
  tar: "TAR Archive",
  gz: "GZip Archive",
  bz2: "BZip2 Archive",
  "7z": "7-Zip Archive",
  rar: "RAR Archive",
  dmg: "Disk Image",
  iso: "Disc Image",
  app: "Application",
  bundle: "Bundle",
  framework: "Framework",
  xcodeproj: "Xcode Project",
  xcworkspace: "Xcode Workspace",
  playground: "Swift Playground",
  photoslibrary: "Photos Library",
  band: "GarageBand Project",
  sparsebundle: "Sparse Bundle Disk Image",
  plugin: "Plug-in",
  prefpane: "System Settings Pane",
  kext: "Kernel Extension",
  rtfd: "RTF with Attachments",
  pkg: "Installer Package",
  doc: "Word Document",
  docx: "Word Document",
  xls: "Excel Worksheet",
  xlsx: "Excel Worksheet",
  ppt: "PowerPoint Presentation",
  pptx: "PowerPoint Presentation",
  key: "Keynote Presentation",
  pages: "Pages Document",
  numbers: "Numbers Spreadsheet",
  mp3: "MP3 Audio",
  m4a: "AAC Audio",
  wav: "WAV Audio",
  flac: "FLAC Audio",
  aac: "AAC Audio",
  ogg: "OGG Audio",
  mp4: "MP4 Video",
  mov: "QuickTime Movie",
  mkv: "Matroska Video",
  avi: "AVI Video",
  webm: "WebM Video",
  json: "JSON File",
  yaml: "YAML File",
  yml: "YAML File",
  toml: "TOML File",
  xml: "XML Document",
  html: "HTML Document",
  htm: "HTML Document",
  css: "Cascading Style Sheet",
  js: "JavaScript File",
  mjs: "JavaScript File",
  ts: "TypeScript File",
  tsx: "TypeScript File",
  jsx: "React Script",
  rs: "Rust Source File",
  py: "Python Script",
  rb: "Ruby Script",
  sh: "Shell Script",
  zsh: "Shell Script",
  c: "C Source File",
  h: "C Header File",
  cpp: "C++ Source File",
  swift: "Swift Source File",
  go: "Go Source File",
  java: "Java Source File",
  sql: "SQL Database File",
  db: "Database File",
  sqlite: "SQLite Database",
  dylib: "Dynamic Library",
  so: "Shared Object",
  bin: "Binary File",
  o: "Object File",
  lock: "Lock File",
  log: "Log File",
  csv: "Comma Separated Values File",
  ttf: "TrueType Font",
  otf: "OpenType Font",
};

const EXT_COLORS: Record<string, string> = {
  txt: "#43a102",
  md: "#3a3a3a",
  pdf: "#c4161c",
  doc: "#2b579a",
  docx: "#2b579a",
  xls: "#107c41",
  xlsx: "#107c41",
  ppt: "#c43e1c",
  pptx: "#c43e1c",
  png: "#9c4fd7",
  jpg: "#9c4fd7",
  jpeg: "#9c4fd7",
  gif: "#9c4fd7",
  webp: "#9c4fd7",
  bmp: "#9c4fd7",
  heic: "#9c4fd7",
  svg: "#9c4fd7",
  zip: "#8f9fac",
  tar: "#8f9fac",
  gz: "#8f9fac",
  "7z": "#8f9fac",
  rar: "#8f9fac",
  dmg: "#7f8ea3",
  iso: "#7f8ea3",
  mp3: "#0f7bbd",
  m4a: "#0f7bbd",
  wav: "#0f7bbd",
  flac: "#0f7bbd",
  mp4: "#b146c2",
  mov: "#b146c2",
  mkv: "#b146c2",
  avi: "#b146c2",
  webm: "#b146c2",
  html: "#e34c26",
  css: "#264de4",
  js: "#c9a227",
  mjs: "#c9a227",
  ts: "#2f74c0",
  tsx: "#2f74c0",
  rs: "#b7410e",
  py: "#3572a5",
  sh: "#89e051",
  json: "#c9a227",
};

export type FileKind =
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "pdf"
  | "code"
  | "doc"
  | "sheet"
  | "slides"
  | "text"
  | "generic";

const KIND_EXTS: Record<Exclude<FileKind, "generic">, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "tiff", "svg", "icns", "psd", "ai"],
  video: ["mp4", "mov", "m4v", "mkv", "avi", "webm"],
  audio: ["mp3", "m4a", "wav", "flac", "aac", "ogg"],
  archive: ["zip", "tar", "gz", "bz2", "7z", "rar", "dmg", "iso", "pkg"],
  pdf: ["pdf"],
  code: [
    "json", "yaml", "yml", "toml", "xml", "html", "htm", "css", "js", "mjs", "ts", "tsx", "jsx",
    "rs", "py", "rb", "sh", "zsh", "c", "h", "cpp", "swift", "go", "java", "sql",
  ],
  doc: ["doc", "docx", "rtf", "rtfd", "pages"],
  sheet: ["xls", "xlsx", "csv", "numbers"],
  slides: ["ppt", "pptx", "key"],
  text: ["txt", "md", "log"],
};
const KIND_BY_EXT = new Map<string, FileKind>();
for (const [kind, exts] of Object.entries(KIND_EXTS) as [FileKind, string[]][]) {
  for (const ext of exts) KIND_BY_EXT.set(ext, kind);
}

export function fileKind(ext: string): FileKind {
  return KIND_BY_EXT.get(ext) ?? "generic";
}

export function isFolder(
  entry: Pick<FileEntry, "isDir"> & { isPackage?: boolean }
): boolean {
  return entry.isDir && !entry.isPackage;
}

export function typeLabel(entry: FileEntry): string {
  if (isFolder(entry)) return "File folder";
  if (entry.isAlias) return "Alias";
  return KIND_MAP[entry.ext] ?? (entry.ext ? `${entry.ext.toUpperCase()} File` : "File");
}

export function extColor(
  entry: Pick<FileEntry, "isDir" | "ext"> & { isPackage?: boolean }
): string {
  if (isFolder(entry)) return "#ffc83d";
  return EXT_COLORS[entry.ext] ?? "#5b6472";
}

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
]);

const QL_EXTS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key", "rtf", "rtfd",
  "mov", "mp4", "m4v", "avi", "mkv", "webm", "mp3", "m4a", "svg", "psd", "ai", "eps", "epub",
]);

export function isQuickLookExt(ext: string): boolean {
  return QL_EXTS.has(ext);
}

export function isImageExt(ext: string): boolean {
  return IMAGE_EXTS.has(ext);
}

/** Images Doftar opens in its own viewer; keep in step with `EXTS` in viewer.rs. */
const VIEWER_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif", "tif", "tiff", "heic",
  "heif", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2",
]);

export function isViewerImage(ext: string): boolean {
  return VIEWER_EXTS.has(ext.toLowerCase());
}

/** Markdown, which the reader formats; keep in step with `MARKDOWN_EXTS` in src-tauri/src/reader.rs. */
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdown", "mkd", "mkdn", "mdwn"]);

export function isMarkdown(ext: string): boolean {
  return MARKDOWN_EXTS.has(ext.toLowerCase());
}

/**
 * Plain text and source code the reader shows; keep in step with
 * `TEXT_EXTS` and `code_lang` in src-tauri/src/reader.rs.
 */
const TEXT_EXTS = new Set([
  "txt", "text", "log",
  "py", "pyw", "pyi", "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "json", "jsonc",
  "css", "scss", "less", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties",
  "sh", "bash", "zsh", "ksh", "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx", "m", "mm",
  "cs", "java", "kt", "kts", "swift", "go", "rs", "rb", "php", "pl", "pm", "lua", "r", "sql",
  "graphql", "gql", "diff", "patch", "mk", "vb",
]);

/** Text or code the reader shows as it is (as long as the file really is text). */
export function isPlainText(ext: string): boolean {
  return TEXT_EXTS.has(ext.toLowerCase());
}

/** What the viewer can save edits back to; keep in step with `EXTS` in src-tauri/src/imgedit.rs. */
const EDITABLE_EXTS = new Set(["jpg", "jpeg", "png", "tif", "tiff", "heic", "heif", "bmp", "gif"]);

export function isEditableImage(ext: string): boolean {
  return EDITABLE_EXTS.has(ext.toLowerCase());
}

/** The lowercased extension of the last part of `path`, or "" when it has none. */
export function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
