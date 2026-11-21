# Doftar on Linux

A port of Doftar (macOS) to Linux, targeting Ubuntu 24.04+. It builds a
`.deb` (and AppImage) through Tauri + WebKitGTK.

## Build

1. Rust toolchain (`rust-toolchain.toml` pins the channel):

   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. Node dependencies:

   ```bash
   npm install
   ```

3. GTK/WebKit development libraries — pick ONE:

   **System install (needs sudo, recommended):**

   ```bash
   sudo apt update && sudo apt install -y build-essential pkg-config cmake \
     libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
     librsvg2-dev libssl-dev libdbus-1-dev curl file
   ```

   **No sudo: extract dev packages into a sysroot** (this repo was first
   built this way). `scripts/make-sysroot.sh` creates `~/doftar-sysroot`
   with real `.pc` files and `.so` links plus stub `.pc` files for leaf
   dependencies. Then export:

   ```bash
   export PKG_CONFIG_PATH=$HOME/doftar-sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:$HOME/doftar-sysroot/usr/share/pkgconfig
   export PKG_CONFIG_SYSROOT_DIR=$HOME/doftar-sysroot
   export RUSTFLAGS="-L $HOME/doftar-sysroot/usr/lib/x86_64-linux-gnu"
   ```

4. Build and bundle:

   ```bash
   npx tauri build --bundles deb        # or: --bundles appimage, or omit for both
   ```

   Output lands in `src-tauri/target/release/bundle/`.

   For a quick run without bundling: `npm run build && cargo run` inside
   `src-tauri`, or `npx tauri dev` for the dev-server workflow.

## Status: what works

- Tabs, split view, folder tree, address bar, disk map, search
- Built-in viewers: code/text (edit + save), markdown, CSV/TSV, SQLite,
  Parquet, AnnData/HDF5, notebooks, docx, xlsx, model weights, images, video
- File operations: copy/move/rename/trash (freedesktop trash at
  `~/.local/share/Trash/files` + per-volume `.Trash-$uid`), delete,
  archive create/extract (`zip`/`unzip` for .zip, GNU `tar` for tar
  variants, `bsdtar` for exotic formats when installed), checksums
- Copy preserves mode bits, timestamps (`utimensat`) and `user.*` xattrs;
  cross-volume copies are verified when "verify copies" is on
- Undo for Move to Trash resolves the real freedesktop trashed path via
  `.trashinfo` sidecars; Put Back restores items to their origin
- In-app file clipboard (copy/cut/paste) works across Doftar windows in
  the same process
- Filenames that are not UTF-8 display correctly and remain operable:
  path bytes are encoded through private-use codepoints across the IPC
  bridge (`src/paths.rs`)
- Text editor saves atomically via `fs::rename` in the same directory
- Open: `xdg-open` default apps, "Open With" list from XDG
  mimeinfo/mimeapps (`gio launch`), "Reveal in folder" via the
  `org.freedesktop.FileManager1` D-Bus interface (falls back to opening
  the containing folder)
- Open in Terminal: GNOME Terminal, Console (kgx), Konsole, Xfce Terminal,
  XTerm, Alacritty, Kitty, Ghostty, WezTerm, Tilix, MATE Terminal;
  `x-terminal-emulator` as fallback
- Menus and `CmdOrCtrl` keyboard shortcuts (Ctrl on Linux)
- Volumes: root plus mounts under `/media`, `/run/media`, `/mnt`, `/boot`
  from `/proc/self/mounts`; network filesystem detection by fstype
- Tags on the freedesktop `user.xdg.tags` xattr: assign from the
  right-click menu, color dots on entries, the Tags page, tag filters and
  grouping, and tag search (a scan of the home folder when no root is set)
- PDF viewer window and preview-pane pages, rendered by pdf.js in the
  webview: page box, zoom/fit/two-up, find with highlights, thumbnails
  sidebar, password unlock, "Open in default app"
