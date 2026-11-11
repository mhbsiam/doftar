# Security

Doftar is a local-first file manager. Nothing you browse, open, search or
preview leaves your Mac through Doftar.

## What Doftar promises

- **No network use.** There is no update check, telemetry, crash reporting or
  remote content.
  - The Rust process and the tools it starts run in a Seatbelt sandbox that
    refuses IP sockets (`src-tauri/src/netguard.rs`). If the sandbox can't
    start, Doftar still runs and prints the error to stderr.
  - WebKit's helper processes sit outside the sandbox. The content security
    policy limits them to the app's own files and Tauri's local IPC
    (`src-tauri/tauri.conf.json`).
  - `deny.toml` fails the build if an HTTP, TLS or WebSocket crate enters the
    macOS dependency graph.
  - Web links in a Markdown file or PDF, and **Check for updates**, open in
    your default browser. Doftar never fetches them, and no window can leave
    Doftar's own pages (`own_page` in `src-tauri/src/main.rs`).
  - Terminals are the one exception. They start outside the sandbox on
    purpose, because a shell needs the network. A command typed in the address
    bar goes through a small helper applet (`src-tauri/src/launcher.rs`) in
    Doftar's private cache folder, which runs only scripts from that folder.
- **Files you download stay quarantined.** Items extracted from a quarantined
  archive get the same `com.apple.quarantine` mark, so Gatekeeper and XProtect
  check an app or script inside a downloaded zip the first time it runs, as
  they would after Finder. Copies keep extended attributes through
  `copyfile(3)`, so the mark survives copying and moving.
- **Scripts ask before they run.** Opening a script, a bare program, an
  installer or a file whose default app is a known terminal or a code launcher
  asks first, and the check is enforced in Rust (`open_path` and `open_with`
  in `src-tauri/src/openwith.rs`), not only in the interface. Apps and
  `.fileloc` files open without asking, as they do in Finder, and so does a
  script whose default app is a terminal Doftar doesn't know. Links in a
  document never run programs.
- **Documents are shown, not run.** Markdown, text and code are parsed in Rust
  and drawn element by element; the document's own HTML is never inserted into
  the page. PDFs are drawn by PDFKit, and their links may open only web and
  mail addresses. Images and thumbnails are decoded by `sips`, ImageIO and
  Apple's sandboxed Quick Look thumbnail service. Data files (HDF5, Parquet,
  Excel, SQLite and others) are parsed inside Doftar's own process, by Rust
  crates and, for HDF5 and SQLite, bundled C libraries, so a malformed file
  meets that parser directly; it runs inside the same no-network sandbox.
- **Viewer windows get less than the main window.** The reader window may
  read and save only the documents it was asked to open and the files they
  link to, and open only the web and mail links those documents contain; Rust
  keeps that list (`src-tauri/src/reader.rs`). A page that was taken over could
  still read or change any file such a document links to. The image, PDF and
  video windows' commands accept any path rather than a list; they show files,
  and the image window can also save an edited image. Only the main and tab
  windows can confirm running a program; an image, PDF or video window never
  can.
- **System locations are off limits.** `src-tauri/src/guard.rs` refuses to
  move, rename, trash or delete macOS's own folders, volume roots, the home
  folder and its standard folders, whatever the interface asks for.
- **Admin deletion is narrow.** Removing an app that needs administrator
  rights goes through macOS's own authorization prompt and only ever applies
  to a real app bundle inside an Applications folder, checked again as root
  just before it is removed.

## What Doftar stores on this Mac

| What | Where | Notes |
|---|---|---|
| Favorites, recents, Trash origins | `~/Library/Application Support/com.doftar.app/store.json` | Written with mode 0600 |
| Settings (theme, view, tags…) | the webview's local storage for the app | |
| Thumbnails of files on the startup disk | `~/Library/Caches/com.doftar.app/thumbs` | Folder mode 0700, excluded from Time Machine, trimmed automatically; **Options → Clear cache** removes it |
| Previews of files on other volumes | `~/Library/Caches/com.doftar.app/session/<device>` | Deleted when the volume is ejected and at quit |

Options → **Thumbnails on external drives** turns off thumbnail generation
for USB, network and other mounted volumes altogether.

## Build and supply chain

- Dependencies are locked (`package-lock.json`, `src-tauri/Cargo.lock`),
  installed with `npm ci --ignore-scripts`, and audited weekly in CI with
  `npm audit`, `cargo audit` and `cargo deny` (advisories, licenses, and the
  no-network ban list). Dependabot proposes updates weekly.
- GitHub Actions are pinned to commit hashes. The release job builds the
  app into a draft release, and the release is made public only
  after SHA-256 checksums (`SHA256SUMS`) and a build provenance attestation are
  attached. Verify the attestation with
  `gh attestation verify <file> --repo mhbsiam/doftar`.
- Releases are ad-hoc signed, without an Apple Developer ID, so Gatekeeper asks
  you to confirm the first launch (System Settings → Privacy & Security → Open
  Anyway). Please check the DMG against `SHA256SUMS` and its attestation first.
- The only third-party Tauri plugins are `tauri-plugin-opener` (maintained by
  the Tauri team) and `tauri-plugin-drag` (a small plugin by a Tauri
  maintainer, used for dragging files out of the window). Both are reviewed
  on update.

## Verifying the no-network claim yourself

- Install [Little Snitch](https://www.obdev.at/products/littlesnitch/) or
  [LuLu](https://objective-see.org/products/lulu.html) and watch for Doftar: it
  never asks.
- `lsof -i -a -c Doftar` while browsing, searching and previewing shows no
  sockets.

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting:
<https://github.com/mhbsiam/doftar/security/advisories/new> (**Security →
Report a vulnerability**). Please don't open a public issue. Include the Doftar
version, macOS version and steps to reproduce. I aim to reply within a week.
