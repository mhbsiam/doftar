import { useEffect, useState } from "react";
import {
  ArrowClockwiseRegular,
  BranchRegular,
  CodeRegular,
  CopyRegular,
  FolderOpenRegular,
  WindowConsoleRegular,
} from "@fluentui/react-icons";
import { WinFolderIcon } from "./FileIcon";
import { RovingListbox, Section } from "./HomeView";
import { RescanButton, ShotsLoading } from "./FolderView";
import { api } from "../ipc";
import { baseName, parentOf, useTabs, usePaneStore } from "../stores/tabs";
import { useAppData } from "../stores/appdata";
import { useUI } from "../stores/ui";
import {
  copyAsPath,
  navigateTo,
  openInEditor,
  openInTerminal,
  refreshSoon,
  setViewEntries,
} from "../actions";
import { formatDate } from "../util/format";
import { useDateFormat } from "../stores/settings";
import type { GitRepo } from "../types";

/** The last scan. Shown at once on the next visit while a new scan runs. */
let cached: GitRepo[] | null = null;

const open = (r: GitRepo) => navigateTo({ kind: "path", path: r.path });

export function ReposView() {
  useDateFormat();
  const tick = useTabs((s) => s.refreshTick);
  const home = useAppData((s) => s.home);
  const [repos, setRepos] = useState(cached);
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setScanning(true);
    setError(null);
    api
      .gitRepos()
      .then((r) => {
        r.sort((a, b) => (b.lastCommit ?? Infinity) - (a.lastCommit ?? Infinity));
        cached = r;
        if (live) setRepos(r);
      })
      .catch((e) => live && setError(String(e)))
      .finally(() => live && setScanning(false));
    return () => {
      live = false;
    };
  }, [tick]);

  const paneTabs = usePaneStore();
  useEffect(() => {
    const s = paneTabs.getState();
    setViewEntries(s.pane, []);
    s.setListingCount(repos?.length ?? 0);
    s.setSelectionBytes(0);
  }, [repos, paneTabs]);

  const openMenu = (x: number, y: number, r: GitRepo) => {
    setSelected(r.path);
    useUI.getState().openContextMenu(x, y, [
      { key: "open", label: "Open", icon: <FolderOpenRegular />, onSelect: () => open(r) },
      { key: "editor", label: "Open in code editor", icon: <CodeRegular />, onSelect: () => openInEditor(r.path) },
      { key: "term", label: "Open in Terminal", icon: <WindowConsoleRegular />, onSelect: () => openInTerminal(r.path) },
      { key: "copy", label: "Copy as path", icon: <CopyRegular />, dividerBefore: true, onSelect: () => copyAsPath([r.path]) },
      { key: "refresh", label: "Refresh", icon: <ArrowClockwiseRegular />, dividerBefore: true, onSelect: () => refreshSoon() },
    ]);
  };

  const loc = (path: string) => {
    const parent = parentOf(path) ?? "";
    return home && (parent === home || parent.startsWith(home + "/")) ? "~" + parent.slice(home.length) : parent;
  };

  const row = (r: GitRepo) => (
    <div
      key={r.path}
      className={`filerow${selected === r.path ? " selected" : ""}`}
      data-prefetch={r.path}
      role="option"
      aria-selected={selected === r.path}
      tabIndex={-1}
      onClick={() => setSelected(r.path)}
      onDoubleClick={() => open(r)}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, r);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") {
          e.preventDefault();
          open(r);
        } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const b = e.currentTarget.getBoundingClientRect();
          openMenu(b.left + 32, b.bottom, r);
        }
      }}
    >
      <span className="ficon">
        <WinFolderIcon path={r.path} size={24} />
      </span>
      <span className="fname" title={r.path}>{baseName(r.path)}</span>
      <span className="fdate">{r.lastCommit === null ? "No commits yet" : formatDate(r.lastCommit * 1000)}</span>
      <span className="floc">{loc(r.path)}</span>
      <span className="fdesc">
        <BranchRegular /> {r.branch}
      </span>
    </div>
  );

  const groups: [string, string, GitRepo[]][] = [
    ["local", "Local only", repos?.filter((r) => r.localOnly) ?? []],
    ["remote", "With a remote", repos?.filter((r) => !r.localOnly) ?? []],
  ];

  return (
    <div
      className="content home repos-page"
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest(".filerow, button")) setSelected(null);
      }}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest(".filerow")) return;
        e.preventDefault();
        useUI.getState().openContextMenu(e.clientX, e.clientY, [
          { key: "refresh", label: "Refresh", icon: <ArrowClockwiseRegular />, onSelect: () => refreshSoon() },
        ]);
      }}
    >
      {!repos?.length ? (
        <div className="empty-state">
          {error ? (
            <p>{error}</p>
          ) : scanning ? (
            <ShotsLoading icon={<BranchRegular />} label="Searching your folders for Git repositories" />
          ) : (
            <>
              <h2>No Git repositories</h2>
              <p className="hint">Folders under your home folder with Git set up show up here.</p>
              <RescanButton busy={false} />
            </>
          )}
        </div>
      ) : (
        [
          <div key="head" className="repo-head" aria-hidden>
            <div className="filerow">
              <span />
              <span>Name</span>
              <span>Commit</span>
              <span>Location</span>
              <span className="fdesc">Branch</span>
            </div>
          </div>,
          ...groups.map(
          ([key, label, list]) =>
            list.length > 0 && (
              <Section
                key={key}
                scope="repos"
                label={key}
                heading={
                  <span className="tag-heading">
                    {label}
                    <span className="dgroup-count">{list.length}</span>
                  </span>
                }
              >
                <RovingListbox label={label}>{list.map(row)}</RovingListbox>
              </Section>
            )
          ),
        ]
      )}
    </div>
  );
}
