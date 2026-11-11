# Improvement plan: everyday features, safety and polish

Written November 2026 from reading the source, not from running the app.
Same shape as [HARDENING.md](HARDENING.md): what exists, the gap, the smallest
fix, the files it touches and how to test it.

Sizes: **S** under half a day, **M** one to two days, **L** three or more.

## Status, November 2026

All phases are implemented, with these differences from the plan below:

- **16, motion.** The arrival and drop animations already existed (`flyIn`
  and `bump` in `flight.ts`), so only the progress ring on the destination
  folder was added (`ringOf` in `stores/jobs.ts`).
- **2, paste.** No TIFF-to-PNG conversion: an image offered only as TIFF is
  saved as TIFF.
- **5, archives.** A separate `ArchiveTree` in `FolderTree.tsx` reuses the
  tree rows and `flattenTree`, instead of a second data source for
  `FolderTree`. It is not yet in the Preview bar.
- **10, verify.** A job flag (`Job::set_verify`) set from the transfer
  commands. The toggle is File → Verify Copies to Other Drives.
- **11, awake.** An IOKit power assertion, not `NSProcessInfo`: it is a
  plain id that any thread may release.
- **14.** Only the notice was added, not a content scan.
- **15.** `fsops.rs` is split. `ImageViewer.tsx` is not.
- **17.** Tags stays with the places; Disk, Skills and Git moved to Tools.
- **18.** Three radius tokens (`--radius-s/m/l`, 5/7/10 px) replaced the
  4/6/8 px literals. Dialog order and title bar spacing are unchanged.
- **19.** The workflow signs and notarizes when the `release` environment
  has the secrets (REFERENCE.md lists them). It has never run with them.

## Corrections to the first review

Two things I listed as missing already exist:

- **Recent folders in ⌘K.** `CommandPalette.tsx:51` already lists them. The
  real gap is that only 12 are kept, by recency alone (item 1).
- **Search inside files.** `search.rs:98` already adds `kMDItemTextContent`
  when `contents` is on. The gap is narrower (item 14).

A single-instance guard is not needed: macOS already routes a second launch
to the running app (`RunEvent::Reopen` in `main.rs:421`). Dropped.

## Rules for every item

- Each new command goes in four places that must stay in step:
  `src-tauri/src/menu.rs`, `src/util/palette.ts`, `src/util/shortcuts.ts`
  and `docs/REFERENCE.md`. Behavior and limits also go in `src/util/help.ts`.
- Every file operation returns inverse `Step`s and is recorded with
  `useHistory.record`, so Undo and the Activity log keep working.
- New Rust logic gets a unit test beside it, in the style already in
  `fsops.rs` (sentence-named tests on a scratch folder).
- No new crates unless stated. `deny.toml` fails the build on network crates.
- Before each commit run the `ci.yml` steps locally: `npm ci
  --ignore-scripts`, `npm run build`, `npm test`, the cargo test and clippy
  step, `npm audit --audit-level=high`, `cargo audit`, `cargo deny check`.

## Order

| Phase | Items | Why this order |
|---|---|---|
| 0. Groundwork | 15 split `fsops.rs` | Items 7, 9, 10, 11 all edit it; split first to keep diffs readable |
| 1. Quick wins | 12, 13, 1, 6, 4 | All S, mostly front end, visible at once |
| 2. Everyday | 2, 3, 5, 7 | The features people will use daily |
| 3. Safety | 9, 10, 11 | Small Rust changes on the copy path |
| 4. Bigger | 8, 16, 17, 18 | Larger or subjective |
| 5. Distribution | 19 | Needs a paid Apple account; your decision |

---

## A. Everyday features

### 1. Frequent folders in the palette — S

**Now:** `recentFolders` keeps 12 items (`appdata.ts:41`), newest first.
A folder visited daily falls off after 12 other visits.

**Change:**
- `types.ts`: add `visits?: number` to `RecentItem`.
- `appdata.ts`: `withRecent` carries `visits + 1` forward. Raise
  `MAX_RECENT_FOLDERS` to 200 for storage; Home keeps showing the newest 12
  (slice at the call site in `HomeView.tsx`).
