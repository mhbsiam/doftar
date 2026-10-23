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
  Conflict,
  FileEntry,
  OpResult,
  PasteboardFiles,
  Progress,
  Resolutions,
  SearchSummary,
  Step,
  SystemInfo,
  Tag,
  TagEdit,
  ViewerOpen,
  ImageEdit,
  ReaderDoc,
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

// Seeded from the clock: the backend remembers cancelled ids for the life of
// the process, and counters restart after a webview reload.
let nextStreamId = Date.now();

export const api = {
  listDir: (path: string, showHidden: boolean) =>
    invoke<FileEntry[]>("list_dir", { path, showHidden }),
  /**
   * Lists a folder in growing batches (sorted folders-first, by name).
   * `done` resolves once the last batch has been handed to `onBatch`, whichever
   * of the batches or the command's reply arrives first. `cancel` stops the
   * backend sending the rest and settles `done` at once.
   */
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
  /** Like `listDir`, but `null` when the folder has more than `maxEntries` items. */
  listDirCapped: (path: string, showHidden: boolean, maxEntries: number) =>
    invoke<FileEntry[] | null>("list_dir_capped", { path, showHidden, maxEntries }),
  systemInfo: () => invoke<SystemInfo>("system_info"),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  findConflicts: (sources: string[], destDir: string) =>
    invoke<Conflict[]>("find_conflicts", { sources, destDir }),
  copyPaths: (
    sources: string[],
    destDir: string,
    resolutions: Resolutions,
    jobId: number,
    on: OnProgress
  ) =>
    invoke<OpResult>("copy_paths", {
      sources,
      destDir,
      resolutions,
      jobId,
      onProgress: progressChannel(on),
    }),
  movePaths: (
    sources: string[],
    destDir: string,
    resolutions: Resolutions,
    jobId: number,
    on: OnProgress
  ) =>
    invoke<OpResult>("move_paths", {
      sources,
      destDir,
      resolutions,
      jobId,
      onProgress: progressChannel(on),
    }),
  transferPaths: (
    sources: string[],
    destDir: string,
    forceCopy: boolean,
    resolutions: Resolutions,
    jobId: number,
    on: OnProgress
  ) =>
    invoke<OpResult>("transfer_paths", {
      sources,
      destDir,
      forceCopy,
      resolutions,
      jobId,
      onProgress: progressChannel(on),
    }),
  applySteps: (steps: Step[], jobId: number, on: OnProgress) =>
    invoke<OpResult>("apply_steps", {
      steps,
      jobId,
      onProgress: progressChannel(on),
    }),
  cancelJob: (jobId: number) => invoke<void>("cancel_job", { jobId }),
  dropMoves: (sources: string[], destDir: string) =>
    invoke<boolean>("drop_moves", { sources, destDir }),
  dropPlan: (sources: string[], destDir: string) =>
    invoke<boolean[]>("drop_plan", { sources, destDir }),
  renamePath: (from: string, to: string) =>
    invoke<void>("rename_path", { from, to }),
  createDir: (parent: string) => invoke<string>("create_dir", { parent }),
  createFile: (parent: string) => invoke<string>("create_file", { parent }),
  trashPaths: (paths: string[]) => invoke<OpResult>("trash_paths", { paths }),
  deletePermanently: (paths: string[], jobId: number, on: OnProgress) =>
    invoke<OpResult>("delete_permanently", {
      paths,
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
  /**
   * Opens `paths` in `app`. Rejects with "needs-run-confirmation" when `app`
   * is a terminal or code launcher (it would run the files) and `allowRun`
   * doesn't say the user agreed.
   */
  openWith: (paths: string[], app: string, allowRun = false) =>
    invoke<void>("open_with", { paths, app, allowRun }),
  /**
   * Opens `path` in its default app through Launch Services. Rejects with
   * "needs-run-confirmation" when that would run the file and `allowRun`
   * doesn't say the user agreed.
   */
  openPath: (path: string, allowRun = false) => invoke<void>("open_path", { path, allowRun }),
  /** Opens a document link's target; refuses anything that could start a program. */
  openLinkTarget: (path: string) => invoke<void>("open_link_target", { path }),
  pickApplication: () => invoke<string | null>("pick_application"),
  searchDir: (
    root: string,
    query: string,
    showHidden: boolean,
    searchId: number,
    onBatch: (entries: FileEntry[]) => void
  ) => {
    const channel = new Channel<FileEntry[]>();
    channel.onmessage = onBatch;
    return invoke<SearchSummary>("search_dir", {
      root,
      query,
      showHidden,
      searchId,
      onBatch: channel,
    });
  },
  /** Items carrying any of `names` (any tag when empty) under `root`, or everywhere when null. */
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
  /** Adds `add` to, or removes the tag named `remove` from, each item. */
  editTags: (paths: string[], add: Tag | null, remove: string | null) =>
    invoke<TagEdit>("edit_tags", { paths, add, remove }),
  /** Full tags of the items that have any, by path, including tags without a colour. */
  scanTags: (paths: string[]) => invoke<Record<string, Tag[]>>("scan_tags", { paths }),
  /** Changes whenever an item is added to, removed from or renamed in the folder. */
  dirStamp: (path: string) => invoke<string | null>("dir_stamp", { path }),
  fileIds: (paths: string[]) => invoke<(string | null)[]>("file_ids", { paths }),
  statEntries: (paths: string[]) => invoke<FileEntry[]>("stat_entries", { paths }),
  itemInfo: (path: string) => invoke<ItemInfo>("item_info", { path }),
  folderSize: (paths: string[], jobId: number, on: (p: SizeProgress) => void) => {
    const channel = new Channel<SizeProgress>();
    channel.onmessage = on;
    return invoke<SizeProgress>("folder_size", { paths, jobId, onProgress: channel });
  },
  cancelSize: (jobId: number) => invoke<void>("cancel_size", { jobId }),
  diskScan: (root: string, scanId: number, on: (p: ScanProgress) => void) => {
    const channel = new Channel<ScanProgress>();
    channel.onmessage = on;
    return invoke<DiskReport>("disk_scan", { root, scanId, onProgress: channel });
  },
  cancelDiskScan: (scanId: number) => invoke<void>("cancel_disk_scan", { scanId }),
  /** The folder map at `path`, `depth` levels down; null when no scan this session covers it. */
  diskMap: (path: string, depth: number) =>
    invoke<DiskMapNode | null>("disk_map", { path, depth }),
  /** Takes items moved to the Trash or deleted off the folder map. */
  diskMapForget: (paths: string[]) => invoke<void>("disk_map_forget", { paths }),
  ejectVolume: (path: string) => invoke<void>("eject_volume", { path }),
  emptyTrash: () => invoke<number>("empty_trash"),
  trashDirs: () => invoke<string[]>("trash_dirs"),
  ensureDir: (path: string) => invoke<void>("ensure_dir", { path }),
  putBackFinder: (paths: string[]) => invoke<void>("put_back_finder", { paths }),
  /** Opens a terminal in `path` (or its folder); `app` is a bundle path, null for Terminal. */
  openTerminal: (path: string, app: string | null = null) =>
    invoke<void>("open_terminal", { path, app }),
  /**
   * Runs `command` in a new window of terminal `app` (a bundle path, null for
   * Terminal) in folder `dir`. `ran` says whether the terminal took the
   * command; otherwise it was only opened in the folder, and `reason` says
   * why when something refused.
   */
  runInTerminal: (dir: string, command: string, app: string | null = null) =>
    invoke<{ ran: boolean; reason: string | null }>("run_in_terminal", { dir, command, app }),
  /** Terminal, iTerm2, Warp, Ghostty, WezTerm and Zentty, where installed. */
  terminalApps: () => invoke<AppInfo[]>("terminal_apps"),
  /** True when opening `path` in its default app runs it (a script, program or launcher). */
  runsAsProgram: (path: string) => invoke<boolean>("runs_as_program", { path }),
  setTerminalLabel: (name: string) => invoke<void>("set_terminal_label", { name }),
  thumbnail: (path: string, maxDim: number, requestId?: number) =>
    invoke<string>("thumbnail", { path, maxDim, requestId }),
  /** The thumbnail already on disk for `path`, or `null`; never makes one. */
  thumbnailCached: (path: string, maxDim: number) =>
    invoke<string | null>("thumbnail_cached", { path, maxDim }),
  cancelThumbnail: (requestId: number) => invoke<void>("cancel_thumbnail", { requestId }),
  /** Related files an app leaves in the user's Library. */
  appLeftovers: (path: string) =>
    invoke<{ path: string; bytes: number }[]>("app_leftovers", { path }),
  /** Removes apps in an Applications folder after macOS asks for permission. */
  deleteAppsWithAdmin: (paths: string[]) => invoke<void>("delete_apps_with_admin", { paths }),
  cacheInfo: () => invoke<{ bytes: number; files: number }>("cache_info"),
  clearCache: () => invoke<{ bytes: number; files: number }>("clear_cache"),
  quicklook: (paths: string[]) => invoke<void>("quicklook", { paths }),
  quicklookClose: () => invoke<void>("quicklook_close"),
  /** Opens a window holding `tab`, its top-left at (`x`, `y`) in screen points. */
  openTabWindow: (tab: PortableTab, x: number, y: number) =>
    invoke<void>("open_tab_window", { tab, x, y }),
  /** The original an alias points to (isDir: a folder to browse, not a package). */
  resolveAlias: (path: string) =>
    invoke<{ path: string; isDir: boolean }>("resolve_alias", { path }),
  /** Another app window under a screen point, with the point in its coordinates. */
  tabWindowAt: (x: number, y: number) =>
    invoke<{ label: string; x: number; y: number } | null>("tab_window_at", { x, y }),
  /** The tab this window was opened with; null for the main window. */
  takeWindowInit: () => invoke<PortableTab | null>("take_window_init"),
  /** Opens the macOS share menu next to `anchor` (CSS pixels in the window). */
  sharePaths: (paths: string[], anchor: ShareAnchor) =>
    invoke<void>("share_paths", { paths, anchor }),
  /**
   * Shows `path` in the image viewer; `order` is its folder as the listing
   * shows it. `from` is where this page draws its icon: resolves true when
   * its thumbnail flies from there, until `viewer:flown`.
   */
  openImageViewer: (path: string, order: string[] | null, from: Rect | null = null) =>
    invoke<boolean>("open_image_viewer", { path, order, from }),
  /** Marks the viewer page ready for images; returns one asked for before it was. */
  viewerReady: () => invoke<ViewerOpen | null>("viewer_ready"),
  /**
   * Shows this viewer window zooming in (it also takes the keyboard); `pic`
   * is where the image is drawn, for a thumbnail flying in to settle onto.
   */
  showZoomed: (pic: Rect | null = null) => invoke<void>("show_zoomed", { pic }),
  /** Tells the backend what the viewer shows and where, to fly it back on closing. */
  viewerShown: (path: string | null, pic: Rect | null, stage: Rect) =>
    invoke<void>("viewer_shown", { path, pic, stage }),
  /** Answers a closing viewer's `viewer:where`: where its thumbnail is, if on screen. */
  viewerReturnRect: (id: number, rect: Rect | null) =>
    invoke<void>("viewer_return_rect", { id, rect }),
  /** The images directly in `dir`, unsorted, without hidden ones. */
  listImages: (dir: string) => invoke<string[]>("list_images", { dir }),
  /** A cached copy of `path` the webview can decode (RAW, older HEIC, outside the asset scope). */
  viewerImage: (path: string) => invoke<string>("viewer_image", { path }),
  /**
   * Shows the PDF at `path` in Doftar's PDF viewer. `from` is where this
   * page draws its icon: resolves true when its thumbnail flies from there
   * onto the first page, until `viewer:flown`.
   */
  openPdf: (path: string, from: Rect | null = null) =>
    invoke<boolean>("open_pdf", { path, from }),
  /** Carries out a PDF viewer toolbar request. */
  pdfAction: (action: PdfAction) => invoke<void>("pdf_action", { action }),
  /** The PDF viewer's toolbar state. */
  pdfState: () => invoke<PdfState>("pdf_state"),
  /**
   * Shows `path` in the reader. `from` is where this page draws its icon and
   * `icon` that icon as SVG: resolves true when the icon flies from there
   * into the reader, until `viewer:flown`.
   */
  openReader: (path: string, from: Rect | null = null, icon: string | null = null) =>
    invoke<boolean>("open_reader", { path, from, icon }),
  /** Marks the reader page ready; returns a document asked for before it was. */
  readerReady: () => invoke<ReaderOpen | null>("reader_ready"),
  /** The Markdown, text or code file at `path`, read for the reader. */
  readDocument: (path: string) => invoke<ReaderDoc>("read_document", { path }),
  /** Whether `path` starts out as text rather than binary data. */
  isTextFile: (path: string) => invoke<boolean>("is_text_file", { path }),
  /** Tells the backend the viewer has edits that aren't saved, so closing asks first. */
  viewerSetDirty: (dirty: boolean) => invoke<void>("viewer_set_dirty", { dirty }),
  /** Saves `edit` of the image over it, or beside it as a copy; returns the path written. */
  saveImageEdit: (path: string, edit: ImageEdit, asCopy: boolean) =>
    invoke<string>("save_image_edit", { path, edit, asCopy }),
  watchFiles: (paths: string[]) => invoke<void>("watch_files", { paths }),
  watchPath: (path: string) => invoke<void>("watch_path", { path }),
  unwatchPath: (path: string) => invoke<void>("unwatch_path", { path }),
  loadStore: () => invoke<string | null>("load_store"),
  saveStore: (content: string, takenAt: number) =>
    invoke<void>("save_store", { content, takenAt }),
  quit: () => invoke<void>("quit_app"),
};
