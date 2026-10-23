![Doftar: the Explorer-style file manager for macOS](assets/header.png)

# Doftar

**A file manager for macOS with an Explorer-style layout, made for people
coming from Windows.**

[![Download](https://img.shields.io/github/v/release/mhbsiam/doftar?label=download&color=30736d)](https://github.com/mhbsiam/doftar/releases/latest)
![macOS 13+](https://img.shields.io/badge/macOS-13%2B-lightgrey)
[![website](https://img.shields.io/badge/website-mhbsiam.github.io%2Fdoftar-30736d)](https://mhbsiam.github.io/doftar/)

Tabs, a command bar, a breadcrumb address bar and a navigation pane, with the
keyboard shortcuts you already know from Windows (Mac ones work too). Runs on
Apple Silicon and Intel, makes no network connections, and needs nothing else
installed.

### Doftar website

See Doftar in action, take a tour of its features, and download the latest
build in one click at **[mhbsiam.github.io/doftar](https://mhbsiam.github.io/doftar/)**.

## Download

1. Download the latest DMG from the
   **[Doftar website](https://mhbsiam.github.io/doftar/#download)**, or get
   `Doftar_<version>_macos.dmg` from
   [Releases](https://github.com/mhbsiam/doftar/releases/latest).
2. Open the DMG and drag **Doftar** into **Applications**.
3. Open Doftar. The app isn't notarized yet, so macOS says it can't verify
   it. Click **Done**, not Move to Trash.
4. Open **System Settings → Privacy & Security**, scroll down, and click
   **Open Anyway** next to the message about Doftar. Click **Open** and enter
   your password. You only do this once.

Prefer Terminal? Run `xattr -cr /Applications/Doftar.app` instead of steps 3
and 4, then open Doftar as usual.

Updating is the same: download the new release and replace the app.

## Highlights

- **Explorer layout**: tabs you can drag between windows, back/forward/up,
  a Home page with Quick access, Favorites and Recent files
- **Fast browsing**: details and grid views with cached thumbnails (HEIC
  included), smooth with tens of thousands of items, live refresh
- **File operations**: cut/copy/paste that works with Finder, undo/redo,
  drag and drop, copy jobs with progress and cancel
- **Built-in viewers**: images (with rotate, flip and crop), PDFs, Markdown,
  and syntax-coloured text and code
- **Archives**: compress to ZIP and extract zip, tar, 7-Zip, RAR, ISO and more
  with tools that ship with macOS
- **Open in Terminal**, and an address bar that runs commands in the current
  folder
- **Light, dark and system themes**, adjustable text size, keyboard-first,
  WCAG 2.1 AA contrast

The full feature list and keyboard shortcuts are in
[REFERENCE.md](REFERENCE.md).

## Security and privacy

Doftar is local-first: nothing you browse, search or preview leaves your Mac
through it. In short (the details, and what Doftar stores where, are in
[SECURITY.md](SECURITY.md)):

- **No network.** No update check, telemetry or crash reporting. The process
  runs in a sandbox that refuses every IP socket, the webview can only reach
  the app's own files, and the build fails if a networking crate ever enters
  the dependency graph. Web links in documents open in your browser.
- **Downloads stay quarantined.** Anything extracted from a downloaded archive
  keeps macOS's quarantine mark, so Gatekeeper checks an app or script inside
  it on first run, as it would after Finder. Properties shows where a
  download came from.
- **Nothing runs without asking.** Opening a script or program, or handing a
  file to a terminal, asks first, and the Rust side refuses to do it without
  that confirmation. Links in a document never run programs.
- **Documents can't run code.** Markdown, text and code are drawn element by
  element from a Rust parser; PDFs are drawn by PDFKit and their links may
  only open web and mail addresses.
- **Thumbnails are private.** The cache is readable by you alone and excluded
  from Time Machine; previews of other volumes are deleted when the volume is
  ejected, and **Options → Privacy** can turn them off altogether.

## macOS permissions (TCC)

The first time you browse **Desktop, Documents, Downloads**, or an external
volume, macOS asks for folder access. Click OK. If you denied a prompt, grant
access in **System Settings → Privacy & Security → Files and Folders** (or
Full Disk Access) for Doftar.

Moving to Trash uses `NSFileManager` directly rather than scripting Finder, so
there is **no "Doftar wants to control Finder" Automation prompt** and no
Finder sound. Doftar remembers where it trashed things from, so **Put Back**
works for those items without Finder. Items trashed elsewhere (e.g. in Finder)
are put back by asking Finder, which triggers the one-time Automation prompt.
Emptying the Trash covers `~/.Trash` and the current user's per-volume
Trashes (`/Volumes/*/.Trashes/<uid>`).

## Contributing

Issues and pull requests are welcome. To run Doftar from source, see
[Building from source](REFERENCE.md#building-from-source). Keep the project under permissive licenses only: do not add
GPL, LGPL or AGPL dependencies, and run `npm run notices` after changing
dependencies. Before opening a pull request, make sure these pass:

```sh
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

## License

Doftar is released under the [Apache License 2.0](LICENSE).

Third-party software shipped with the app (npm and Rust dependencies, with
full license texts) is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md),
which is also bundled into the app. Regenerate it after changing dependencies:

```sh
npm run notices
```

All dependencies are under permissive licenses (MIT, Apache-2.0, BSD, Zlib,
Unicode) except five MPL-2.0 crates (`cssparser`, `cssparser-macros`,
`selectors`, `dtoa-short`, `option-ext`), which are used unmodified; see the
notices file for what that requires. There is no GPL, LGPL or AGPL code.

### What is, and is not, included

- UI components and icons: Microsoft **Fluent UI** and **Fluent System Icons**
  (MIT). Folder, file, drive and window-control glyphs are original drawings
  in this repo, not copied from Windows.
- **No Microsoft fonts or assets are bundled.** Text uses the macOS system
  font (San Francisco); the font stack names no Microsoft fonts. Never add
  Segoe UI files to this repo.
- No Windows logos, wordmarks, wallpapers, sounds or screenshots.
- UI wording avoids Microsoft-specific product strings (for example "This PC").

### Trademarks

*Windows*, *Segoe* and *Fluent* are trademarks of Microsoft Corporation;
*Finder* and *macOS* are trademarks of Apple Inc. Doftar is an independent
project for people coming from Windows, and is not affiliated
with, sponsored by, or endorsed by Microsoft or Apple. Do not distribute it
under a name or icon that implies otherwise.
