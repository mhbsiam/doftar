# Changelog

## 1.0.3 — 2026-11-18

- A preview version of Doftar for Linux is available. It runs on Ubuntu 24.04 and later (x86_64), as a .deb and an AppImage. [LINUX.md](LINUX.md) tells what works.
- Split view opens and closes with a fold animation.
- If the screen does not have sufficient space, the left pane becomes narrower.
- A Select by Pattern button (*) is adjacent to the command palette.
- Esc closes split view and keeps the pane that you use. If a cut is pending, Esc cancels the cut first.
- Help is larger. A search box finds topics in all sections, and each section starts with links to its topics.
- Help tells about the features added since 1.0.1.
- Column names in data tables align with their columns.
- Doftar uses a zlib version with a security fix (RUSTSEC-2026-0544).
- Check for updates (in the Options menu) opens the latest release.
- In the preview pane, the other sheets and tables of Excel and SQLite files open.
- After you move files to the Trash or delete them, they are not on the clipboard or in Paste from History.
- The preview pane does not stop on a FIFO or a device file.
- Doftar removes old thumbnails of files on external drives.
- A .npy file with an impossible shape in its header shows an error.
- Long videos play with sound in the player and the preview pane. Before, WebKit lost the audio track of some long videos.

### Linux preview

The Linux app has the features of the Mac app, except Quick Look, Share, Uninstall and native PDF pages. Fixes made in the port:

- The image viewer's **Open in default app** works: the viewer window was
  missing the `open_path` permission.
- PDFs that use non-embedded standard fonts or CJK text render correctly:
  the content security policy now allows the app's own cmaps and fonts.
- Saving from the built-in editors keeps the file's tags (`user.*` xattrs)
  and its times; the inode swap no longer drops them.
- Copying refuses special files (FIFOs, devices) with a per-file error
  instead of hanging the job; Cancel stays responsive.
- A crafted GIF header can no longer abort the app — image decoding is
  bounded, including the GIF branch the limits missed.
- Empty Trash removes the `.trashinfo` sidecars too, including ones
  orphaned earlier, and the locked-file recovery no longer shells out to
  the macOS-only `chflags`.
- "Open in Terminal" and tag search handle folders whose names are not
  UTF-8; archives compress and extract them byte-exactly.
- Eject, `xdg-mime`, `xdg-open` and D-Bus calls run under timeouts, and
  every opened terminal is reaped instead of left as a zombie.
- The Trash row's context menu no longer races the folder load at startup.
- Help describes the Linux app and shows Linux shortcuts (Ctrl, Alt).

## 1.0.2 — 2026-11-13

- Disk usage shows a Git worktrees card. It lists the linked git worktrees that the scan finds.
- Each worktree shows its repository, branch, size, uncommitted changes and commits that no other branch has.
- Move to Trash checks the worktree again. It asks before it removes work that is not committed.

## 1.0.1 — 2026-11-12

- Doftar downloads online-only files before it copies or moves them out of OneDrive, Google Drive, Box or iCloud.
- A two-finger swipe must be longer before it goes Back or Forward.
- An arrow shows the direction during a two-finger swipe.
- You can turn off two-finger swipe in Settings → Files.
- The search box does not look selected when it is off.

## 1.0.0 — 2026-11-08

First release. See the [full feature list](docs/REFERENCE.md).