- `CommandPalette.tsx:116`: add a bonus to folder scores,
  `Math.min(12, Math.log2(visits + 1) * 3)`, halved when `ts` is over 30
  days old. With an empty query, list the top 8 by that bonus.
- Validation of the persisted blob (`appdata.ts:144`) must accept items
  without `visits`.

**Test:** `appdata.test.ts`: a revisit raises `visits` and keeps one entry;
an old store without `visits` loads. `palette.test.ts`: a frequent folder
outranks an equal text match.

### 2. Paste clipboard content as a file — M

**Now:** `paste()` returns when the pasteboard holds no file URLs
(`actions.ts:528`).

**Change:**
- `clipboard.rs`: new command `clipboard_paste_data(dest: String) ->
  Result<Option<Step>, String>`. Read `NSPasteboardTypePNG`; else
  `NSPasteboardTypeTIFF` converted to PNG with the ImageIO code already in
  `imgedit.rs`; else `NSPasteboardTypeString`. Write with
  `OpenOptions::create_new` to a unique name from `copy_candidate`
  (`fsops.rs:496`): `Pasted Image 2026-11-09 at 14.03.png` or
  `Pasted Text ….txt`. Return `Step::trash(path)` as the inverse.
- Cap the size (say 200 MB) and return an error above it.
- `ipc.ts`: wrapper. `actions.ts`: where `board.paths.length === 0`, call
  it, then reuse `created(...)` so the new file is selected and enters
  rename.
- Needs `NSData` (already enabled) and the two pasteboard type constants.

**Test:** Rust test for naming and no-overwrite with the pasteboard read
stubbed behind a function that takes bytes. Manual: copy a screenshot region,
⌘V in a folder.

**Limit to document:** text is saved as UTF-8; rich text loses formatting.

### 3. New Folder with Selection, Move to… and Copy to… — M

**New Folder with Selection** (`⌃⌘N`, as Finder):
- `actions.ts`: `newFolderWithSelection()`: `api.createDir(parent)` returns
  the create `Step`; then `api.movePaths(selection, newDir, {}, id, on)`;
  record both inverses as **one** history entry, move first then create, so
  one Undo puts everything back and removes the folder. Then start rename on
  the new folder.
- Add to the item context menu when two or more items are selected.

**Move to… / Copy to…:**
- `Dialogs.tsx`: one small dialog, `mode: "move" | "copy"`. An input that
  reuses `splitDraft` and `rankNames` from `util/pathComplete.ts` (the
  address bar already does this at `AddressBar.tsx:54`), with favorites and
  frequent folders (item 1) listed below it when the input is empty.
- On confirm call the existing `transfer(mode, paths, dest)`
  (`actions.ts:457`). Conflicts, progress and Undo come for free.
- `stores/ui.ts`: `openMoveTo(paths, mode)` and an `ActiveModal` entry.

**Test:** `actions.test.ts`: one Undo after New Folder with Selection
restores every item and removes the folder. Visual test for the dialog.

### 4. Select by pattern and invert selection — S

- `util/itemFilter.ts`: `globToRegExp(pattern)` supporting `*`, `?` and
  comma-separated alternatives, case-insensitive. Test beside it.
- `actions.ts`, next to `selectAll` (line 1418):
  `invertSelection()` and `selectMatching(pattern)`, both over
  `getViewEntries()` so they respect the current filter and search.
- A one-field dialog for the pattern showing a live match count.
- Shortcuts to propose: `⌘⇧I` invert, `⌘⇧S` select by pattern. Check
  `useShortcuts.ts` and `menu.rs` for clashes before settling.

### 5. Look inside archives without extracting — M

**Now:** `archive.rs` only extracts. It already lists entries internally to
check for path escapes (`lists_escaping_entries`, line 223) and already
parses `tar -tvf` output (`parse_tar_listing`, line 284).

