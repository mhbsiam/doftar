# Doftar reference

Everything that doesn't fit in the [README](README.md): the full feature list,
keyboard shortcuts, building from source, publishing a release and the source
layout.

- [Features](#features)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Building from source](#building-from-source)
- [Releasing](#releasing)
- [Project layout](#project-layout)

## Features

### Layout and navigation

- Explorer-style tab strip, command bar, breadcrumb address bar, navigation pane and status bar
- Home page with Quick access, Favorites and Recent files
- Tabs with their own back / forward / up history
- Drag tabs to reorder, pull one out into a new window, or drop it on another window's tab strip
- Favorites, settings and the clipboard stay in sync across windows
- Native macOS menu bar with Finder shortcuts; Windows Ctrl/Alt shortcuts work too

### Browsing

- Details view (sortable columns) and grid view
- Cached thumbnails, HEIC included
- Fast with tens of thousands of items
- Live refresh of the open folder, no F5 needed
- Search the open folder as you type; press Enter to search all subfolders
- Show or hide hidden files, including macOS-hidden ones like `~/Library`
- App bundles open like files; **Show Package Contents** browses inside
- Shortcut arrows on symlinks and Finder aliases

### File operations

- Cut, copy and paste, shared with Finder in both directions
- Rename inline, new folder, new text document
- Move to Trash, delete permanently, Empty Trash, **Put Back**
- **Replace / Skip / Keep both** when a name already exists
- Undo and redo for the last 50 operations
- Copy and move jobs with progress, speed, time left and Cancel
- Copies keep Finder tags, extended attributes and ACLs
- **Compress to ZIP** and **Extract here** (zip, tar, 7-Zip, RAR, ISO, CAB and more)
- **Eject** external and network drives

### Drag and drop

- Drop on a folder, tab or breadcrumb to move (same drive) or copy (other drive)
- Hold Option to force a copy
- Drop on Trash to delete; drop a folder on Favorites to pin it
- Hover a folder or tab while dragging to open it
- Drag files to and from Finder, Mail, Slack or a browser

### Viewers

- **Images**: zoom, pan, step through the folder, rotate, flip, crop, save or save a copy
- **PDFs**: page thumbnails, zoom, two-page view, find, password-protected files
- **Markdown**: tables, code blocks, task lists, footnotes and a heading outline
- **Text and code**: line numbers and syntax colours for common languages
- **Open in Preview** or **Open with** another app is always one click away

### Terminal

- **Open in Terminal** on any folder
- Works with Terminal, iTerm2, Warp, Ghostty, WezTerm and Zentty
- Type a command in the address bar to run it in the current folder

### Details and info

- **Properties**: size, size on disk, permissions, Finder tags, default app
- Combined Properties for a multi-selection
- **Copy as path**

### Look and accessibility

- Light, dark and system themes
- Adjustable text size
- Keyboard-first file list with type-ahead
- WCAG 2.1 AA contrast and reduced-motion support
- 120 Hz animation on ProMotion displays

## Keyboard shortcuts

Mac keys first; the Windows-style keys in the right column also work.

| Action | Mac | Windows-style |
|---|---|---|
| Copy / Cut / Paste | `⌘C` / `⌘X` / `⌘V` | `Ctrl + C / X / V` |
| Move item here (paste as move) | `⌘⌥V` | |
| Undo / Redo | `⌘Z` / `⇧⌘Z` | `Ctrl + Z / Shift + Z` |
| Select all | `⌘A` | `Ctrl + A` |
| Quick Look (tap to toggle, hold to peek) | `Space` | |
| Move to Trash | `⌘⌫` | `Delete` |
| Delete immediately | `⌘⌥⌫` | `Shift + Delete` |
| New folder / text document | `⌘⇧N` / `⌘⇧T` | `Ctrl + Shift + N / T` |
| New tab / close tab | `⌘T` (or `⌘N`) / `⌘W` | `Ctrl + T / W` |
| Move focused tab left / right | `⌘⇧←` / `⌘⇧→` | `Ctrl + Shift + ← / →` |
| Close window | `⌘⇧W` | |
| Open selection | `⌘↓` | `Enter` |
| Properties | `⌘I` | |
| Rename | `F2` | `F2` |
| Open in default terminal | `⌥⌘T` | |
| Back / Forward | `⌘[` / `⌘]` | `Alt + ← / →` |
| Enclosing folder | `⌘↑` | `Alt + ↑` |
| Go to Folder… (edit address) | `⌘⇧G` | |
| Home / Desktop / Documents / Downloads / Applications | `⌘⇧H` / `⌘⇧D` / `⌘⇧O` / `⌘⌥L` / `⌘⇧A` | |
| Icons / Details view | `⌘1` / `⌘2` | |
| Toggle hidden files | `⌘⇧.` | `Ctrl + H` (`⌘H` stays macOS Hide) |
| Search | `⌘F` | `Ctrl + F` |
| Refresh | `⌘R` | `Ctrl + R` or `F5` |

## Building from source

Prerequisites: Node ≥ 18, Rust (`rustup`), macOS.

```sh
npm install
npm run tauri dev
```

First Rust build takes a few minutes; subsequent ones are incremental.

Release DMG (universal, ad-hoc signed; the same on every Mac):

```sh
npm run dmg               # build only
npm run dmg -- --install  # build, then replace /Applications/Doftar.app
```

Outputs, in `src-tauri/target/universal-apple-darwin/release/bundle/`:

- `dmg/Doftar_<version>_universal.dmg`: installable DMG
- `dmg/SHA256SUMS`: its checksum
- `macos/Doftar.app`

What keeps builds consistent across machines:

- `rust-toolchain.toml` pins the Rust version and both macOS targets; rustup
  installs them on first use.
- `bundle.macOS.signingIdentity` is `"-"` in `src-tauri/tauri.conf.json`, so
  every build (local and CI) is ad-hoc signed with the hardened runtime.
- `scripts/build-dmg.sh` puts Apple's `codesign` first on `PATH` (Anaconda
  ships one that breaks signing), detaches scratch images left mounted by a
  failed run, and checks the signature, architectures and DMG afterwards.

Rebuild notes:

- Builds are incremental; only the first one takes a few minutes.
- Ad-hoc signing has no Developer ID, so Gatekeeper still warns on other
  Macs. Click **Open Anyway** in System Settings → Privacy & Security to
  bypass, or run `xattr -cr` on the installed app. Removing the warning requires signing + notarization with an
  Apple Developer ID.
- Each rebuild changes the app's code identity, so macOS forgets its Files and
  Folders grants; re-allow Doftar in Privacy & Security after installing.
- `npm run tauri dev` is unchanged for day-to-day work.

## Releasing

Doftar makes no network connections: there is no update check, telemetry or
crash reporting. New versions are installed by downloading a release and
replacing the app.

To publish a release:

1. Raise `version` in `src-tauri/tauri.conf.json` and push.
2. On GitHub, open **Actions → Release → Run workflow**. It builds a universal
   (Apple Silicon + Intel) app, tags `v<version>` and publishes the release
   with the DMG, a `SHA256SUMS` file and a build provenance attestation
   (`gh attestation verify Doftar_<version>_universal.dmg --repo <owner>/doftar`).

The `release` environment the workflow runs in can be given required
reviewers in the repository settings.

## Project layout

```
src/                    React frontend (Fluent UI v9, Zustand stores)
  components/           title bar, command bar, address bar, nav pane, views
  stores/               tabs, clipboard, history, jobs, settings, appdata, ui
  hooks/                directory listing and watcher, system info, shortcuts
  util/                 formatting, file kinds, naming, view transitions
src-tauri/              Rust core
  src/fsops.rs          list, copy, move, rename, trash, volumes, undo steps
  src/jobs.rs           cancellable jobs, throttled progress events
  src/clipboard.rs      NSPasteboard file-URL read and write
  src/openwith.rs       Open With app list (NSWorkspace), launching, run-confirmation gate
  src/guard.rs          locations that are never moved, trashed or deleted
  src/netguard.rs       Seatbelt profile that denies the process every IP socket
  src/quarantine.rs     quarantine mark propagation and download origin
  src/search.rs         recursive filename search (mdfind, bounded-walk fallback)
  src/props.rs          Properties data: item info, cancellable folder size
  src/trash.rs          Empty Trash, Finder put-back fallback, volume eject
  src/thumbs.rs         cached thumbnails via sips and the Quick Look thumbnail service
  src/watcher.rs        refcounted kqueue watcher, one fd per open folder
  src/menu.rs           native macOS menu bar
  src/store.rs          persisted pins, favorites and recents
deny.toml               cargo-deny policy: licenses and the no-network crate ban list
assets/                 icon source drawings (SVG)
scripts/gen-icons.mjs   regenerates all bundle icons (needs rsvg-convert: brew install librsvg)
scripts/gen-notices.mjs regenerates THIRD_PARTY_NOTICES.md
```
