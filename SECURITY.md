# Security

Doftar is a local-first file manager. Nothing you browse, open, search or
preview leaves your Mac through Doftar.

## What Doftar promises

- **No network use.** There is no update check, telemetry, crash reporting or
  remote content. The Rust process runs inside a Seatbelt sandbox that refuses
  every IP socket (`src-tauri/src/netguard.rs`), the webview's content
  security policy only allows the app's own files and Tauri's local IPC
  (`src-tauri/tauri.conf.json`), and `deny.toml` fails the build if an HTTP,
  TLS or WebSocket crate ever enters the macOS dependency graph. Web links in
  a Markdown file or a PDF are handed to your default browser, which is a
  separate process; Doftar itself never fetches them. Terminals are the one
  thing Doftar starts outside its sandbox, on purpose: a shell has to reach
  the network. A command typed in the address bar goes through a small
  helper applet (`src-tauri/src/launcher.rs`, made with the system's
  `osacompile` in Doftar's private cache folder) that runs only scripts
  from that folder, so no other sandboxed app can use it as a way out.
- **Files you download stay quarantined.** Items extracted from a quarantined
  archive get the same `com.apple.quarantine` mark, so Gatekeeper and XProtect
  check an app or script inside a downloaded zip the first time it runs, as
  they would after Finder. Copies keep extended attributes through
  `copyfile(3)`, so the mark survives copying and moving.
- **Nothing runs without asking.** Opening a script, a program or a file whose
  default app is a terminal or a code launcher asks first, and the check is
  enforced in Rust (`open_path` and `open_with` in `src-tauri/src/openwith.rs`),
  not only in the interface. Links in a document never run programs.
- **Documents can't run code.** Markdown, text and code are parsed in Rust and
  drawn element by element; the document's own HTML is never inserted into the
  page. PDFs are drawn by PDFKit, and their links may open only web and mail
  addresses. Images and thumbnails are decoded by `sips`, ImageIO and Apple's
  sandboxed Quick Look thumbnail service.
- **System locations are off limits.** `src-tauri/src/guard.rs` refuses to
  move, rename, trash or delete macOS's own folders, volume roots, the home
  folder and its standard folders, whatever the interface asks for.
- **Admin deletion is narrow.** Removing an app that needs administrator
  rights goes through macOS's own authorization prompt and only ever applies
  to a real app bundle inside an Applications folder.

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
- GitHub Actions are pinned to commit hashes. The release job builds a
  universal app, publishes SHA-256 checksums beside the DMG, and attaches a
  build provenance attestation you can verify with
  `gh attestation verify <file> --repo <owner>/doftar`.
- Releases are not code-signed, so Gatekeeper asks you to confirm the first
  launch (right-click → Open). Check the DMG against `SHA256SUMS` and its
  attestation before doing so.
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

Open a private security advisory on GitHub (**Security → Report a
vulnerability**) or email the maintainer listed in `package.json`. Please
include the Doftar version, macOS version, and steps to reproduce. You will
get a reply within a week.
