import { useEffect, useMemo, useState } from "react";
import {
  AddRegular,
  AppsRegular,
  ArrowClockwiseRegular,
  CopyRegular,
  DeleteRegular,
  EditRegular,
  FolderOpenRegular,
  LinkRegular,
  OpenRegular,
} from "@fluentui/react-icons";
import { WinFileIcon } from "./FileIcon";
import { RovingListbox } from "./HomeView";
import { api } from "../ipc";
import { useTabs, usePaneStore } from "../stores/tabs";
import { useAppData } from "../stores/appdata";
import { useUI, type MenuItemSpec } from "../stores/ui";
import {
  appsFor,
  copyAsPath,
  navigateTo,
  openFile,
  openWith,
  openWithOther,
  refreshSoon,
  setViewEntries,
  showError,
  trashNow,
} from "../actions";
import { currentEditors } from "../stores/terminals";
import type { SkillPlace } from "../types";

const MD = { isDir: false, ext: "md" };

interface Copy {
  place: SkillPlace;
  path: string;
  linked: boolean;
}

/** One skill. Copies that resolve to one folder count as one. */
interface Entry {
  real: string;
  name: string;
  description: string;
  copies: Copy[];
}

function collect(places: SkillPlace[]): Entry[] {
  const byReal = new Map<string, Entry>();
  for (const place of places) {
    for (const s of place.skills) {
      let e = byReal.get(s.real);
      if (!e) byReal.set(s.real, (e = { real: s.real, name: s.name, description: s.description, copies: [] }));
      e.copies.push({ place, path: s.path, linked: s.linked });
    }
  }
  return [...byReal.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function tilde(path: string, home: string) {
  return home && path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

const fileOf = (e: Entry) => `${e.real}/SKILL.md`;
const open = (e: Entry) => openFile(fileOf(e));
const edit = (e: Entry) => void api.openReader(fileOf(e), null, null, true).catch(showError);

/** Order: code editors, other Markdown apps, any app. */
async function openWithItems(e: Entry): Promise<MenuItemSpec[]> {
  const file = fileOf(e);
  const editors = currentEditors().list;
  const others = (await appsFor(file)).filter((a) => !editors.some((x) => x.path === a.path));
  return [
    ...editors.map((a) => ({ key: `ed:${a.path}`, label: a.name, onSelect: () => openWith([file], a.path) })),
    ...others.map((a, i) => ({
      key: `app:${a.path}`,
      label: a.isDefault ? `${a.name} (default)` : a.name,
      dividerBefore: i === 0 && editors.length > 0,
      onSelect: () => openWith([file], a.path),
    })),
    {
      key: "other",
      label: "Choose another app…",
      dividerBefore: editors.length + others.length > 0,
      onSelect: () => void openWithOther([file]),
    },
  ];
}

function addTo(e: Entry, place: SkillPlace) {
  api.linkSkill(e.real, place.id).then(() => refreshSoon(), showError);
}

/** Trashes copy `c`. The original folder asks first while other agents still link to it. */
function remove(e: Entry, c: Copy) {
  const links = e.copies.filter((x) => x !== c && x.linked);
  if (c.linked || links.length === 0) return void trashNow([c.path]);
  useUI.getState().openConfirm({
    title: `Remove ${e.name}?`,
    message: `This is the skill's own folder, and ${links.map((x) => x.place.label).join(", ")} link to it. Their links go to the Trash with it.`,
    confirmLabel: "Move to Trash",
    danger: true,
    onConfirm: () => void trashNow([...links.map((x) => x.path), c.path]),
  });
}

export function SkillsView() {
  const tick = useTabs((s) => s.refreshTick);
  const home = useAppData((s) => s.home);
  const [places, setPlaces] = useState<SkillPlace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  /** The agent whose skills show. null shows all. */
  const [only, setOnly] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .listSkills()
      .then((p) => live && (setPlaces(p), setError(null)))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [tick]);

  const entries = useMemo(() => collect(places ?? []), [places]);
  const shown = only ? entries.filter((e) => e.copies.some((c) => c.place.id === only)) : entries;
  const target = places?.find((p) => p.id === only) ?? places?.[0];

  const paneTabs = usePaneStore();
  useEffect(() => {
    const s = paneTabs.getState();
    setViewEntries(s.pane, []);
    s.setListingCount(shown.length);
    s.setSelectionBytes(0);
  }, [shown.length, paneTabs]);

  const create = () => {
    const name = draft?.trim();
    if (!name || !target) return setDraft(null);
    api
      .createSkill(target.id, name)
      .then((file) => {
        setDraft(null);
        refreshSoon();
        void api.openReader(file, null, null, true).catch(showError);
      })
      .catch(showError);
  };

  const openMenu = async (x: number, y: number, e: Entry) => {
    setSelected(e.real);
    const withItems = await openWithItems(e);
    const missing = (places ?? []).filter((p) => !e.copies.some((c) => c.place === p));
    const items: MenuItemSpec[] = [
      { key: "open", label: "Open", icon: <OpenRegular />, onSelect: () => open(e) },
      { key: "edit", label: "Edit", icon: <EditRegular />, onSelect: () => edit(e) },
      { key: "with", label: "Open with", icon: <AppsRegular />, items: withItems },
      { key: "folder", label: "Open folder", icon: <FolderOpenRegular />, onSelect: () => navigateTo({ kind: "path", path: e.real }) },
      {
        key: "add",
        label: "Add to",
        icon: <LinkRegular />,
        dividerBefore: true,
        disabled: missing.length === 0,
        items: missing.map((p) => ({ key: p.id, label: p.label, onSelect: () => addTo(e, p) })),
      },
      {
        key: "remove",
        label: "Remove from",
        icon: <DeleteRegular />,
        items: e.copies.map((c) => ({
          key: c.place.id,
          label: c.linked ? c.place.label : `${c.place.label} (original)`,
          onSelect: () => remove(e, c),
        })),
      },
      { key: "copy", label: "Copy as path", icon: <CopyRegular />, dividerBefore: true, onSelect: () => copyAsPath([e.real]) },
    ];
    useUI.getState().openContextMenu(x, y, items);
  };

  const row = (e: Entry) => (
    <div
      key={e.real}
      className={`filerow skillrow${selected === e.real ? " selected" : ""}`}
      role="option"
      aria-selected={selected === e.real}
      tabIndex={-1}
      onClick={() => setSelected(e.real)}
      onDoubleClick={() => open(e)}
      onContextMenu={(ev) => {
        ev.preventDefault();
        void openMenu(ev.clientX, ev.clientY, e);
      }}
      onKeyDown={(ev) => {
        if (ev.target !== ev.currentTarget) return;
        if (ev.key === "Enter") {
          ev.preventDefault();
          open(e);
        } else if (ev.key === "ContextMenu" || (ev.shiftKey && ev.key === "F10")) {
          ev.preventDefault();
          const r = ev.currentTarget.getBoundingClientRect();
          void openMenu(r.left + 32, r.bottom, e);
        }
      }}
    >
      <span className="ficon">
        <WinFileIcon entry={MD} size={24} />
      </span>
      <span className="fname" title={tilde(e.real, home)}>{e.name}</span>
      <span className="fdesc" title={e.description}>{e.description}</span>
      <span className="skill-agents" title={e.copies.map((c) => tilde(c.path, home)).join("\n")}>
        {e.copies.map((c) => (
          <span key={c.place.id} className="skill-agent">{c.place.label}</span>
        ))}
      </span>
    </div>
  );

  if (!places || places.length === 0) {
    return (
      <div className="content home skills-page">
        <div className="empty-state">
          {error ? (
            <p>{error}</p>
          ) : !places ? (
            <p className="loading">Finding skills…</p>
          ) : (
            <>
              <h2>No skills folders</h2>
              <p className="hint">
                Skills live in ~/.agents/skills, and in each coding agent's own folder such as
                ~/.claude/skills or ~/.codex/skills.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="content home skills-page"
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest(".filerow, button, input")) setSelected(null);
      }}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest(".filerow")) return;
        e.preventDefault();
        useUI.getState().openContextMenu(e.clientX, e.clientY, [
          { key: "refresh", label: "Refresh", icon: <ArrowClockwiseRegular />, onSelect: () => refreshSoon() },
        ]);
      }}
    >
      <div className="skills-bar">
        <span className="seg" role="radiogroup" aria-label="Agent">
          {[null, ...places].map((p) => (
            <button
              key={p?.id ?? "all"}
              role="radio"
              aria-checked={only === (p?.id ?? null)}
              className={only === (p?.id ?? null) ? "on" : undefined}
              title={p ? tilde(p.dir, home) : undefined}
              onClick={() => setOnly(p?.id ?? null)}
            >
              {p?.label ?? "All"} <span className="dgroup-count">{p ? p.skills.length : entries.length}</span>
            </button>
          ))}
        </span>
        <button className="link-btn" onClick={() => setDraft("")}>
          <AddRegular /> New skill
        </button>
      </div>
      {draft !== null && target && (
        <input
          className="text-input skill-new"
          autoFocus
          placeholder={`skill-name, then Return, to add it to ${target.label}`}
          aria-label={`New ${target.label} skill name`}
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value.toLowerCase().replace(/[\s_]+/g, "-"))}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            else if (e.key === "Escape") setDraft(null);
          }}
        />
      )}
      {shown.length === 0 ? (
        <p className="list-empty">No skills in {target && tilde(target.dir, home)}</p>
      ) : (
        <RovingListbox label="Skills">{shown.map(row)}</RovingListbox>
      )}
    </div>
  );
}
