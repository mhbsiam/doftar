<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" height="128" alt="Doftar icon" />
</p>

<h1 align="center">Doftar</h1>

<p align="center">A free, offline macOS file manager with tabs, split view and built-in viewers for code, data and notebooks.</p>

<p align="center">
  <a href="https://github.com/mhbsiam/doftar/releases/latest">Download</a> &middot;
  <a href="https://mhbsiam.github.io/doftar/">Website</a> &middot;
  <a href="docs/REFERENCE.md">Full feature list</a>
</p>

<p align="center">
  <img src="assets/screenshot.png" width="720" alt="Doftar showing the Home page with Quick access, Drives, Favorites and Recent folders" />
</p>

Doftar is a Mac file manager that opens your data. Parquet, AnnData, SQLite,
notebooks, PDFs and code open in built-in viewers, next to the folders they
live in. It runs on Apple silicon Macs with macOS 27 or later and needs nothing
else installed.

## Why Doftar

- **Tabs and split view.** Two folders in one window, each with its own tabs.
- **An address bar you can type into**, and a folder tree with sizes and size bars.
- **Your data, read in place.** Tables, AnnData, SQLite, notebooks and model weights, without opening Python.
- **No network.** No update check or telemetry. Doftar has no networking code, and a sandbox blocks network sockets in its main process.

## Install