- Thumbnails: raster images decode in-process (`image` crate), video via
  `ffmpeg` and PDF pages via `pdftoppm` when those tools are installed;
  other document types keep their icon
- Folder watching (inotify via the `notify` crate): listings refresh on
  external changes
- Space previews one selected item in the built-in viewers — the Quick
  Look stand-in; it never launches a foreign app or runs a file
- Image editing (turn, mirror, crop) in-process via the `image` crate;
  EXIF is dropped on edited copies
- Page transitions without view transitions: WebKitGTK never runs the
  `startViewTransition` callback (and can crash on it), so navigation,
  tab switches and view changes animate through class-based fallbacks
  with the same curves, and theme changes cross-fade (`src/util/transition.ts`)
- Trash honors `$XDG_DATA_HOME` end to end: the sidebar, Put Back and
  `isInTrash` all follow the folder the backend reports

## Removed (macOS features with no Linux equivalent)

- **Quick Look panel**: Space now previews in the built-in viewers
  instead. The native panel and its thumbnail generation stay macOS-only
  (`#[cfg(target_os = "macos")]`).
- **Share sheet** (`share_paths`).
- **Uninstall view** (`app_leftovers`) — macOS bundle logic. Its
  commands, capabilities and ipc wrappers are gone on Linux.
- **macOS-only menu items** (Services, Hide, App Store updates) are not
  built on Linux.

## Known gaps (stubbed or degraded, still reachable)

- **HEIC and camera RAW**: no thumbnails and no preview conversion (the
  `image` crate has no HEIC/RAW decoder); they keep their icon and open
  externally. Image editing refuses them with a clear error.
- **Thumbnails for documents other than PDF**, and audio artwork: no
  thumbnail (icon fallback).
- **Media info rows** (duration, codec) in Properties are blank:
  `media_info` needs the macOS AVFoundation path.
- **Cross-app file clipboard**: copy/paste only works between Doftar
  windows, not with other apps (path: `arboard` +
  `x-special/gnome-copied-files`).
- **Network guard**: the no-network sandbox is macOS Seatbelt only
  (path: seccomp/landlock). The CSP still blocks the webview.
- **Zoom/fly window animations**: windows appear instantly (the icon
  flight inside a window still plays where a viewer supports it).
- **Opened-with files**: files passed as CLI arguments aren't wired yet.
- **Drag-out** to other apps: `tauri-plugin-drag` has no Linux backend;
  drags inside the app still work.
- Window controls: there are none inside the app — `CaptionButtons` renders
  nothing on Linux and the window manager draws the decorations
  (`decorations: true`); `titleBarStyle: Overlay` is a macOS setting.
- **Sleep inhibition**: no logind inhibitor is taken, so the machine may
  sleep while a long job runs.

## Safety notes

- `guard.rs` protects Linux system trees (`/etc`, `/boot`, `/usr`,
  `/proc`, `/sys`, `/dev`, `/var`, mount roots under `/mnt`, `/media`,
  `/run/media`) plus `~/.ssh`, `~/.gnupg` and the XDG home folders.
- Archive extraction rejects absolute/`..` paths, checks writes through
  archived symlinks, and compares declared vs. written size (zip bombs).
- `zip -y` stores symlinks as links instead of following them.

## Porting notes

- Platform code is split with `#[cfg(target_os = "macos")]` /
  `#[cfg(not(target_os = "macos"))]`; the upstream tree already had stubs
  for most modules. `openwith.rs`, `fsops/terminal.rs`, `launcher.rs`,
  `quarantine.rs`, `cache.rs`, `fsops/transfer.rs`, `fsops/list.rs` carry
  the real Linux implementations added by the port.
- macOS `statfs`/`renamex_np`/xattr calls were replaced by
  `/proc/self/mounts`, `renameat2(RENAME_NOREPLACE)`, and `lgetxattr`.
- `rust-toolchain.toml` now builds for `x86_64-unknown-linux-gnu` as well
  as `aarch64-apple-darwin`.
