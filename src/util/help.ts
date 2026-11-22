/**
 * The Help page (Settings → Help, Help → Doftar Help, ⌘K "Help").
 * How each feature behaves, the best way to use it, and what it won't do.
 * Every number here comes from the code. Change both together.
 */
import { ON_LINUX, keys, os } from "./platform";

export interface HelpTopic {
  title: string;
  points: string[];
  tip?: string;
  limits?: string[];
}

/** Items only the macOS app has. */
const macOnly = <T>(items: T[]): T[] => (ON_LINUX ? [] : items);

/** Written with macOS keys; `HELP` shows them in this system's form. */
const PAGES: { title: string; topics: HelpTopic[] }[] = [
  {
    title: "Moving and copying",
    topics: [
      {
        title: "Copy, cut and paste",
        points: [
          "Cut doesn't touch your files. They move only when you paste.",
          ...macOnly(["The clipboard is shared with Finder both ways. Files cut in Finder arrive as a copy, because Finder doesn't share its cut."]),
          "If you copy anything else before pasting, the cut becomes a copy.",
          "After a paste, items that were skipped or failed stay on the clipboard, so you can paste them again.",
          "Copying into the same folder makes “name_copy_1”, and so does Duplicate (⌘D). Cut and paste into the same folder does nothing.",
          "⌘⌥V moves the clipboard items here, even after a copy. ⌘⇧V opens Activity, with the last 20 things you copied this session.",
          ...macOnly(["With no files on the clipboard, Paste saves a copied image or text as a new file here: “Pasted Image <date>.png” or “Pasted Text <date>.txt”."]),
          "Move to… and Copy to… on the right-click menu send the selection to a folder you type or pick. Tab completes the path.",
          "New Folder with Selection (⌃⌘N) makes a folder and moves the selected items into it. One Undo puts them back.",
        ],
        tip: "Cut, then paste straight away.",
        limits: os(
          ["A pasted image is saved as PNG, or as TIFF when the app that copied it offers only that. Pasted text is plain UTF-8.", "A clipboard of more than 200 MB isn't saved."],
          ["Paste takes files only. A copied image or text isn't saved as a new file."]
        ),
      },
      {
        title: "Same drive or another drive",
        points: [
          os("On the same drive, a move is instant. Copies on APFS drives are instant too and take no extra space until one side changes.", "On the same drive, a move is instant. A copy always writes every byte, even on the same drive."),
          "To another drive, Doftar copies, checks every item and byte arrived, and only then deletes the original. If the original changed meanwhile, both are kept and you're told.",
          os("Copies keep tags, permissions, extended attributes and the “downloaded from the internet” mark. Symlinks are copied as links.", "Copies keep permissions, modification times and extended attributes. Symlinks are copied as links."),
          "Before copying to another drive, Doftar adds up the sizes. If the drive is too full it stops and tells you how much is missing.",
          "File → Verify Copies to Other Drives reads both sides again after each copy or move and compares their SHA-256. A copy that differs is removed and the original stays.",
        ],
        limits: [os("Verifying takes about twice as long, so it is off until you turn it on. It doesn't run on the same drive, where a copy shares the original's data.", "Verifying takes about twice as long, so it is off until you turn it on. It doesn't run for copies on the same drive.")],
      },
      {
        title: "When a name is taken",
        points: [
          "You choose Replace, Skip or Keep both, for one item or all of them. Keep both is the default and names the new item “name_copy_1”.",
          "Replace moves the old item to the Trash after the new one is in place, so Undo can bring it back.",
          "A file never replaces a folder, or the other way round.",
        ],
      },
      {
        title: "Drag and drop",
        points: [
          os("Dragging moves on the same drive and copies to another drive. Hold Option to copy instead.", "Dragging moves on the same drive and copies to another drive. Hold Alt to copy instead."),
          "Moving folders by dragging asks first.",
          "Hold over a tab or folder for a moment to open it while you drag.",
          "Drop on Trash to delete, or drop a folder on Favorites to pin it.",
          "Dragging to or from another app always copies.",
        ],
      },
      {
        title: "Progress and Cancel",
        points: [
          "Each copy or move runs on its own and shows its progress, speed and time left. The folder it fills shows a small ring on its icon.",
          "Pause holds a copy or move between files, or partway through a large one. Resume carries on from there.",
          os("The Mac doesn't go to sleep by itself while a job runs. Closing the lid still sleeps it.", "Long jobs don't keep the computer awake; its normal sleep settings still apply."),
          "Cancel stops between items and removes the half-copied one. What finished stays, and the Undo button removes it.",
          "Quitting cancels running copies. After a crash, half-copied items are removed the next time Doftar opens.",
        ],
        limits: ["Compress and Extract can be cancelled but not paused."],
      },
      {
        title: "Archives",
        points: [
          "Compress makes a ZIP next to the first selected item.",
          "Show contents lists what an archive holds, with sizes and a search, without extracting it.",
          "Extract opens zip, tar (gz, bz2, xz), 7-Zip, RAR, ISO, CAB, XAR, CPIO and LZH. A single item lands beside the archive. Several go into a folder named after it.",
          ...macOnly(["Files from a downloaded archive keep the “downloaded” mark, so macOS still checks any app inside."]),
          "Archives that try to write outside their folder, through links, or far more than they declare are stopped.",
        ],
        limits: ["ZIP is the only format Doftar makes, without a password.", "Password-protected archives aren't supported.", "Show contents lists the first 50,000 entries. One file can't be extracted on its own."],
      },
    ],
  },
  {
    title: "Deleting, Trash and Undo",
    topics: [
      {
        title: "Trash or delete",
        points: [
          "⌘⌫ moves items to the Trash. It asks first for 100 or more items, or anything in a cloud drive, where deleting removes it on every device.",
          "Delete immediately (⌘⌥⌫) can't be undone. Deleting inside the Trash is always permanent.",
          "Network drives have no Trash, so Doftar offers to delete immediately instead.",
          "Deleting a Git repository permanently asks a second time.",
          "Empty Trash empties your Trash and the Trash on every connected drive.",
        ],
      },
      {
        title: "Put Back",
        points: [
          "Items return to the folder they came from. If that folder is gone, Doftar offers to make it again.",
          "Put Back stops for an item whose name is taken where it would go.",
          os("If Doftar did not record where an item came from, it offers to show the item in Finder.", "If Doftar did not record where an item came from, it can only show the item in the Trash."),
        ],
      },
      {
        title: "Undo and Redo",
        points: [
          "Undo remembers the last 50 operations, even after a restart. Redo is lost when Doftar quits.",
          "⌘Z tells you what it will do before doing it. The Undo button on a notice doesn't ask.",
          "Undoing a copy or a new item moves it to the Trash. Undo never deletes.",
          "Items that were moved, replaced or deleted since are skipped, and Undo says which.",
          "All windows share one Undo history.",
        ],
        limits: ["Delete immediately and Empty Trash can't be undone."],
      },
      {
        title: "Protected folders",
        points: [
          os("Doftar never moves, renames or deletes system folders, drives themselves, your home folder, or its standard folders: Desktop, Documents, Downloads, Library, Movies, Music, Pictures and Public.", "Doftar never moves, renames or deletes system folders, drives themselves, your home folder, or its standard folders: Desktop, Documents, Downloads, Music, Pictures, Public, Templates, Videos, snap, .config, .local, .ssh and .gnupg."),
          "You can still copy from them, and change what's inside your own folders.",
        ],
      },
    ],
  },
  {
    title: "Renaming",
    topics: [
      {
        title: "Rename",
        points: [
          "F2 renames. Spaces at either end are removed, and changing only the case works.",
          "Names can't contain / or :, or be longer than 255 bytes.",
          "Rename never replaces an item that already has the name.",
        ],
      },
      {
        title: "Batch rename",
        points: [
          "Select several items and press F2. Replace text (or a regular expression, with $1 for groups), add text before or after, number them, or change the case.",
          "Numbering takes {n}, {name}, {date}, {folder}, {camera}, {res} and {fps}. {n} is padded with zeros to the same width.",
          "The extension stays as it is. .tar.gz and the like count as one.",
          "The preview shows every new name before you rename. One Undo reverts the whole batch.",
          "Selected items can take each other's names, so a swap or a shift of numbers works. An item steps aside under a hidden temporary name first.",
        ],
        limits: [
          "Two items can't end up with the same name.",
          "Items are renamed one at a time. If some fail, the rest are still renamed and the failures are listed.",
        ],
      },
    ],
  },
  {
    title: "Split view, tabs and windows",
    topics: [
      {
        title: "Split view",
        points: [
          "⌘\\ shows two folders side by side. The new side starts as a copy of the current tab, history included.",
          "If the screen has room, the window grows to make room for the new side, and shrinks back when split view closes. If not, the window stays the same and the two sides share it.",
          "Esc closes split view and keeps the side you are on. If a cut is waiting, the first Esc cancels the cut.",
          "Each side has its own tabs and search. The window has one preview bar, at its right edge. While it's open, the right side's navigation pane is hidden. It comes back when you close the bar.",
          "Paste, new tabs, search and menu commands go to the side you last clicked. F6 moves to the other side.",
          "Drag between the sides to move or copy. Closing the last tab on one side closes that side.",
        ],
      },
      {
        title: "Tabs and windows",
        points: [
          "Each tab has its own Back and Forward, and remembers the scroll, selection and filters of every step.",
          "A sideways two-finger swipe over the files goes Back and Forward, as the mouse side buttons do. An arrow shows where it goes. A list that scrolls sideways keeps the swipe. Settings → Files turns the swipe off.",
          "Drag a tab to the other side, onto another window's tab strip, or out to open it in a new window.",
          "Closing the last tab of the main window opens Home instead. ⌘⇧T reopens closed tabs, newest first, with their history.",
          "Right-click a tab to close the other tabs, or the tabs to its right. ⌃Tab and ⌃⇧Tab, or ⌘⇧] and ⌘⇧[, move between tabs.",
          "⌘N opens a new window on Home.",
          os("A folder from outside opens in a new tab of the main window: drop it on the Dock icon, or run open -a Doftar with the folder in Terminal. In Finder, right-click an item and choose Services, then Reveal in Doftar, to show it in its folder.", "A folder path passed on the command line opens in a new tab of the main window."),
          "The main window's tabs and size come back at the next launch. It always opens in one pane, with both sides' tabs if you quit in split view. Tabs whose folder is gone or in the Trash are left out.",
          "Settings, favorites, recents, the clipboard and Undo are shared by all windows.",
          "View, sort, grouping, icon size and list column widths are remembered for each folder.",
        ],
        limits: [
          "Only the last 25 closed tabs of a window can be reopened, and none after Doftar quits. Tabs of other windows aren't restored at launch.",
          "A tab dragged to another place keeps its history and selection, not its search or filters.",
        ],
      },
    ],
  },
  {
    title: os("Preview bar and Quick Look", "Preview bar"),
    topics: [
      {
        title: "Preview bar",
        points: [
          "⇧⌘P turns the preview bar on. While it's on, double-click or Enter shows a file beside the list instead of opening it. Folders still open.",
          os("Text, code, Markdown and data files show in the reader. JSON shows as a tree. Video and audio play. Everything else shows a Quick Look picture.", "Text, code, Markdown and data files show in the reader. JSON shows as a tree. Video and audio play."),
          os("Pinch, ⌘-scroll or use the buttons that appear under the pointer to zoom text, pictures and PDFs. Scroll a PDF to read all of its pages.", "Pinch, ⌘-scroll or use the buttons that appear under the pointer to zoom text and pictures."),
          os("Pull the drawer up for dates, size on disk, the default app and where a file was downloaded from.", "Pull the drawer up for dates, size on disk and the default app."),
          "The preview follows changes to the file. The preview bar and the folder tree share the space, so opening one closes the other.",
          "Drag its edge to resize it. Double-click the edge to reset.",
        ],
        limits: ["Text files over 8 MB aren't shown.", ...macOnly(["Files only in the cloud are downloaded before they show.", "PDFs with a password show one picture. Open the PDF to read or select its text."])],
      },
      ...macOnly([
        {
          title: "Quick Look",
          points: [
            "Tap Space to open or close Quick Look. Hold Space to peek, and let go to close.",
            "It shows up to 50 selected items.",
          ],
        },
      ]),
    ],
  },
  {
    title: "Compare",
    topics: [
      {
        title: "Compare folders",
        points: [
          "In split view, right-click empty space or use ⌘K. Both sides must show different folders, with no search or filter.",
          "Doftar selects, on each side, what the other side lacks or has an older copy of, then offers to copy it across.",
          "Names match without regard to case. “Older” means modified earlier, with 2 seconds to spare for drives that round times.",
        ],
        tip: "Compare the top level, then open a folder on both sides and compare again.",
        limits: [
          "Only one level is compared. A folder on both sides counts as the same, whatever is inside.",
          "Sizes and contents aren't compared, only names and dates.",
          "Hidden files count only while they're shown.",
        ],
      },
      {
        title: "Compare files",
        points: [
          "Select two text, code, Markdown or Word files and click Compare. Lines only one has are marked, the way Git shows them.",
          "Word files compare their text with tracked changes accepted. Formatting and comments are left out.",
          "Edit opens either side. The comparison updates when either file changes.",
        ],
        limits: ["Files up to 8 MB. Large, very different files take a while."],
      },
      {
        title: "Compare data",
        points: [
          "Select two tables (CSV, TSV, JSON Lines, Parquet or Arrow, in any mix) or two AnnData files.",
          "Columns match by name, and type changes are flagged. Rows match by an ID column Doftar picks, which you can change, or by the whole row.",
          "AnnData compares shapes, X, every key, and the obs and var tables.",
        ],
        limits: ["The first 10,000 rows of a table are compared, and 1,000 of obs and var. Up to 500 changed rows are listed."],
      },
    ],
  },
  {
    title: "Search and filter",
    topics: [
      {
        title: "Search",
        points: [
          "Typing in the search box filters the open folder as you type.",
          os("Press Enter to search every folder inside it. Doftar asks Spotlight first, and looks through the folders itself where Spotlight has no index.", "Press Enter to search every folder inside it. Doftar looks through the folders itself."),
          "Search matches names. Turn on Contents to also match words inside files. Doftar then searches subfolders too.",
          os("Hidden items are skipped unless shown. Apps and symlinked folders aren't searched inside.", "Hidden items are skipped unless shown. Symlinked folders aren't searched inside."),
          "Kind and date filters narrow a search too. Documents means PDFs, Office files and text. Today means since midnight.",
          "The star beside Subfolders saves the search in the sidebar under Searches. Clicking it runs the search again.",
        ],
        tip: "For a common name, search a smaller folder or add a kind filter.",
        limits: [
          "Up to 5,000 results.",
          ...macOnly(["Contents covers only text Spotlight has indexed, and matches the start of words. Where Spotlight has no index, only names match."]),
          os("Without Spotlight, the search stops after 400,000 items or 20 seconds.", "The search stops after 400,000 items or 20 seconds."),
        ],
      },
      {
        title: "Selecting",
        points: [
          "Select by Pattern (⌘⇧S, or the * button next to the command palette button) selects the shown items whose names match. * is any text, ? is one character, and commas separate patterns: *.csv, report-??.",
          "A pattern with no * or ? matches names that contain it. Letter case doesn't matter.",
          "Invert Selection (⌘⇧I) selects everything shown that isn't selected.",
        ],
        limits: ["Both act on what the folder shows, so a filter or search narrows them."],
      },
      {
        title: os("Tags and Screenshots", "Screenshots"),
        points: [
          ...macOnly(["The Tags page asks Spotlight for every tagged file on the Mac."]),
          "The Screenshots page lists images named “Screenshot…” in your home folder.",
        ],
        limits: [
          ...macOnly(["Drives Spotlight doesn't index are left out of the Tags page."]),
          "Renamed screenshots, or ones saved outside your home folder, aren't listed.",
        ],
      },
    ],
  },
  {
    title: "Address bar and terminal",
    topics: [
      {
        title: "Typing in the address bar",
        points: [
          "Click the empty part of the path to type. Anything starting with ~, /, . or .. is a place: a folder opens, a file is shown in its folder.",
          "Folder names complete as you type. Tab finishes the name, or the part the matches share. ↑ and ↓ pick one, Enter goes there.",
          "⌘K also takes a path starting with ~ or /, and lists open tabs and recent files.",
          "A name of a folder here opens it. Anything else runs as a command in your terminal, in this folder.",
          "Commands with spaces or special characters ask before running.",
          "code ., cursor ., zed ., warp . and similar open the app straight away.",
          "Terminals that can't take a command open in the folder, with the command on the clipboard to paste.",
        ],
        tip: os("The first time, macOS may ask to let Doftar control your terminal. Allow it.", undefined),
      },
    ],
  },
  {
    title: "Viewers and editing",
    topics: [
      {
        title: "Images",
        points: [
          "Rotate, flip and crop. Save replaces the file. Save as copy writes “name (edited)” beside it.",
          os("Rotating or flipping a JPEG, HEIC or TIFF without cropping is lossless. Other edits save again, which costs JPEG and HEIC a little quality.", "Every edit saves the image again, which costs a JPEG a little quality."),
          ...macOnly(["Photo details such as camera and location are kept."]),
        ],
        limits: [
          os("Saves JPEG, PNG, TIFF, HEIC, BMP and GIF, but not animated or multi-page images.", "Saves JPEG, PNG, TIFF, BMP and GIF, but not animated images. HEIC and HEIF can't be edited."),
          ...(ON_LINUX ? ["Photo details such as camera and location aren't kept in the saved image."] : []),
          "A file changed by another app since you opened it isn't saved over.",
        ],
      },
      {
        title: "PDF, Markdown, video and audio",
        points: [
          os("PDFs: search, two pages side by side, thumbnails and passwords. Use Open in Preview to edit.", "PDFs: search, two pages side by side, thumbnails and passwords. Use Open in default app to edit."),
          "Markdown: tables, footnotes, task lists and math. HTML in a document shows as text and never runs.",
          "Video plays MP4, M4V, MOV and WebM.",
          "Audio plays MP3, M4A, AAC, WAV, FLAC and AIFF, then the next track in the folder.",
        ],
        limits: ["MKV, AVI, OGG and Opus don't play in Doftar. Use Open with."],
      },
      {
        title: "Text editor",
        points: [
          "The editor keeps a file's encoding (UTF-8, with or without BOM, or UTF-16) and its line endings. The status bar shows both.",
          "Saving writes a new copy, then swaps it in. If saving fails, the file is left as it was.",
          "If another app changed the file, you choose to load theirs or keep yours. Without edits, the new version just appears.",
          "Doftar asks before closing a file with unsaved changes.",
        ],
        limits: ["Files up to 8 MB.", "Only UTF-8 and UTF-16 text can be edited."],
      },
    ],
  },
  {
    title: "Data files",
    topics: [
      {
        title: "Tables and spreadsheets",
        points: [
          "CSV, TSV, JSON Lines, Parquet and Arrow open as a table. Click a column to sort. Each column shows its range and missing values.",
          "The separator is guessed and the first row is the header.",
          "Excel and OpenDocument sheets open from Preview in Doftar on the right-click menu, with the values last calculated.",
          "SQLite databases show every table and view, opened read-only.",
        ],
        tip: "Use Doftar for a quick look. For work on the whole dataset, use Python.",
        limits: [
          "The first 10,000 rows load. Sorting and column statistics cover those rows only.",
          "Spreadsheets show values, not formulas. Password-protected spreadsheets don't open.",
        ],
      },
      {
        title: "Science and machine learning files",
        points: [
          "AnnData and HDF5 show their structure, shapes and attributes, and opening them doesn't lock the file, so a notebook can keep using it.",
          "NumPy files show their shape, type and first rows. Object arrays are never loaded, because loading them could run code.",
          "Notebooks show code, text and saved outputs. Nothing in them runs.",
          "Model weights (.safetensors, .gguf) show tensors, metadata, parameter count and quantisation, from the header alone.",
        ],
        limits: [
          "HDF5 values aren't shown, and obs and var show 1,000 rows.",
          "NumPy shows 10,000 rows and 200 columns.",
          ".pt, .bin and .ckpt weights aren't supported.",
        ],
      },
    ],
  },
  {
    title: "Tools",
    topics: [
      {
        title: "Folder tree and Properties",
        points: [
          "The folder tree (⌘⇧E) lists everything inside a folder with sizes, largest first. Its search opens the folders leading to each match.",
          "Properties (⌘I) shows size, size on disk and everything a file says about itself. Checksums are calculated when you ask, with a box to check one you pasted.",
          "Folder sizes count hard links once, don't follow links, and stay on one drive.",
          "Up to 10 selected folders are measured for the status bar too, once the selection stops changing. It also shows the free space on the drive.",
          os("Right-click the list header to show Date created and Tags, or hide columns. Drag a header edge to resize. Double-click it to reset.", "Right-click the list header to show Date created, or hide columns. Drag a header edge to resize. Double-click it to reset."),
          "View → Show/Hide Item Info puts each file's size under its name in the Icons view.",
        ],
        limits: ["The folder tree lists up to 400 items per folder.", "Properties for several items shows their size only."],
      },
      {
        title: "Disk usage",
        points: [
          "Shows what fills your home folder as a map, plus developer folders, AI model caches and the 100 largest files.",
          "Cloud folders are skipped. Sizes are the space used on disk.",
          "Delete offers the Trash or deleting permanently. For Conda environments it copies the command that removes them.",
          "The last report stays until you scan again.",
          "Duplicate files compares the content of files of 1 MB and more in your home folder, when you ask. One copy of each file always stays; the rest can go to the Trash.",
          "Git worktrees lists the linked worktrees the scan finds, with their repository, branch and size. Open the card to see uncommitted changes and commits that no other branch has.",
          "Move to Trash checks a worktree again first. If it has uncommitted changes, or commits on no branch, Doftar asks before it moves it.",
        ],
        limits: ["A locked worktree can't be moved to the Trash. Unlock it with git worktree unlock first.", os("Duplicates skip hidden items and the insides of apps. A copy made on the same APFS drive shares storage with the original, so removing it may free nothing.", "Duplicates skip hidden items. A copy made with reflinks (on Btrfs or XFS) shares storage with the original, so removing it may free nothing.")],
        tip: os("Give Doftar Full Disk Access in System Settings for a complete picture.", undefined),
      },
      {
        title: "Git",
        points: [
          "Changed files show a badge. The Repos page lists every repository in your home folder with its history.",
          "Doftar never fetches, so “ahead” and “behind” are as of your last fetch.",
          "Switching branch is the only change Doftar makes inside a repository. It refuses during a merge or rebase, with Git LFS, or if your changes would be overwritten.",
        ],
        limits: ["The history shows the last 200 commits.", "Repositories more than 7 folders deep, or in hidden folders, aren't listed."],
      },
      ...macOnly([
        {
          title: "Uninstalling apps",
          points: [
            "Doftar finds what an app left in your Library and lists it before anything is removed. You can remove the app alone.",
            "The app and its leftovers move to the Trash, so you can undo an uninstall.",
          ],
          limits: ["An app the Trash refuses, such as one installed for all users, can only be deleted permanently. Doftar asks first, and macOS may ask for your password."],
        },
      ]),
      {
        title: "Agent skills",
        points: [
          "Lists every SKILL.md across your coding agents. Share links a skill into another agent. Remove moves it to the Trash and warns if other agents link to it.",
        ],
        limits: ["Skills is listed under Tools only when a coding agent's skills folder exists. Doftar looks once, when it starts."],
      },
    ],
  },
  {
    title: "Cloud, network and external drives",
    topics: [
      {
        title: "Cloud drives",
        points: [
          os("iCloud, Dropbox, Google Drive, OneDrive, Box and others are recognised. A mark shows whether a file is on this Mac or only online.", "Dropbox, Google Drive, OneDrive, Box, MEGA and pCloud folders in your home folder are recognised by their names."),
          ...macOnly(["Opening or previewing an online-only file downloads it first."]),
          ...macOnly(["Copying or moving online-only files to another place downloads them first, so the copy has the real content."]),
          "Deleting in a cloud drive asks first, because it deletes on every device.",
        ],
        limits: os(["Cancel waits until the file that is downloading arrives."], ["Doftar can't tell which files are only online. Opening one is left to the sync app."]),
      },
      {
        title: "Network and external drives",
        points: [
          "Network drives have no Trash, so deleting is immediate after you confirm.",
          "Eject drives from the sidebar. Doftar retries while a drive is busy.",
          "Thumbnails on external drives can be turned off in Settings → Privacy.",
        ],
        limits: ["Changes made on a network drive from another computer show when you come back to the window, or press ⌘R."],
      },
      {
        title: "Live refresh",
        points: [
          "The open folder updates by itself when its contents change, and again when you return to the window.",
          "⌘R or F5 refreshes it by hand.",
        ],
      },
    ],
  },
  {
    title: "Privacy and storage",
    topics: [
      {
        title: "Privacy and safety",
        points: [
          "Doftar makes no network connections: no update check, telemetry or crash reports. Check for updates (in the Options menu) opens the latest release in your browser.",
          os("Errors are kept in a log on your Mac. They leave it only if you use Help → Copy Diagnostic Info and paste them somewhere yourself.", "Errors are kept in a log on your computer. They leave it only if you use Help → Copy Diagnostic Info and paste them somewhere yourself."),
          "Opening a script, installer or program always asks first.",
          "Documents, Markdown and notebooks can't run code.",
          os("macOS asks the first time Doftar opens Desktop, Documents, Downloads or a drive. After updating Doftar, you may need to allow it again in System Settings → Privacy & Security.", "If the system denies Doftar access to a folder, it reports that instead of opening it."),
        ],
      },
      {
        title: "What Doftar keeps",
        points: [
          "Settings, favorites, recent folders and files, Undo history, Activity and the last disk report.",
          "A thumbnail cache of up to 256 MB. Thumbnails unused for 14 days are removed.",
          "Clear cache removes thumbnails and viewer files, not settings or history.",
          "The main window's tabs and size, and saved searches.",
          "Clipboard history isn't kept after Doftar quits.",
        ],
      },
    ],
  },
];

export const HELP = PAGES.map((page) => ({
  ...page,
  topics: page.topics.map((t) => ({
    ...t,
    points: t.points.map(keys),
    tip: t.tip && keys(t.tip),
    limits: t.limits?.map(keys),
  })),
}));
