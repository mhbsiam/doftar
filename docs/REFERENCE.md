# Doftar reference

Everything that doesn't fit in the [README](../README.md): the full feature list,
keyboard shortcuts, building from source and publishing a release. The source
layout is in [ARCHITECTURE.md](ARCHITECTURE.md).

- [Features](#features)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Building from source](#building-from-source)
- [Releasing](#releasing)

## Features

### Layout and navigation

- Explorer-style tab strip, command bar, breadcrumb address bar, navigation pane and status bar
- Home page with Quick access, Favorites, Recent folders and Recent files
- Tabs with their own back / forward / up history
- Drag tabs to reorder, pull one out into a new window, or drop it on another window's tab strip
- Favorites, settings and the clipboard stay in sync across windows
- Native macOS menu bar with Finder shortcuts; Windows Ctrl/Alt shortcuts work too
- Open a folder from outside: `open -a Doftar <folder>` in Terminal, or drop it on the Dock icon. In Finder, right-click → Services → **Reveal in Doftar** shows an item in its folder

### Browsing

- List view (sortable columns), column view, and icon view in four sizes
- Cached thumbnails, HEIC included
- Fast with tens of thousands of items
- Live refresh of the open folder, no F5 needed
- Search the open folder as you type; press Enter to search all subfolders
- Filter a folder or its search results by kind (images, documents, code…) and date modified
- A sparkle marks items changed in the last day
- Show or hide hidden files, including macOS-hidden ones like `~/Library`
- App bundles open like files; **Show Package Contents** browses inside
- Shortcut arrows on symlinks and Finder aliases
- **Preview bar** (⇧⌘P): double-click or Enter shows a file beside the listing instead of opening it
- **Tags** and **Screenshots** pages gather every file with a Finder tag, or every screenshot in your home folder
- Mouse side buttons and a sideways two-finger swipe go Back and Forward

### File operations

- Cut, copy and paste, shared with Finder in both directions
- Rename inline, new folder, new text document, **New Folder with Selection**
- **Paste an image or text** from the clipboard as a new file
- **Move to…** and **Copy to…** a folder you type or pick
- **Select by pattern** (`*.csv, report-??`) and **invert selection**
- **Batch rename** several items at once: replace text (or a regular expression), add text, change letter case, or number them with {n}, {name}, {date} and {folder}, with a preview
- Move to Trash, delete permanently, Empty Trash, **Put Back**
- **Replace / Skip / Keep both** when a name already exists
- Undo and redo for the last 50 operations
- **Activity log** (⌘⇧V): every file action, each with Undo
- Copy and move jobs with progress, speed, time left, **Pause** and Cancel
- A check for free space before copying to another drive, and optional **checksum verification** after it
- The Mac stays awake while a job runs
- Copies keep Finder tags, extended attributes and ACLs
- **Compress to ZIP** and **Extract here** (zip, tar, 7-Zip, RAR, ISO, CAB and more), and **Show contents** to look inside an archive first
- **Eject** external and network drives
- **Folder tree** (right-click a folder, or ⌘⇧E): a side panel listing everything inside it as an expandable tree, with each folder's size, a size bar, files' dates, and a search that opens the folders leading to each match
- **Compare folders** in split view: selects what each side lacks or has an older copy of, then copies it across
- **Compare files**: select two text, code or Word files and click Compare for them side by side, with the lines only one has marked the Git way. Word files compare with tracked changes accepted, and an Edit button on each side opens it for editing
- **Compare data files**: select two tables (CSV, TSV, JSON Lines, Parquet, Arrow/Feather, mixed too) for their column and row-count changes and the rows added, removed or changed, matched by an ID column you can pick. Two AnnData files compare their shapes, X, every key, and their obs and var tables. The first 10,000 rows of a table and 1,000 of obs and var are compared

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
- **Text and code**: line numbers and syntax colors for common languages
- **JSON**: a collapsible tree, or the text
- **Data tables**: CSV, TSV, JSON Lines, Parquet and Arrow/Feather. Click a column to sort; each column shows its range and missing values
- **AnnData and HDF5**: the summary Jupyter prints for `adata`, the obs and var tables, and the file's structure
- **NumPy**: `.npy` and `.npz` shape, type and a preview (object arrays are never loaded)
- **SQLite**: every table and view, and the schema, opened read-only
- **Jupyter notebooks**: Markdown, code and saved outputs (text, plots, errors); nothing in the notebook runs
- **Model weights**: `.safetensors` and `.gguf` tensors, metadata, parameter count and quantization, read from the header only
- **Spreadsheets**: Excel and OpenDocument sheets, from **Preview in Doftar** on the right-click menu
- **Video**: a built-in player
- **Text editor**: a native editor that keeps line endings and BOM as they were
- **Open in Preview** or **Open with** another app is always one click away

### Terminal and code editor

- **Open in Terminal** on any folder, or open it in your code editor from the address bar
- Works with Terminal, iTerm2, Warp, Ghostty, WezTerm and Zentty
- Type a command in the address bar to run it in the current folder

### Details and info

- **Properties**: size, size on disk, permissions, Finder tags, default app
- Combined Properties for a multi-selection
- **Copy as path**
- **SHA-256, SHA-1 and MD5** checksums of a file in Properties, with a box to check one you pasted
- **Media metadata**: duration, codec, resolution and camera columns, rename tokens, and a shot list export
- **Share**: Quick Look, the macOS Share menu (AirDrop, Mail, Messages) and Open With
- **Help → Copy Diagnostic Info** copies the latest errors from `~/Library/Logs/Doftar/crash.log`, with your home folder shortened to `~`

### Tools

- **Disk usage**: a treemap of what fills your disk, folder by folder, plus developer folders, AI model caches, the largest files and **duplicate files**, with CSV export
- **Git**: status badges on changed files, and a page listing every repository with its history
- **Agent skills**: every `SKILL.md` across your coding agents and `~/.agents/skills`, with symlinked copies recognized as one. The page is listed only when one of those folders exists
- **App uninstaller**: finds what an app leaves behind in `~/Library` and removes it with the app

### Look and accessibility

- Light, dark and system themes
- Adjustable text size, folder colors, date format and 12- or 24-hour clock
- Keyboard-first file list with type-ahead; right-click menus show shortcuts and jump to an item by its first letter
- WCAG 2.1 AA contrast and reduced-motion support
- 120 Hz animation on ProMotion displays

## Keyboard shortcuts

Mac keys first; the Windows-style keys in the right column also work.

| Action | Mac | Windows-style |
|---|---|---|
| Copy / Cut / Paste | `⌘C` / `⌘X` / `⌘V` | `Ctrl + C / X / V` |
| Move item here (paste as move) | `⌘⌥V` | |
| Activity: paste or undo | `⌘⇧V` | `Ctrl + Shift + V` |
| Copy as path | `⌥⌘C` | `Ctrl + Alt + C` |
| Undo / Redo | `⌘Z` / `⇧⌘Z` | `Ctrl + Z / Shift + Z` |
| Select all | `⌘A` | `Ctrl + A` |
| Select by pattern / Invert selection | `⌘⇧S` / `⌘⇧I` | |
| Quick Look (tap to toggle, hold to peek) | `Space` | |
| Move to Trash | `⌘⌫` | `Delete` |
| Delete immediately | `⌘⌥⌫` | `Shift + Delete` |
| New folder / text document | `⌘⇧N` / `⌘⌥N` | `Ctrl + Shift + N` / `Ctrl + Alt + N` |
| New folder with selection | `⌃⌘N` | |
| Duplicate | `⌘D` | `Ctrl + D` |
| Reveal in Finder | `⌥⌘R` | |
| New window | `⌘N` | `Ctrl + N` |
| New tab / close tab | `⌘T` / `⌘W` | `Ctrl + T / W` |
| Reopen closed tab | `⌘⇧T` | `Ctrl + Shift + T` |
| Next / previous tab | `⌃Tab` / `⌃⇧Tab` or `⌘⇧]` / `⌘⇧[` | `Ctrl + Tab / Shift + Tab` |
| Move focused tab left / right | `⌘⇧←` / `⌘⇧→` | `Ctrl + Shift + ← / →` |
| Folder tree | `⌘⇧E` | |
| Close window | `⌘⇧W` | |
| Split view / switch pane | `⌘\` / `F6` | `F6` |
| Preview bar (double-click and Enter then preview instead of opening) | `⇧⌘P` | `Ctrl + Shift + P` |
| Open selection | `⌘↓` | `Enter` |
| Properties | `⌘I` or `⌥Enter` | `Alt + Enter` |
| Rename (several items: batch rename) | `F2` | `F2` |
| Open in default terminal | `⌥⌘T` | |
| Back / Forward | `⌘[` / `⌘]` | `Alt + ← / →` |
| Enclosing folder | `⌘↑` | `Alt + ↑` |
| Go to Folder… (edit address) | `⌘⇧G` | |
| Home / Desktop / Documents / Downloads / Applications | `⌘⇧H` / `⌘⇧D` / `⌘⇧O` / `⌘⌥L` / `⌘⇧A` | |
| Icons / List / Columns view | `⌘1` / `⌘2` / `⌘3` | |
| Larger / smaller icons | `⌘=` / `⌘-`, or `⌘` + scroll | `Ctrl` + scroll |
| Toggle hidden files | `⌘⇧.` | `Ctrl + H` (`⌘H` stays macOS Hide) |
| Search | `⌘F` | `Ctrl + F` |
| Refresh | `⌘R` | `Ctrl + R` or `F5` |
| Command palette: search every command and favorite folder | `⌘K` | `Ctrl + K` |
| Settings | `⌘,` | |
| Keyboard shortcuts | `⌘/` | |
| Help: how each feature behaves and its limits | `⌘?` | |

## Building from source

Prerequisites: an Apple silicon Mac with macOS 27+, Xcode Command Line Tools, Node ≥ 22.12, Rust (`rustup`).

```sh
npm ci --ignore-scripts
npm run tauri dev
```

First Rust build takes a few minutes; subsequent ones are incremental.

Release DMG (Apple silicon, ad-hoc signed; the same on every Mac):

```sh
npm run dmg               # build only
npm run dmg -- --install  # build, then replace /Applications/Doftar.app
```

Outputs, in `src-tauri/target/aarch64-apple-darwin/release/bundle/`:

- `dmg/doftar_v<version>_stable_macos.dmg`: installable DMG
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

- Ad-hoc signing has no Developer ID, so Gatekeeper still warns on other
  Macs. Click **Open Anyway** in System Settings → Privacy & Security, or run
  `xattr -cr` on the installed app. Removing the warning needs signing and
  notarization with an Apple Developer ID.
- Each rebuild changes the app's code identity, so macOS forgets its Files and
  Folders grants. Allow Doftar again in Privacy & Security after installing.

## Releasing

Doftar has no update check, so people update by downloading a release and
replacing the app.

To publish a release:

1. Raise `version` in `package.json`, `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml`, update the `doftar` entry in `src-tauri/Cargo.lock`
   (`cargo check --manifest-path src-tauri/Cargo.toml` does it), add the
   version to `CHANGELOG.md`, and push. CI fails if the versions differ.
2. On GitHub, open **Actions → Release → Run workflow**. It builds an
   Apple silicon app and uploads `doftar_v<version>_stable_macos.dmg` to
   a draft release. Once `SHA256SUMS` and the build provenance attestation
   (`gh attestation verify doftar_v<version>_stable_macos.dmg --repo <owner>/doftar`)
   are attached, the last step publishes the release, which creates the
   `v<version>` tag on the commit that was built. If a run fails midway, the
   draft stays unpublished; re-running the workflow reuses it.

The `release` environment the workflow runs in can be given required
reviewers in the repository settings.

### Signing and notarization

Without a certificate the release is ad-hoc signed, as above. To ship a
notarized app, join the Apple Developer Program, create a **Developer ID
Application** certificate, and add these secrets to the `release`
environment:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | the certificate exported as `.p12`, base64 (`base64 -i cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | the password of that `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | the Apple ID of the developer account |
| `APPLE_PASSWORD` | an app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | the ten-character team id |

The workflow then signs with that identity, notarizes and staples the app,
and fails unless `spctl` accepts it. Only the release job contacts Apple; the
app still has no networking. This path has not run yet: test the first
notarized build on a Mac that never ran Doftar before publishing, since the
hardened runtime may need entitlements the ad-hoc build did not. Once a
notarized release is out, shorten the install steps in the README.