**Change:**
- `archive.rs`: `archive_list(path) -> Vec<ArchiveEntry { path, size,
  is_dir, modified_ms }>`. Zip through the `zip` crate that is already a
  dependency (central directory only, nothing decompressed); the other
  formats through the existing `tar -tvf` parsing. Cap at 50,000 entries
  and report truncation.
- UI, smallest version: reuse the **Folder tree** side panel
  (`FolderTree.tsx`, rows from `util/folderTree.ts`). Give it a second data
  source so "Show contents" on an archive opens the same tree, read-only,
  with sizes and the search box. Footer button: **Extract here**.
- Context menu: "Show contents" beside "Extract here"
  (`FolderView.tsx:705`). Also show the tree in the Preview bar for
  archives.

**Left out on purpose:** extracting a single entry, and browsing an archive
as a folder in the listing. Add `archive_extract_entries` later if asked.

**Test:** Rust: lists a zip and a tar.gz built in the test; an entry named
`../x` is listed as text and never touches disk.

### 6. Shortcut hints and type-ahead in the context menu — S

See item 12; listed here because it is the cheapest daily improvement.

### 7. Pause and resume for copy and move jobs — M

**Now:** `Job` has a cancel flag only. The copy loop calls back into
`on_status` (`fsops.rs:1881`) for every progress tick.

**Change:**
- `jobs.rs`: add `paused: AtomicBool` to `Job` and
  `fn wait_while_paused(&self)`: loop with a 100 ms sleep while paused and
  not cancelled. New command `pause_job(job_id, paused)` beside
  `cancel_job` (line 263). Add `paused` to `Progress` and emit on change.
- Call `wait_while_paused()` at three points: top of `on_status`, inside
  the fallback read loop (`fsops.rs:1994`), and between items in
  `run_transfer` (line 1094). Blocking inside the `copyfile` callback is
  safe: it runs on the job's own blocking thread.
- `stores/jobs.ts`: `paused` on `JobInfo`; freeze `rate` while paused.
- `Toasts.tsx:117`: a Pause/Resume button before Cancel, and "Paused" in
  the detail line.
- Offer Pause only on transfer jobs. Compress and extract run `ditto` and
  `tar` as child processes; leave those with Cancel only.

**Test:** Rust: a paused job copies no further bytes for 300 ms, then
finishes after resume; cancel while paused ends it. An APFS clone finishes
at once, so the test must copy across a non-clone path (the fallback loop).

### 8. Duplicate files in Disk usage — L

- New `src-tauri/src/dupes.rs`: `find_duplicates(root, min_size, job)`.
  Three passes: group by size; hash the first 64 KB of each candidate; full
  SHA-256 of the survivors, using `read_chunks` from `props.rs:122` and the
  `sha2` crate already present. Skip symlinks, and count hard links once by
  `(dev, ino)` as `count_file` does (`props.rs:233`). Default `min_size`
  1 MB. Cancellable, with progress through the job channel.
- `DiskView.tsx`: a fourth collapsible card, "Duplicate files", run on
  demand with a button (it reads a lot of data). Groups sorted by wasted
  bytes; rows reuse the "Largest files" row with Reveal and Trash.
- Guard: the UI never lets every copy in a group be selected for Trash.
  Trash goes through `trash_paths`, so Undo and Put Back apply.

**Limit to document:** APFS clones look like duplicates but share storage,
so trashing one frees nothing. Say so in the card and in Help.

**Test:** Rust: three equal files, one hard link and one same-size
different file yield one group of two real copies.

---

## B. Protection against data loss

### 9. Free-space check before a copy — S

**Now:** `fs2::available_space` is used only for the drive list
(`fsops.rs:343`). A copy to a full drive fails part-way.

**Change:** `start_scan` (`jobs.rs:344`) already totals the bytes on a
background thread. When it finishes, if source and destination are on
different volumes (`on_same_volume`, `fsops.rs:1140`) and the total exceeds
free space, cancel the job with the error "Not enough space on "X": needs
12.4 GB, 3.1 GB free". Same-volume copies are APFS clones and take no
space, so skip the check there.

