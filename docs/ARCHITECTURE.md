# How Doftar is built

How the code fits together, for anyone who wants to read or change it. Doftar
is meant to be installed from the DMG; building from source and publishing a
release are covered in [REFERENCE.md](REFERENCE.md#building-from-source).

## Project structure

```
src/                      React frontend
├── main.tsx              # Entry: picks the window type from the window label
├── appMain.tsx           # File manager window
├── viewerMain.tsx        # Image viewer window
├── readerMain.tsx        # Reader window (Markdown, code, data, notebooks)
├── pdfMain.tsx           # PDF viewer window
├── videoMain.tsx         # Video player window
├── App.tsx               # Title bar, command bar, panes, dialogs
├── ipc.ts                # Typed wrappers for every Rust command
├── actions.ts            # Commands the menus, shortcuts and palette share
├── jobs.ts               # Starts copy/move jobs and routes their progress
├── components/           # Views: details, columns, grid, home, disk, Git, compare, viewers
├── stores/               # Zustand stores (see State management)
├── hooks/                # Directory listing, watching, shortcuts, selection, drag and drop
└── util/                 # Formatting, file kinds, rename rules, diffing, layout, motion

src-tauri/src/            Rust core
├── main.rs               # Tauri setup, command registration, window lifecycle
├── bulk.rs, fsops/       # Fast listing; copy, move, rename, trash, undo steps
├── jobs.rs               # Cancellable jobs with throttled progress events
├── watcher.rs            # Refcounted kqueue watcher, one fd per open folder
├── search.rs             # Spotlight search with a bounded-walk fallback
├── thumbs.rs, cache.rs   # Quick Look thumbnails and cache housekeeping
├── clipboard.rs          # NSPasteboard file URLs, shared with Finder
├── archive.rs            # Compress and extract with ditto and tar
├── props.rs, metadata.rs # Properties: sizes, permissions, media and EXIF data
├── tags.rs, alias.rs     # Finder tags and aliases
├── git.rs, disk.rs       # Repository status and history; disk usage scans
├── viewer.rs, reader.rs, pdf.rs, video.rs   # The viewer windows
├── markdown.rs, data.rs, sheets.rs, sqlite.rs, notebook.rs, npy.rs, weights.rs
│                         # Parsers that turn files into typed data for the reader
├── openwith.rs, launcher.rs # Open With, terminals, the run-confirmation gate
├── netguard.rs           # Seatbelt profile that denies every IP socket
├── guard.rs              # Locations never moved, trashed or deleted
├── quarantine.rs         # Quarantine mark propagation and download origin
├── trash.rs              # Empty Trash, eject
├── store.rs              # Saved favorites, pins, recents and undo history
├── opened.rs             # Folders handed over by `open -a`, the Dock icon and the Finder service
└── menu.rs, windows.rs   # Native menu bar; windows made from dragged-out tabs

assets/                   Icon and README artwork (SVG sources)
docs/                     The website, served by GitHub Pages
scripts/                  Icon and notices generators, local DMG build
deny.toml                 cargo-deny: license policy and the no-network crate ban
```

## Architecture

**Tauri 2 + React 18 + Fluent UI v9.** The Rust core does all file system
work; the webview only draws.

- **One IPC boundary.** The frontend calls Rust through `src/ipc.ts`, a typed
  wrapper over Tauri `invoke`. Long listings stream back in batches over a
  Tauri `Channel`, so a large folder starts drawing before it finishes.
- **Jobs.** Copies, moves, extracts and deletes run as cancellable jobs in
  `jobs.rs`, which sends throttled progress events. Each window numbers its
  jobs from a random start so two windows never cancel each other's.
- **Live folders.** `watcher.rs` keeps one kqueue watch per open folder,
  shared by every pane showing it, and tells the frontend to reload.
- **Separate windows.** The image viewer, reader, PDF viewer and video player
  are their own windows, made hidden at launch and shown when a file opens, so
  opening one is instant. `main.tsx` picks which app to start from the window
  label.
- **Native where it counts.** Thumbnails, Quick Look, the clipboard, Trash,
  the share menu, PDFs (PDFKit) and the menu bar use macOS APIs directly
  through `objc2`.

### Key design decisions

- **Main process off the network at the kernel level.** `netguard.rs` applies
  a Seatbelt profile at startup that refuses IP sockets for the Rust process
  and its child tools. WebKit's helpers sit outside it and rely on the CSP.
  `deny.toml` bans networking crates so one can't sneak in.
- **Guarded locations.** `guard.rs` refuses to move, rename, trash or delete
  system and home roots, whatever the frontend asks.
- **Confirm before running.** Opening a program or script needs a
  confirmation the Rust side checks itself, not just a dialog in the UI.
- **Parsers, not HTML.** Documents are parsed in Rust into typed nodes and
  drawn element by element, so a file can never inject markup or script.
- **Optimistic UI.** Renames, new folders and deletes show at once
  (`stores/optimistic.ts`) and are reverted if the operation fails.

## State management

State lives in small [Zustand](https://github.com/pmndrs/zustand) stores in
`src/stores/`, one per concern:

| Store | Holds |
|-------|-------|
| `tabs` | Each pane's tabs, history, selection and filters. Two pane stores, one per side of split view |
| `settings` | Theme, text size, colors, per-folder view and sort. Saved to the webview's `localStorage` |
| `appdata` | Favorites, pins, recents and Trash origins, plus the undo stack so a restart keeps it. Saved by Rust (`store.rs`), debounced |
| `history` | The undo/redo stack (last 50) and the activity log |
| `clipboard` | Files cut or copied, and clipboard history |
| `jobs` | Running jobs and their progress, speed and time left |
| `optimistic`, `prefetch` | Pending changes shown before a reload, and recent listings for instant reopening |
| `git`, `disk`, `media`, `tags` | Git status, disk scans, media metadata and Finder tags for what's on screen |
| `ui`, `drag`, `writing` | Dialogs and menus, the drag in progress, files still being written |

**Across windows.** Every window runs its own copy of the stores.
`windowSync.ts` mirrors shared state (settings, favorites, clipboard, undo
history) to the other windows as it changes, through Tauri events, so a
favorite added in one window shows in all of them and no window saves an older
copy over a newer one.

## Testing

```sh
npm test                                        # Vitest unit tests
npm run test:visual                             # WebKit screenshot tests (macOS only)
cargo test --manifest-path src-tauri/Cargo.toml # Rust tests
```
