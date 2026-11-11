import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
  PortableTab,
  ShareAnchor,
  DiskReport,
  DiskMapNode,
  ScanProgress,
  ItemInfo,
  SizeProgress,
  Checksums,
  MediaInfo,
  MetaGroup,
  Conflict,
  FileEntry,
  GitInfo,
  GitOverview,
  GitRepo,
  SkillPlace,
  OpResult,
  PasteboardFiles,
  Progress,
  Resolutions,
  SearchSummary,
  Step,
  SystemInfo,
  Tag,
  TagEdit,
  TrashStep,
  ArchiveListing,
  DupeReport,
  ViewerOpen,
  ImageEdit,
  ReaderDoc,
  DataTable,
  PdfAction,
  PdfState,
  ReaderOpen,
  Rect,
} from "./types";

function progressChannel(onProgress: (p: Progress) => void): Channel<Progress> {
  const channel = new Channel<Progress>();
  channel.onmessage = onProgress;
  return channel;
}

type OnProgress = (p: Progress) => void;

// Seed from the clock. The backend keeps cancelled ids until it exits.
// A webview reload resets the counters.
let nextStreamId = Date.now();

export const api = {
  listDir: (path: string, showHidden: boolean) =>
    invoke<FileEntry[]>("list_dir", { path, showHidden }),
  /** Lists a folder in batches. `cancel` stops the stream and settles `done` at once. */
  listDirStream: (
    path: string,
    showHidden: boolean,
    onBatch: (entries: FileEntry[]) => void
  ) => {
    const streamId = nextStreamId++;
    const channel = new Channel<FileEntry[]>();
    let got = 0;
    let total: number | null = null;
    let cancelled = false;
    let wake: (() => void) | null = null;
    channel.onmessage = (batch) => {
      if (cancelled) return;
      got += batch.length;
      onBatch(batch);
      if (total !== null && got >= total) wake?.();
    };
    const done = invoke<number>("list_dir_stream", {
      path,
      showHidden,
      streamId,
      onBatch: channel,
    }).then((n) => {
      total = n;
      if (cancelled || got >= n) return;
      return new Promise<void>((resolve) => {
        wake = resolve;
      });
    });
    return {
      done,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        wake?.();
        void invoke<void>("cancel_list_stream", { streamId }).catch(() => {});
      },
    };
  },
  /** Resolves `null` when the folder has more than `maxEntries` items. */
  listDirCapped: (path: string, showHidden: boolean, maxEntries: number) =>
    invoke<FileEntry[] | null>("list_dir_capped", { path, showHidden, maxEntries }),
  /** Asks macOS again for a refused folder. Resolves true if allowed now. */
  requestFolderAccess: (path: string) => invoke<boolean>("request_folder_access", { path }),
  systemInfo: () => invoke<SystemInfo>("system_info"),
  logUiError: (kind: string, message: string) => invoke<void>("log_ui_error", { kind, message }),
  copyDiagnostics: () => invoke<void>("copy_diagnostics"),
  freeSpace: (path: string) => invoke<number | null>("free_space", { path }),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  isFolder: (path: string) => invoke<boolean>("is_folder", { path }),
  findConflicts: (sources: string[], destDir: string) =>
    invoke<Conflict[]>("find_conflicts", { sources, destDir }),
  copyPaths: (
    sources: string[],
    destDir: string,
    resolutions: Resolutions,
    verify: boolean,
    jobId: number,
    on: OnProgress
  ) =>
    invoke<OpResult>("copy_paths", {
      sources,
      destDir,
      resolutions,
      verify,
      jobId,
      onProgress: progressChannel(on),
    }),
  movePaths: (
    sources: string[],
    destDir: string,
    resolutions: Resolutions,
    verify: boolean,
    jobId: number,
    on: OnProgress
  ) =>
    invoke<OpResult>("move_paths", {
      sources,
      destDir,
      resolutions,
      verify,
      jobId,
      onProgress: progressChannel(on),
    }),
  transferPaths: (
    sources: string[],
    destDir: string,
    forceCopy: boolean,
    resolutions: Resolutions,
    verify: boolean,
    jobId: number,
    on: OnProgress
  ) =>
    invoke<OpResult>("transfer_paths", {
      sources,
      destDir,
      forceCopy,
      resolutions,
      verify,
      jobId,
      onProgress: progressChannel(on),
    }),
  applySteps: (steps: Step[], jobId: number, on: OnProgress) =>
    invoke<OpResult>("apply_steps", {
      steps,
      jobId,
      onProgress: progressChannel(on),
    }),
  /** Saves an image or text on the clipboard as a new file in `dest`. Null when it holds neither. */
  clipboardPasteData: (dest: string, stamp: string) => invoke<TrashStep | null>("clipboard_paste_data", { dest, stamp }),
  archiveList: (path: string) => invoke<ArchiveListing>("archive_list", { path }),
  findDuplicates: (root: string, minSize: number, jobId: number, on: OnProgress) =>
    invoke<DupeReport>("find_duplicates", { root, minSize, jobId, onProgress: progressChannel(on) }),
  pauseJob: (jobId: number, paused: boolean) => invoke<void>("pause_job", { jobId, paused }),
  cancelJob: (jobId: number) => invoke<void>("cancel_job", { jobId }),
  dropMoves: (sources: string[], destDir: string) =>
    invoke<boolean>("drop_moves", { sources, destDir }),
  dropPlan: (sources: string[], destDir: string) =>
    invoke<boolean[]>("drop_plan", { sources, destDir }),
  renameTaken: (from: string, to: string) => invoke<boolean>("rename_taken", { from, to }),
  /** These return the step that undoes the change. */
  renamePath: (from: string, to: string) => invoke<Step>("rename_path", { from, to }),
  createDir: (parent: string) => invoke<TrashStep>("create_dir", { parent }),
  createFile: (parent: string) => invoke<TrashStep>("create_file", { parent }),
  /** Resolves the new path. Adds a number to the name if `<base><ext>` exists. */
  createTextFile: (parent: string, base: string, ext: string, text: string) =>
    invoke<string>("create_text_file", { parent, base, ext, text }),
  trashPaths: (paths: string[]) => invoke<OpResult>("trash_paths", { paths }),
  /** `ids` are `itemIds` of `paths` from confirm time. An item replaced since is kept. */
  deletePermanently: (paths: string[], jobId: number, on: OnProgress, ids?: (string | null)[]) =>
    invoke<OpResult>("delete_permanently", {
      paths,
      ids: ids ?? null,
      jobId,
      onProgress: progressChannel(on),
    }),
  compressPaths: (paths: string[], jobId: number, on: OnProgress) =>
    invoke<OpResult>("compress_paths", { paths, jobId, onProgress: progressChannel(on) }),
  extractArchive: (path: string, jobId: number, on: OnProgress) =>
    invoke<OpResult>("extract_archive", { path, jobId, onProgress: progressChannel(on) }),
  clipboardWriteFiles: (paths: string[]) =>
    invoke<number>("clipboard_write_files", { paths }),
  clipboardReadFiles: () => invoke<PasteboardFiles>("clipboard_read_files"),
  clipboardChangeCount: () => invoke<number>("clipboard_change_count"),
  clipboardClear: () => invoke<void>("clipboard_clear"),
  setUndoLabels: (undo: string | null, redo: string | null) =>
    invoke<void>("set_undo_labels", { undo, redo }),
  openWithApps: (path: string) => invoke<AppInfo[]>("open_with_apps", { path }),
  /** Rejects with "needs-run-confirmation" if `app` would run the files and `allowRun` is not set. */
  openWith: (paths: string[], app: string, allowRun = false) =>
    invoke<void>("open_with", { paths, app, allowRun }),
  /** Uses the default app. Rejects like `openWith` when that runs the file. */
  openPath: (path: string, allowRun = false) => invoke<void>("open_path", { path, allowRun }),
  /** Refuses any target that could start a program. */
  openLinkTarget: (path: string) => invoke<void>("open_link_target", { path }),
  /** Shows the items selected in a Finder window. */
  revealInFinder: (paths: string[]) => invoke<void>("reveal_in_finder", { paths }),
  pickApplication: () => invoke<string | null>("pick_application"),
  searchDir: (
    root: string,
    query: string,
    showHidden: boolean,
    searchId: number,
    onBatch: (entries: FileEntry[]) => void,
    /** Kind and date filter, applied before the result cap. */
    only: { exts: string[] | null; modifiedSince: number | null } | null = null,
    /** Also match text inside files that Spotlight has indexed. */
    contents = false
  ) => {
    const channel = new Channel<FileEntry[]>();
    channel.onmessage = onBatch;
    return invoke<SearchSummary>("search_dir", {
      root,
      query,
      showHidden,
      only,
      contents,
      searchId,
      onBatch: channel,
    });
  },
  /** Empty `names` means any tag. A null `root` means everywhere. */
  searchTags: (
    root: string | null,
    names: string[],
    showHidden: boolean,
    searchId: number,
    onBatch: (entries: FileEntry[]) => void
  ) => {
    const channel = new Channel<FileEntry[]>();
    channel.onmessage = onBatch;
    return invoke<SearchSummary>("search_tags", {
      root,
      names,
      showHidden,
      searchId,
      onBatch: channel,
    });
  },
  cancelSearch: (searchId: number) => invoke<void>("cancel_search", { searchId }),
  editTags: (paths: string[], add: Tag | null, remove: string | null) =>
    invoke<TagEdit>("edit_tags", { paths, add, remove }),
  /** Includes tags without a color. Keyed by path. */
  scanTags: (paths: string[]) => invoke<Record<string, Tag[]>>("scan_tags", { paths }),
  /** The stamp changes when an item is added, removed or renamed in the folder. */
  dirStamp: (path: string) => invoke<string | null>("dir_stamp", { path }),
  gitInfo: (path: string) => invoke<GitInfo | null>("git_info", { path }),
  gitOverview: (path: string) => invoke<GitOverview | null>("git_overview", { path }),
  gitSwitch: (path: string, branch: string) => invoke<void>("git_switch", { path, branch }),
  gitRepos: () => invoke<GitRepo[]>("git_repos"),
  listSkills: () => invoke<SkillPlace[]>("list_skills"),
  /** Resolves the path of the new SKILL.md. */
  createSkill: (place: string, name: string) => invoke<string>("create_skill", { place, name }),
  linkSkill: (skill: string, place: string) => invoke<void>("link_skill", { skill, place }),
  fileIds: (paths: string[]) => invoke<(string | null)[]>("file_ids", { paths }),
  /** Like `fileIds`, but for a link itself, not its target. Undo steps record these. */
  itemIds: (paths: string[]) => invoke<(string | null)[]>("item_ids", { paths }),
  statEntries: (paths: string[]) => invoke<FileEntry[]>("stat_entries", { paths }),
  itemInfo: (path: string) => invoke<ItemInfo>("item_info", { path }),
  folderSize: (paths: string[], jobId: number, on: (p: SizeProgress) => void) => {
    const channel = new Channel<SizeProgress>();
    channel.onmessage = on;
    return invoke<SizeProgress>("folder_size", { paths, jobId, onProgress: channel });
  },
  cancelSize: (jobId: number) => invoke<void>("cancel_size", { jobId }),
  itemMetadata: (path: string) => invoke<MetaGroup[]>("item_metadata", { path }),
  mediaInfo: (paths: string[]) => invoke<(MediaInfo | null)[]>("media_info", { paths }),
  fileChecksums: (path: string, jobId: number) =>
    invoke<Checksums | null>("file_checksums", { path, jobId }),
  diskScan: (root: string, scanId: number, on: (p: ScanProgress) => void) => {
    const channel = new Channel<ScanProgress>();
    channel.onmessage = on;
    return invoke<DiskReport>("disk_scan", { root, scanId, onProgress: channel });
  },
  cancelDiskScan: (scanId: number) => invoke<void>("cancel_disk_scan", { scanId }),
  /** Null when no scan this session covers `path`. */
  diskMap: (path: string, depth: number) =>
    invoke<DiskMapNode | null>("disk_map", { path, depth }),
  /** Removes `paths` from the map. Returns the bytes each took, 0 if absent. */
  diskMapForget: (paths: string[]) => invoke<number[]>("disk_map_forget", { paths }),
  ejectVolume: (path: string) => invoke<void>("eject_volume", { path }),
  emptyTrash: () => invoke<number>("empty_trash"),
  trashDirs: () => invoke<string[]>("trash_dirs"),
  ensureDir: (path: string) => invoke<void>("ensure_dir", { path }),
  /** Deletes the hidden copies that a replace on a network share keeps for undo. */
  discardAsides: (paths: string[]) => invoke<void>("discard_asides", { paths }),
  /** `app` is a bundle path. Null means Terminal. */
  openTerminal: (path: string, app: string | null = null) =>
    invoke<void>("open_terminal", { path, app }),
  /**
   * `ran` is false when the terminal only opened `dir`.
   * `reason` says why, if something refused the command.
   */
  runInTerminal: (dir: string, command: string, app: string | null = null) =>
    invoke<{ ran: boolean; reason: string | null }>("run_in_terminal", { dir, command, app }),
  terminalApps: () => invoke<AppInfo[]>("terminal_apps"),
  editorApps: () => invoke<AppInfo[]>("editor_apps"),
  /** True when the default app would run the file. */
  runsAsProgram: (path: string) => invoke<boolean>("runs_as_program", { path }),
  setTerminalLabel: (name: string) => invoke<void>("set_terminal_label", { name }),
  thumbnail: (path: string, maxDim: number, requestId?: number) =>
    invoke<string>("thumbnail", { path, maxDim, requestId }),
  /** Never makes a thumbnail. Resolves null if none is on disk. */
  thumbnailCached: (path: string, maxDim: number) =>
    invoke<string | null>("thumbnail_cached", { path, maxDim }),
  cancelThumbnail: (requestId: number) => invoke<void>("cancel_thumbnail", { requestId }),
  /** Fails for a PDF that has a password or is still in the cloud. */
  pdfPageSizes: (path: string) => invoke<{ w: number; h: number }[]>("pdf_page_sizes", { path }),
  /** `cancelThumbnail` stops `requestId`. */
  pdfPagePicture: (path: string, index: number, maxDim: number, requestId?: number) =>
    invoke<string>("pdf_page_picture", { path, index, maxDim, requestId }),
  appLeftovers: (path: string) =>
    invoke<{ path: string; bytes: number }[]>("app_leftovers", { path }),
  /** macOS asks for permission first. */
  deleteAppsWithAdmin: (paths: string[]) => invoke<void>("delete_apps_with_admin", { paths }),
  cacheInfo: () => invoke<{ bytes: number; files: number }>("cache_info"),
  clearCache: () => invoke<{ bytes: number; files: number }>("clear_cache"),
  quicklook: (paths: string[]) => invoke<void>("quicklook", { paths }),
  quicklookClose: () => invoke<void>("quicklook_close"),
  /** `x`, `y` are screen points. */
  openTabWindow: (tab: PortableTab, x: number, y: number) =>
    invoke<void>("open_tab_window", { tab, x, y }),
  /** `isDir` is true for a folder to browse, not a package. */
  resolveAlias: (path: string) =>
    invoke<{ path: string; isDir: boolean }>("resolve_alias", { path }),
  /** The returned `x`, `y` are in the found window's coordinates. */
  tabWindowAt: (x: number, y: number) =>
    invoke<{ label: string; x: number; y: number } | null>("tab_window_at", { x, y }),
  /** Null for the main window. */
  takeWindowInit: () => invoke<PortableTab | null>("take_window_init"),
  takeOpened: () => invoke<{ path: string; reveal: boolean }[] | null>("take_opened"),
  /** `anchor` is in CSS pixels in the window. */
  sharePaths: (paths: string[], anchor: ShareAnchor) =>
    invoke<void>("share_paths", { paths, anchor }),
  /** `from` is where this page draws the icon. Resolves true if the thumbnail flies from there. */
  openImageViewer: (path: string, order: string[] | null, from: Rect | null = null) =>
    invoke<boolean>("open_image_viewer", { path, order, from }),
  /** Returns the image requested before the page was ready. */
  viewerReady: () => invoke<ViewerOpen | null>("viewer_ready"),
  /** `pic` is where the image is drawn. A flying thumbnail settles onto it. */
  showZoomed: (pic: Rect | null = null) => invoke<void>("show_zoomed", { pic }),
  /** Tells the backend what shows and where, to fly it back on close. */
  viewerShown: (path: string | null, pic: Rect | null, stage: Rect) =>
    invoke<void>("viewer_shown", { path, pic, stage }),
  /** Answers `viewer:where`. `rect` is the thumbnail place, null if off screen. */
  viewerReturnRect: (id: number, rect: Rect | null) =>
    invoke<void>("viewer_return_rect", { id, rect }),
  /** Unsorted. Hidden files are excluded. */
  listImages: (dir: string) => invoke<string[]>("list_images", { dir }),
  /** For RAW, older HEIC and files outside the asset scope. Returns a copy the webview can decode. */
  viewerImage: (path: string) => invoke<string>("viewer_image", { path }),
  /** `from` is where this page draws the icon. Resolves true if the thumbnail flies from there. */
  openPdf: (path: string, from: Rect | null = null) =>
    invoke<boolean>("open_pdf", { path, from }),
  pdfAction: (action: PdfAction) => invoke<void>("pdf_action", { action }),
  pdfState: () => invoke<PdfState>("pdf_state"),
  /** `from` is where this page draws the icon. */
  openVideo: (path: string, from: Rect | null = null) =>
    invoke<void>("open_video", { path, from }),
  /** Returns the video requested before the player was ready. */
  videoReady: () => invoke<{ path: string } | null>("video_ready"),
  /** `icon` is the SVG of the icon at `from`. Resolves true if it flies into the reader. */
  openReader: (path: string, from: Rect | null = null, icon: string | null = null, edit = false) =>
    invoke<boolean>("open_reader", { path, from, icon, edit }),
  /** Returns the document requested before the page was ready. */
  readerReady: () => invoke<ReaderOpen | null>("reader_ready"),
  readDocument: (path: string) => invoke<ReaderDoc>("read_document", { path }),
  openWebLink: (url: string) => invoke<void>("open_web_link", { url }),
  readDataPart: (path: string, part: string) => invoke<DataTable>("read_data_part", { path, part }),
  readText: (path: string) =>
    invoke<{ text: string; rev: string; encoding: string; crlf: boolean }>("read_text", { path }),
  /** Accepts every tracked change. One paragraph per line. */
  readDocxText: (path: string) => invoke<string>("read_docx_text", { path }),
  /**
   * Writes LF line endings and a final newline. Resolves the new version.
   * Rejects with "changed-on-disk" if the file changed since `rev`. A null `rev` skips this check.
   */
  writeText: (path: string, text: string, rev: string | null) =>
    invoke<string>("write_text", { path, text, rev }),
  /** While `dirty` is true, closing the reader asks first. */
  readerSetDirty: (dirty: boolean) => invoke<void>("reader_set_dirty", { dirty }),
  isTextFile: (path: string) => invoke<boolean>("is_text_file", { path }),
  /** While `dirty` is true, closing the viewer asks first. */
  viewerSetDirty: (dirty: boolean) => invoke<void>("viewer_set_dirty", { dirty }),
  /** Returns the path written. Rejects if the image is no longer at `rev`. */
  saveImageEdit: (path: string, edit: ImageEdit, asCopy: boolean, rev: string | null) =>
    invoke<string>("save_image_edit", { path, edit, asCopy, rev }),
  /** The version to send back with a save. */
  fileRevision: (path: string) => invoke<string | null>("file_revision", { path }),
  watchFiles: (paths: string[]) => invoke<void>("watch_files", { paths }),
  watchPath: (path: string) => invoke<void>("watch_path", { path }),
  unwatchPath: (path: string) => invoke<void>("unwatch_path", { path }),
  downloadFile: (path: string) => invoke<void>("download_file", { path }),
  loadStore: () => invoke<string | null>("load_store"),
  /** Keeps an unreadable store for recovery. */
  setAsideStore: () => invoke<void>("set_aside_store"),
  saveStore: (content: string, takenAt: number) =>
    invoke<void>("save_store", { content, takenAt }),
  quit: () => invoke<void>("quit_app"),
  /** Same as ⌘Q. Call it after unsaved edits are handled. */
  requestQuit: () => invoke<void>("request_quit"),
};