**Test:** unit-test the decision as a pure function `(total, free,
same_volume) -> Option<String>`.

### 10. Optional checksum verification — M

**Now:** `copy_verified` (`fsops.rs:1807`) compares item counts and byte
totals, and only for moves.

**Change:**
- Setting "Verify copies to other drives", off by default
  (`stores/settings.ts`), passed with the transfer call.
- When on and the copy crossed volumes: after each file, SHA-256 both
  sides with `read_chunks`. On mismatch remove the bad copy, keep the
  original, and report "the copy of "X" didn't match, so the original was
  kept".
- Progress: add a second phase so the job title reads "Verifying…".

**Cost to document:** roughly doubles the time, which is why it is opt-in.

**Test:** Rust: flip one byte in the destination between copy and verify
through a test hook; the move must keep the original.

### 11. Keep the Mac awake during long jobs — S

- `jobs.rs`: hold an activity token in `JobGuard` for jobs created with
  `begin` (line 244), released in `Drop` (line 198):
  `NSProcessInfo::beginActivityWithOptions_reason` with
  `UserInitiated | IdleSystemSleepDisabled`. Needs the `NSProcessInfo`
  feature of `objc2-foundation`; no new crate.
- This stops idle sleep only. Closing the lid still sleeps; say so in Help.

**Test:** manual: `pmset -g assertions` shows the assertion during a large
copy and not after.

---

## C. Context menu

### 12. Four changes — S

- **Shortcut hints.** Add `keys?: string` to `MenuItemSpec`
  (`stores/ui.ts:13`); render `<span className="ctx-keys">` after the label
  in `ContextMenu.tsx:281`. Do not retype the keys: export a lookup from
  `PALETTE_COMMANDS` by id and fill `keys` from it in `FolderView.tsx`.
  Style in `global.css` beside `.ctx-label` (line 3577): muted, right
  aligned, tabular.
- **Type-ahead.** In `onMenuKeyDown` and `onSubKeyDown`, a single printable
  key focuses the next enabled item whose label starts with it, wrapping.
  About ten lines beside `moveFocus`.
- **Delete placement.** In the icon row (`FolderView.tsx:564`) move Delete
  to the end, after a thin separator, with the danger color on hover. Order
  becomes Cut, Copy, Rename, Share | Delete.
- **Shorter menu.** Fold "Copy as path" and "Copy name" into a "Copy"
  submenu; put "Move to…", "Copy to…" (item 3) and "Show contents" (item 5)
  in the existing groups rather than adding dividers.

**Test:** the existing visual tests cover the menu; add one snapshot with
hints. Keyboard: type "p" on a file menu and Properties takes focus.

---

## D. Stability

### 13. Error boundaries — S

**Now:** none. `uiErrors.ts` logs unhandled errors, but a render fault
unmounts the whole React tree and leaves a blank window.

**Change:**
- New `components/PaneBoundary.tsx`: a class component with
  `componentDidCatch` calling `logUiError("render", err)`. Fallback: the
  error summary from `describeError`, a "Reload this tab" button that
  resets the boundary, and "Copy diagnostic info".
- Wrap each branch `ContentArea.tsx` returns (lines 159 to 187), keyed by
  tab id and location so navigating away clears the fault. Wrap
  `PreviewPane` and `NavPane` separately in `App.tsx:68`.
- Wrap the roots of the viewer windows too: `readerMain.tsx`,
  `viewerMain.tsx`, `pdfMain.tsx`, `videoMain.tsx`.

**Test:** a component that throws inside the boundary renders the fallback
and logs once.

### 14. Content search where Spotlight is off — M, optional

`search.rs:165` detects volumes with Spotlight disabled and falls back to
`run_scan`, which matches names only. If people search external or network
drives by content, add a bounded scan: text-like extensions only (reuse
`code_lang` and the text check in `reader.rs:376`), files under 5 MB,
stop at the existing result cap. Otherwise show "Contents can't be searched
on this drive" so the miss is not silent. Do the message first; it is S.

