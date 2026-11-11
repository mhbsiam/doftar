import { useEffect, useMemo, useState } from "react";
import {
  Button,
  createPresenceComponent,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Tab,
  TabList,
} from "@fluentui/react-components";
import { BranchRegular, CheckmarkRegular } from "@fluentui/react-icons";
import { api } from "../ipc";
import { useTabs } from "../stores/tabs";
import { useUI } from "../stores/ui";
import { useFolderSize } from "../hooks/useFolderSize";
import { formatDate, formatSize, basename } from "../util/format";
import { layoutGraph, type GraphRow } from "../util/gitGraph";
import { EASE, EASE_IN, SPRING, dur } from "../util/motion";
import type { GitInfo, GitOverview, GitWorktree } from "../types";

type Section = "commits" | "branches" | "worktrees" | "stashes";

const ROW_H = 28;
const LANE_W = 12;
const MAX_LANES = 8;
const LANE_COLORS = ["#3b82f6", "#e0823d", "#22a06b", "#c05bd6", "#d64545", "#2bb3c0"];
const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];

const rtf = new Intl.RelativeTimeFormat([], { numeric: "auto" });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];
function ago(seconds: number): string {
  const diff = seconds - Date.now() / 1000;
  for (const [unit, size] of STEPS) {
    if (Math.abs(diff) >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return "just now";
}

// Fluent animates only in. This also animates out on close.
// "accumulate" adds to the transform that the positioning engine sets.
const PanelMotion = createPresenceComponent(() => ({
  enter: [
    { keyframes: [{ opacity: 0 }, { opacity: 1 }], duration: dur("base"), easing: EASE },
    {
      keyframes: [
        { transform: "translateY(10px) scale(0.96)" },
        { transform: "translateY(0) scale(1)" },
      ],
      duration: dur("slow"),
      easing: SPRING,
      composite: "accumulate",
    },
  ],
  exit: [
    { keyframes: [{ opacity: 1 }, { opacity: 0 }], duration: dur("fast"), easing: EASE_IN },
    {
      keyframes: [{ transform: "translateY(0) scale(1)" }, { transform: "translateY(6px) scale(0.98)" }],
      duration: dur("fast"),
      easing: EASE_IN,
      composite: "accumulate",
    },
  ],
}));

function GraphCell({ row, lanes }: { row: GraphRow; lanes: number }) {
  const x = (i: number) => LANE_W / 2 + Math.min(i, MAX_LANES - 1) * LANE_W;
  const m = ROW_H / 2;
  return (
    <svg className="git-graph" width={lanes * LANE_W} height={ROW_H} aria-hidden>
      {row.through.map((t, k) => (
        <path
          key={`t${k}`}
          d={`M${x(t.from)} 0 C${x(t.from)} ${m} ${x(t.to)} ${m} ${x(t.to)} ${ROW_H}`}
          stroke={laneColor(t.to)}
        />
      ))}
      {row.into.map((i) => (
        <path key={`i${i}`} d={`M${x(i)} 0 Q${x(i)} ${m} ${x(row.lane)} ${m}`} stroke={laneColor(i)} />
      ))}
      {row.out.map((o) => (
        <path key={`o${o}`} d={`M${x(row.lane)} ${m} Q${x(o)} ${m} ${x(o)} ${ROW_H}`} stroke={laneColor(o)} />
      ))}
      <circle cx={x(row.lane)} cy={m} r={4} fill={laneColor(row.lane)} />
    </svg>
  );
}

function Commits({ ov, current }: { ov: GitOverview; current: string | undefined }) {
  const rows = useMemo(() => layoutGraph(ov.commits), [ov.commits]);
  const lanes = Math.min(MAX_LANES, Math.max(1, ...rows.map((r) => r.width)));
  if (ov.commits.length === 0) return <p className="git-empty">No commits yet.</p>;
  return (
    <ul className="git-list git-commits">
      <li className="git-cols" aria-hidden>
        <span style={{ width: lanes * LANE_W }} />
        <span>Message</span>
        <span>Author</span>
        <span>Date</span>
        <span>Commit</span>
      </li>
      {ov.commits.map((c, i) => (
        <li key={c.id} className="git-row commit" style={{ height: ROW_H }}>
          <GraphCell row={rows[i]} lanes={lanes} />
          <span className="git-message">
            {c.refs.map((r) => (
              <span key={r} className={`git-ref${r === current ? " head" : ""}`}>
                {r}
              </span>
            ))}
            <span className="git-summary" title={c.summary}>
              {c.summary}
            </span>
          </span>
          <span className="git-muted git-cell" title={c.author}>
            {c.author}
          </span>
          <span className="git-muted git-cell" title={formatDate(c.time * 1000)}>
            {ago(c.time)}
          </span>
          <code className="git-muted" title={c.id}>
            {c.id.slice(0, 7)}
          </code>
        </li>
      ))}
    </ul>
  );
}

function WorktreeRow({ w, onOpen }: { w: GitWorktree; onOpen: () => void }) {
  const size = useFolderSize([w.path], true);
  return (
    <li className="git-row">
      <button className="git-open" onClick={onOpen} title={w.path}>
        <span className="git-name">{basename(w.path)}</span>
        <span className="git-muted">{w.path}</span>
      </button>
      <span className="git-ref">{w.branch}</span>
      {w.main && <span className="git-muted">main</span>}
      {w.current && <span className="git-muted">this one</span>}
      <span
        className="git-size"
        title={w.main ? "Includes any worktrees stored inside this folder" : undefined}
      >
        {size?.denied ? "No access" : size?.done ? formatSize(size.bytes) : size ? `${formatSize(size.bytes)}…` : "…"}
      </span>
    </li>
  );
}

export function GitPanel({ dir, info }: { dir: string; info: GitInfo }) {
  const [open, setOpen] = useState(false);
  // undefined while reading. null if the repository could not be read.
  const [ov, setOv] = useState<GitOverview | null | undefined>(undefined);
  const [section, setSection] = useState<Section>("commits");
  const [busy, setBusy] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const navigate = useTabs((s) => s.navigate);
  const bumpRefresh = useTabs((s) => s.bumpRefresh);

  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .gitOverview(dir)
      .catch(() => null)
      .then((o) => live && setOv(o));
    return () => {
      live = false;
    };
  }, [open, dir, reloads]);
  // Never show the repository of another folder while this one is read.
  useEffect(() => setOv(undefined), [dir]);

  const switchTo = async (name: string) => {
    setBusy(name);
    try {
      await api.gitSwitch(dir, name);
      useUI.getState().pushToast(`Switched to ${name}`);
      // The open folder may not exist on the new branch.
      if (ov && !(await api.pathExists(dir).catch(() => true))) {
        setOpen(false);
        navigate({ kind: "path", path: ov.root });
      } else {
        setReloads((n) => n + 1);
      }
      bumpRefresh();
    } catch (err) {
      useUI.getState().pushToast(String(err), undefined, "error");
    } finally {
      setBusy(null);
    }
  };

  const current = ov?.branches.find((b) => b.current)?.name;
  return (
    <Popover
      open={open}
      onOpenChange={(_, d) => setOpen(d.open)}
      positioning="above-end"
      withArrow
      surfaceMotion={{ children: (_, props) => <PanelMotion {...props} /> }}
    >
      <PopoverTrigger disableButtonEnhancement>
        <button
          className="git-status"
          title={
            info.upstream
              ? `Compared with ${info.upstream} as of the last fetch`
              : info.detached
                ? "Detached HEAD"
                : "No upstream branch"
          }
        >
          <BranchRegular aria-hidden />
          {info.branch}
          {info.ahead > 0 && <span aria-label={`${info.ahead} ahead`}>↑{info.ahead}</span>}
          {info.behind > 0 && <span aria-label={`${info.behind} behind`}>↓{info.behind}</span>}
          {info.changes > 0 && (
            <span>
              · {info.changes} change{info.changes === 1 ? "" : "s"} here
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverSurface className="git-panel" aria-label="Git repository">
        {ov === undefined ? (
          <p className="git-empty">Reading the repository…</p>
        ) : ov === null ? (
          <p className="git-empty">This repository couldn’t be read.</p>
        ) : (
          <>
            <div className="git-head">
              <span className="git-name">{basename(ov.root)}</span>
              <span className="git-muted">{ov.root}</span>
            </div>
            <TabList
              size="small"
              selectedValue={section}
              onTabSelect={(_, d) => setSection(d.value as Section)}
            >
              <Tab value="commits">Commits</Tab>
              <Tab value="branches">Branches ({ov.branches.length})</Tab>
              <Tab value="worktrees">Worktrees ({ov.worktrees.length})</Tab>
              <Tab value="stashes">Stashes ({ov.stashes.length})</Tab>
            </TabList>
            <div className="git-body" key={section}>
              {section === "commits" && <Commits ov={ov} current={current} />}
              {section === "branches" && (
                <>
                  <ul className="git-list">
                    {ov.branches.map((b) => (
                      <li key={b.name} className="git-row">
                        <span className="git-check">{b.current && <CheckmarkRegular aria-label="Current" />}</span>
                        <span className="git-name">{b.name}</span>
                        {b.ahead > 0 && <span className="git-muted">↑{b.ahead}</span>}
                        {b.behind > 0 && <span className="git-muted">↓{b.behind}</span>}
                        <span className="git-summary git-muted" title={b.summary}>
                          {b.summary}
                        </span>
                        <span className="git-muted">{ago(b.time)}</span>
                        {!b.current && (
                          <Button
                            size="small"
                            disabled={busy !== null || b.worktree !== null}
                            title={b.worktree ? `Checked out in ${b.worktree}` : undefined}
                            onClick={() => void switchTo(b.name)}
                          >
                            {busy === b.name ? "Switching…" : "Switch"}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="git-foot">
                    {ov.remotes} remote branch{ov.remotes === 1 ? "" : "es"}, as of the last fetch
                  </p>
                </>
              )}
              {section === "worktrees" && (
                <ul className="git-list">
                  {ov.worktrees.map((w) => (
                    <WorktreeRow
                      key={w.path}
                      w={w}
                      onOpen={() => {
                        setOpen(false);
                        navigate({ kind: "path", path: w.path });
                      }}
                    />
                  ))}
                </ul>
              )}
              {section === "stashes" &&
                (ov.stashes.length === 0 ? (
                  <p className="git-empty">No stashes.</p>
                ) : (
                  <ul className="git-list">
                    {ov.stashes.map((s, i) => (
                      <li key={i} className="git-row">
                        <code className="git-muted">stash@{`{${i}}`}</code>
                        <span className="git-summary">{s}</span>
                      </li>
                    ))}
                  </ul>
                ))}
            </div>
          </>
        )}
      </PopoverSurface>
    </Popover>
  );
}
