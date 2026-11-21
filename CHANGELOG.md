# Changelog

## Linux — unreleased

The Linux port, based on the Mac app's 1.0.3. Fixes made while porting:

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
- Help describes the Linux app, and REFERENCE.md's shortcut table matches
  the shortcuts Linux ships.

## 1.0.3 — 2026-11-18

- Split view opens and closes with a fold animation.
- If the screen does not have sufficient space, the left pane becomes narrower.
- A Select by Pattern button (*) is adjacent to the command palette.
- Esc closes split view and keeps the pane that you use. If a cut is pending, Esc cancels the cut first.
- Help is larger. A search box finds topics in all sections, and each section starts with links to its topics.
- Help tells about the features added since 1.0.1.
- Column names in data tables align with their columns.
- Doftar uses a zlib version with a security fix (RUSTSEC-2026-0544).

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