### 15. Split the two largest files — M, no behavior change

- `src-tauri/src/fsops.rs` (2,864 lines) into a `fsops/` module:
  `list.rs` (listing, `build_entry`, volumes), `transfer.rs` (copy, move,
  conflicts, `run_transfer`), `copy.rs` (`macos_copy`, `copy_verified`,
  partial journals), `steps.rs` (undo steps, rename, create), `delete.rs`
  (trash, permanent delete), `terminal.rs`. Re-export from `mod.rs` so the
  command names registered in `main.rs` do not change.
- `src/components/ImageViewer.tsx` (1,431 lines): pull the crop and
  transform tools into their own files when next editing it. Not urgent.
- Pure moves, one commit, tests unchanged and passing.

---

## E. Design and motion

### 16. Motion touches — S each

All use the tokens in `util/motion.ts` and must be disabled under
`prefers-reduced-motion`.

- **Arrival highlight.** `transfer()` already computes the arrived paths
  (`arrived()`, `actions.ts:447`) and calls `markFlying`. After the job,
  add an `arrived` class to those rows for `--dur-long`: an accent
  background that fades out. One CSS rule covering `.drow`, `.gtile` and
  `.crow`.
- **Drop settle.** On drop, a one-shot scale 1 → 1.04 → 1 with `SPRING` on
  the icon of the target that had `.drop-hover` (`global.css:1559`).
- **Progress on the destination.** Add `dest` to `JobInfo`
  (`stores/jobs.ts`); in `FileIcon.tsx` draw a small ring over a folder
  whose path equals a running job's `dest`, and on its tab. Skip if it
  crowds the icon at the smallest size.

### 17. A Tools group in the navigation pane — S

`NavPane.tsx:96` has sections quick, drives, network, cloud, favorites and
searches. Add `"tools"` and move Disk usage, Git repositories, Agent skills
and the uninstaller entry points into one collapsible `NavSection`,
collapsed state stored with the others through `toggleSection`. I did not
trace where each tool is opened from today; find those entry points first.

### 18. Softer, more Mac-like chrome — M, subjective

Do this by eye, with the visual tests (`*.visual.tsx`) as the safety net.
Candidates: one radius scale in `global.css` instead of the mixed 4, 6 and
9 px values; dialog buttons in macOS order and size; title bar spacing
around the traffic lights. Change tokens, not components. Review
before-and-after screenshots before committing, since this is taste.

---

## F. Distribution

### 19. Sign and notarize — M, needs your decision

**Now:** ad-hoc signed (`tauri.conf.json:82`), so the README walks users
through "Open Anyway" or `xattr -cr`. Each rebuild also changes the code
identity, so macOS forgets Files and Folders grants (noted in
REFERENCE.md).

**Needs:** Apple Developer Program membership (paid yearly) and a
Developer ID Application certificate.

**Change:**
- `release.yml`: import the certificate from repository secrets into a
  temporary keychain; set the signing identity from the environment so
  local builds stay ad-hoc; after the DMG is built run
  `xcrun notarytool submit --wait` and `xcrun stapler staple`; verify with
  `spctl -a -vv`. Put the secrets on the existing `release` environment
  with required reviewers.
- `scripts/build-dmg.sh`: keep the ad-hoc path as the default.
- Notarization talks to Apple from CI only. The app stays offline.
- README: the six install steps become two; remove the `xattr` route.

**Risk:** the hardened runtime under a real identity may need entitlements
the ad-hoc build got away without (the app uses `macos-private-api` and
WebKit). Test a notarized build on a clean Mac before publishing.

**Updates:** with no network there is no update check, so fixes do not
reach users. A zero-network nudge: compare the build date baked in at
compile time with today, and after six months show "This version is from
May 2026" in About and Help with the existing releases link.

---

## Not planned

- Browsing archives as folders in the main listing (item 5 covers the need).
- Pausing compress and extract jobs (child processes).
- Any feature needing a network connection.