1. Download `doftar_v<version>_stable_macos.dmg` from **Assets** on the
   **[latest release](https://github.com/mhbsiam/doftar/releases/latest)**.
2. Open the DMG and drag **Doftar** onto **Applications**.
3. Open Doftar. It isn't notarized yet, so macOS says it can't verify it.
   Click **Done**, not Move to Trash.
4. Open **System Settings**, scroll down the sidebar to **Privacy & Security**,
   then scroll down the page to Security and click **Open Anyway** next to the
   message about Doftar.
5. macOS asks once more. Click **Open Anyway**.
6. Use Touch ID, or click **Use Password…** and enter your Mac password. You
   only do this once.

<table>
  <tr>
    <td align="center"><a href="docs/assets/install/1-download.png"><img src="docs/assets/install/1-download.png" height="140" alt="A GitHub release page with doftar_v1.0.0_stable_macos.dmg highlighted under Assets" /></a><br /><sub>1 · Download</sub></td>
    <td align="center"><a href="docs/assets/install/2-drag.png"><img src="docs/assets/install/2-drag.png" height="140" alt="The Doftar disk image window: drag the Doftar icon onto the Applications folder" /></a><br /><sub>2 · Drag</sub></td>
    <td align="center"><a href="docs/assets/install/3-done.png"><img src="docs/assets/install/3-done.png" height="140" alt="The &quot;Doftar&quot; Not Opened dialog, with Done highlighted" /></a><br /><sub>3 · Done</sub></td>
  </tr>
  <tr>
    <td align="center"><a href="docs/assets/install/4-settings.png"><img src="docs/assets/install/4-settings.png" height="140" alt="System Settings, Privacy &amp; Security: the sidebar item and Open Anyway highlighted next to the message that Doftar was blocked" /></a><br /><sub>4 · Open Anyway</sub></td>
    <td align="center"><a href="docs/assets/install/5-open-anyway.png"><img src="docs/assets/install/5-open-anyway.png" height="140" alt="The Open &quot;Doftar&quot;? dialog, with Open Anyway highlighted" /></a><br /><sub>5 · Open Anyway</sub></td>
    <td align="center"><a href="docs/assets/install/6-password.png"><img src="docs/assets/install/6-password.png" height="140" alt="The Touch ID prompt to continue with Privacy &amp; Security, with Use Password highlighted" /></a><br /><sub>6 · Touch ID</sub></td>
  </tr>
</table>

Prefer Terminal? This route skips Gatekeeper's check, so please verify the
download first. Put `SHA256SUMS` from the same release next to the DMG and run:

```sh
shasum -a 256 -c SHA256SUMS
# Optional, with the GitHub CLI: check the build provenance
gh attestation verify doftar_v<version>_stable_macos.dmg --repo mhbsiam/doftar
```

Then drag Doftar onto Applications and run this instead of steps 3 to 6:

```sh
xattr -cr /Applications/Doftar.app
```

**Updating:** download the new release and replace the app. **Check for
updates** only opens the releases page in your browser.

**Folder access:** the first time you browse Desktop, Documents, Downloads or
an external drive, macOS asks for access. Click OK. If you denied it, allow
Doftar in **System Settings → Privacy & Security → Files and Folders**.

## Features

- **Browse:** tabs, split view, list, column and icon views, a folder tree with sizes, search and filters, Tags and Screenshots pages, and a command palette.
- **Manage files:** cut, copy and paste shared with Finder, undo and an activity log, batch rename, archives, and drag and drop.
- **View:** images, PDFs, Markdown, code, video, audio, CSV, Parquet, Arrow, JSON, SQLite, Excel, AnnData/HDF5, NumPy, Jupyter notebooks and model weights.
- **Edit and compare:** a native text editor, and side-by-side compare for folders, text, Word files, tables and AnnData.
- **Tools:** disk usage and duplicate files, Git status and history, agent skills, an app uninstaller, and opening folders in your terminal or code editor.

Every feature and keyboard shortcut is in [REFERENCE.md](docs/REFERENCE.md).

## Privacy and security

- **No network.** No update check, telemetry or crash reporting. The main process and the tools it starts run in a sandbox that refuses IP sockets, and WebKit's helpers are limited by the content security policy. If the sandbox can't start, Doftar still runs. The build fails if a networking crate is added.
- **Errors stay on your Mac.** They go to `~/Library/Logs/Doftar/crash.log` and leave only if you copy them with **Help → Copy Diagnostic Info**.
- **Downloads stay quarantined.** Files extracted from a downloaded archive keep macOS's quarantine mark, so Gatekeeper still checks them.
- **Scripts ask first.** Opening a script or program needs your confirmation, and the Rust side enforces it.
- **Documents can't run code.** Markdown, text and code are drawn from a Rust parser, never as HTML.
- **Thumbnails are private.** The cache is readable by you alone and kept out of Time Machine.

More detail, and what Doftar stores where, is in [SECURITY.md](.github/SECURITY.md).

## Why I built this

Doftar is a weekend hobby project that grew out of everyday frustration with
the macOS Finder. If you've moved from Windows, your Explorer habits carry
over: tabs, an address bar, and shortcuts like F2, Ctrl+C and Delete.

## Why the name?

*Doftar* (দফতর) is the Bengali word for an office. It comes from the Persian
*daftar*, a register or ledger book where records were kept. A file manager is
where your records are kept, so the name fit.

## Contributing

Bug reports are very welcome. New features are on hold for now. See
[CONTRIBUTING.md](.github/CONTRIBUTING.md), the
[Code of Conduct](.github/CODE_OF_CONDUCT.md) and
[ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

[Apache License 2.0](LICENSE). Copyright © 2026 Hasanul Banna Siam; see
[NOTICE](NOTICE). Third-party software is listed with full license texts in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Dependencies use permissive
licenses or MPL-2.0 (weak copyleft). The one exception is libgit2, which is
GPLv2 with a linking exception that allows linking it into Doftar (the xdiff
code it bundles is LGPL-2.1-or-later).

Doftar is a file manager that copies, moves, overwrites and deletes files, so keep backups. Using the app is subject to the
[Terms of Use](TERMS.md), which it asks you to accept on first launch.

UI components and icons come from Microsoft **Fluent UI** and **Fluent System
Icons** (MIT). Folder, file and drive glyphs are original drawings. No
Microsoft fonts, logos or assets are bundled. *Windows*, *Segoe* and *Fluent*
are trademarks of Microsoft Corporation; *Finder* and *macOS* are trademarks of
Apple Inc. Doftar is an independent project, not affiliated with or endorsed by
either.
