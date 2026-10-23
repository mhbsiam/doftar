import { useCallback, useEffect, useRef, useState } from "react";
import { WinFileIcon, WinFolderIcon } from "./FileIcon";
import { useUI } from "../stores/ui";
import { useSettings } from "../stores/settings";
import { useExitGhost } from "../util/exitGhost";
import { useFileIdsFor } from "../stores/fileIds";
import { FOLDER_COLORS, folderStops, type FolderColorId } from "../util/folderColors";
import { formatSize, formatDate, basename } from "../util/format";
import { isFolder, typeLabel } from "../util/kinds";
import { parentOf } from "../stores/tabs";
import { useFolderSize } from "../hooks/useFolderSize";
import { useItemInfo } from "../hooks/useItemInfo";
import { openWithOther, setTag } from "../actions";
import { TAG_COLORS, COLOR_TAGS, isColorTag } from "../util/tags";
import type { ConflictSide, FileEntry, Resolution, Resolutions } from "../types";

const FOCUSABLE = "button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

function useDialogKeys(onEscape: () => void, onEnter: () => void) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useExitGhost(() => [dialogRef.current?.closest(".overlay")], "dialog");
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    primaryRef.current?.focus();
    return () => {
      if (opener && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onEscape();
      } else if (e.key === "Enter") {
        if (e.target instanceof HTMLButtonElement) return;
        e.stopPropagation();
        onEnter();
      } else if (e.key === "Tab") {
        const items = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (!items || items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (!dialogRef.current?.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onEscape, onEnter]);
  return { primaryRef, dialogRef };
}

export function DialogHost() {
  const confirm = useUI((s) => s.confirm);
  const properties = useUI((s) => s.properties);
  const conflictSpec = useUI((s) => s.conflictSpec);
  const newTagFor = useUI((s) => s.newTagFor);

  return (
    <>
      {confirm && <ConfirmDialog key="confirm" />}
      {conflictSpec && <ConflictDialog key={`conflicts-${conflictSpec.id}`} />}
      {properties && <PropertiesDialog key="props" />}
      {newTagFor && <NewTagDialog key="new-tag" />}
    </>
  );
}

function ConfirmDialog() {
  const confirm = useUI((s) => s.confirm)!;
  const close = useUI((s) => s.closeConfirm);
  const cancel = useCallback(() => {
    confirm.onCancel?.();
    close();
  }, [confirm, close]);
  const { primaryRef, dialogRef } = useDialogKeys(cancel, () => {
    confirm.onConfirm();
    close();
  });
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div
        ref={dialogRef}
        className="dialog"
        role={confirm.hideCancel ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby="wf-dialog-title"
        aria-describedby="wf-dialog-body"
      >
        <div className="dialog-title" id="wf-dialog-title">{confirm.title}</div>
        <div className="dialog-body" id="wf-dialog-body">{confirm.message}</div>
        <div className="dialog-actions">
          {!confirm.hideCancel && (
            <button className="btn subtle" onClick={cancel}>
              Cancel
            </button>
          )}
          {confirm.alt && (
            <button
              className="btn"
              onClick={() => {
                confirm.alt?.onSelect();
                close();
              }}
            >
              {confirm.alt.label}
            </button>
          )}
          <button
            ref={primaryRef}
            className={`btn accent${confirm.danger ? " danger" : ""}`}
            onClick={() => {
              confirm.onConfirm();
              close();
            }}
          >
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewTagDialog() {
  const entries = useUI((s) => s.newTagFor)!;
  const close = useUI((s) => s.closeNewTag);
  const [name, setName] = useState("");
  const [color, setColor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();
  // A tag can't share a colour tag's name (Finder treats it as that tag),
  // and the attribute keeps each tag as "name\ncolour".
  const problem = !trimmed
    ? null
    : trimmed.includes("\n")
      ? "A tag name can't contain a line break."
      : isColorTag({ name: trimmed, color: 0 })
        ? `“${trimmed}” is a colour tag; pick it from the dots instead.`
        : null;
  const create = () => {
    if (!trimmed || problem) return;
    const tag = { name: trimmed, color };
    useSettings.getState().addCustomTag(tag);
    setTag(entries, tag, true);
    close();
  };
  const { primaryRef, dialogRef } = useDialogKeys(close, create);
  useEffect(() => inputRef.current?.focus(), []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wf-dialog-title"
      >
        <div className="dialog-title" id="wf-dialog-title">New Tag</div>
        <div className="dialog-body new-tag">
          <input
            ref={inputRef}
            className="text-input"
            aria-label="Tag name"
            aria-invalid={problem !== null}
            aria-describedby={problem ? "wf-new-tag-error" : undefined}
            placeholder="Tag name"
            value={name}
            maxLength={128}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
          />
          {problem && (
            <p className="field-error" id="wf-new-tag-error" role="alert">
              {problem}
            </p>
          )}
          <span className="color-picker" role="radiogroup" aria-label="Tag colour">
            <button
              role="radio"
              aria-checked={color === 0}
              title="No colour"
              aria-label="No colour"
              className={`color-swatch tag-none${color === 0 ? " selected" : ""}`}
              onClick={() => setColor(0)}
            />
            {COLOR_TAGS.map((t) => (
              <button
                key={t.color}
                role="radio"
                aria-checked={color === t.color}
                title={t.name}
                aria-label={t.name}
                className={`color-swatch${color === t.color ? " selected" : ""}`}
                style={{ background: TAG_COLORS[t.color] }}
                onClick={() => setColor(t.color)}
              />
            ))}
          </span>
        </div>
        <div className="dialog-actions">
          <button className="btn subtle" onClick={close}>
            Cancel
          </button>
          <button
            ref={primaryRef}
            className="btn accent"
            disabled={!trimmed || problem !== null}
            onClick={create}
          >
            Add Tag
          </button>
        </div>
      </div>
    </div>
  );
}

function accessLabel(bits: number): string {
  const r = (bits & 4) !== 0;
  const w = (bits & 2) !== 0;
  const x = (bits & 1) !== 0;
  const base = r && w ? "Read & Write" : r ? "Read only" : w ? "Write only" : "No access";
  return x && (r || w) ? `${base}, execute` : base;
}

function bytesLabel(bytes: number): string {
  return `${formatSize(bytes)}${bytes >= 1024 ? ` (${bytes.toLocaleString()} bytes)` : ""}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="prop-row">
      <span className="prop-label">{label}</span>
      <span className="prop-value">{children}</span>
    </div>
  );
}

function FolderColorPicker({ folders }: { folders: FileEntry[] }) {
  const ids = useFileIdsFor(folders);
  const ready = ids.every((id): id is string => !!id);
  const current = useSettings((s) => {
    const set = new Set(ids.map((id) => (id ? (s.folderColors[id] ?? null) : null)));
    return set.size === 1 ? [...set][0] : undefined;
  });
  const setFolderColor = useSettings((s) => s.setFolderColor);
  const globalId = useSettings((s) => s.folderColor);
  const apply = (color: FolderColorId | null) => {
    if (ready) setFolderColor(ids as string[], color);
  };
  return (
    <span className="color-picker" role="radiogroup" aria-label="Folder color">
      <button
        role="radio"
        aria-checked={current === null}
        title="Default"
        aria-label="Default"
        disabled={!ready}
        className={`color-swatch default${current === null ? " selected" : ""}`}
        style={{
          background: `linear-gradient(${folderStops(globalId)[2]}, ${folderStops(globalId)[1]})`,
        }}
        onClick={() => apply(null)}
      />
      {FOLDER_COLORS.map((c) => (
        <button
          key={c.id}
          role="radio"
          aria-checked={current === c.id}
          title={c.label}
          aria-label={c.label}
          disabled={!ready}
          className={`color-swatch${current === c.id ? " selected" : ""}`}
          style={{ background: `linear-gradient(${c.stops[2]}, ${c.stops[1]})` }}
          onClick={() => apply(c.id)}
        />
      ))}
    </span>
  );
}

function PropertiesDialog() {
  const entries = useUI((s) => s.properties)!;
  const close = useUI((s) => s.closeProperties);
  const { primaryRef, dialogRef } = useDialogKeys(close, close);
  const single = entries.length === 1 ? entries[0] : null;
  const folders = entries.filter((e) => e.isDir);
  const info = useItemInfo(single ? single.path : null);
  const needsWalk = folders.length > 0;
  const walked = useFolderSize(
    entries.map((e) => e.path),
    needsWalk
  );
  const fileBytes = entries.filter((e) => !e.isDir).reduce((n, e) => n + e.size, 0);
  const total = needsWalk ? (walked ? walked.bytes : null) : fileBytes;
  const onDisk = needsWalk ? (walked ? walked.onDisk : null) : (info?.sizeOnDisk ?? null);
  const parents = new Set(entries.map((e) => parentOf(e.path)));
  const where = parents.size === 1 ? [...parents][0] : "Multiple locations";
  const fileCount = entries.length - entries.filter(isFolder).length;
  const title = single
    ? `${basename(single.path)} Properties`
    : `${entries.length} items Properties`;

  const sizeText = (bytes: number | null, counting: boolean) =>
    bytes === null
      ? "Calculating…"
      : `${bytesLabel(bytes)}${counting && walked && !walked.done ? " …" : ""}`;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={dialogRef}
        className="dialog wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wf-dialog-title"
      >
        <div className="dialog-title" id="wf-dialog-title">
          {single &&
            (isFolder(single) ? (
              <WinFolderIcon size={20} path={single.path} fileId={single.fileId} />
            ) : (
              <WinFileIcon entry={single} size={20} />
            ))}{" "}
          {title}
        </div>
        <div className="dialog-body props" tabIndex={0} aria-label="Details">
          {single ? (
            <>
              <Row label="Name">{single.name}</Row>
              <Row label="Type">{typeLabel(single)}</Row>
              {info?.symlinkTarget && <Row label="Links to">{info.symlinkTarget}</Row>}
            </>
          ) : (
            <Row label="Contains">
              {fileCount > 0 && `${fileCount} file${fileCount === 1 ? "" : "s"}`}
              {fileCount > 0 && entries.length - fileCount > 0 && ", "}
              {entries.length - fileCount > 0 &&
                `${entries.length - fileCount} folder${entries.length - fileCount === 1 ? "" : "s"}`}
            </Row>
          )}
          {entries.every(isFolder) && (
            <Row label="Color">
              <FolderColorPicker folders={entries} />
            </Row>
          )}
          <Row label="Size">{sizeText(total, needsWalk)}</Row>
          <Row label="Size on disk">{sizeText(onDisk, needsWalk)}</Row>
          {needsWalk && walked && (
            <Row label="Inside">
              {walked.files.toLocaleString()} file{walked.files === 1 ? "" : "s"},{" "}
              {walked.folders.toLocaleString()} folder{walked.folders === 1 ? "" : "s"}
              {!walked.done && !walked.cancelled ? " so far" : ""}
            </Row>
          )}
          <Row label="Where">
            <span className="prop-path">{where}</span>
          </Row>
          {single && (
            <>
              <Row label="Created">{formatDate(info?.createdMs ?? single.createdMs) || "–"}</Row>
              <Row label="Modified">{formatDate(info?.modifiedMs ?? single.modifiedMs) || "–"}</Row>
              {info && <Row label="Opened">{formatDate(info.accessedMs) || "–"}</Row>}
              {info && !isFolder(single) && (
                <Row label="Opens with">
                  {info.defaultApp ? basename(info.defaultApp).replace(/\.app$/, "") : "No default app"}
                  <button
                    className="link-btn prop-change"
                    onClick={() => void openWithOther([single.path])}
                  >
                    Change…
                  </button>
                </Row>
              )}
              {info && (info.whereFroms.length > 0 || info.quarantined) && (
                <Row label="Downloaded">
                  {info.whereFroms.length > 0 ? (
                    <span className="prop-path">{info.whereFroms[0]}</span>
                  ) : (
                    "From the internet"
                  )}
                  {info.quarantined && (
                    <span className="prop-note">
                      {" "}
                      · not yet opened, macOS will check it first
                    </span>
                  )}
                </Row>
              )}
              {info && info.tags.length > 0 && (
                <Row label="Tags">
                  <span className="prop-tags">
                    {info.tags.map((t) => (
                      <span key={t.name} className="prop-tag">
                        {t.color > 0 && (
                          <span
                            className="prop-tag-dot"
                            style={{ background: TAG_COLORS[t.color] }}
                            aria-hidden
                          />
                        )}
                        {t.name}
                      </span>
                    ))}
                  </span>
                </Row>
              )}
              {info && (
                <>
                  <Row label="Owner">
                    {info.owner} — {accessLabel((info.mode >> 6) & 7)}
                  </Row>
                  <Row label="Group">
                    {info.group} — {accessLabel((info.mode >> 3) & 7)}
                  </Row>
                  <Row label="Everyone">{accessLabel(info.mode & 7)}</Row>
                </>
              )}
            </>
          )}
        </div>
        <div className="dialog-actions">
          <button ref={primaryRef} className="btn accent" onClick={close}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function SideCard({ label, side }: { label: string; side: ConflictSide }) {
  return (
    <div className="conflict-card">
      <span className="conflict-card-label">{label}</span>
      <span className="conflict-card-name">{side.name}</span>
      <span className="conflict-card-meta">
        {side.isDir ? "Folder" : formatSize(side.size)}
        {side.modifiedMs ? ` · Modified ${formatDate(side.modifiedMs)}` : ""}
      </span>
    </div>
  );
}

function ConflictDialog() {
  const spec = useUI((s) => s.conflictSpec)!;
  const close = useUI((s) => s.closeConflicts);
  const { conflicts, resolve } = spec;
  const [index, setIndex] = useState(0);
  const [applyAll, setApplyAll] = useState(false);
  const chosen = useRef<Resolutions>({});
  const current = conflicts[index];
  const remaining = conflicts.length - index;

  const cancel = useCallback(() => {
    resolve(null);
    close();
  }, [resolve, close]);

  const choose = (r: Resolution) => {
    const last = applyAll ? conflicts.length : index + 1;
    for (let i = index; i < last; i++) {
      const c = conflicts[i];
      chosen.current[c.source.path] = r === "replace" && !c.canReplace ? "keepBoth" : r;
    }
    if (last >= conflicts.length) {
      resolve(chosen.current);
      close();
    } else {
      setIndex(last);
    }
  };

  const { primaryRef, dialogRef } = useDialogKeys(cancel, () => choose("keepBoth"));
  const where = basename(parentOf(current.existing.path) ?? "") || "this folder";

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div
        ref={dialogRef}
        className="dialog wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wf-dialog-title"
        aria-describedby="wf-dialog-body"
      >
        <div className="dialog-title" id="wf-dialog-title">
          {current.existing.isDir ? <WinFolderIcon size={20} /> : null}
          {current.existing.isDir ? "A folder" : "A file"} named “{current.existing.name}” already exists
        </div>
        <div className="dialog-body" id="wf-dialog-body">
          <p className="conflict-lede">
            {current.canReplace
              ? `Replacing it moves the existing item in “${where}” to the Trash.`
              : "A file and a folder can't replace each other. Keep both or skip it."}
          </p>
          <SideCard label="Existing" side={current.existing} />
          <SideCard label="Incoming" side={current.source} />
          {conflicts.length > 1 && (
            <label className="conflict-all">
              <input
                type="checkbox"
                checked={applyAll}
                onChange={(e) => setApplyAll(e.target.checked)}
              />
              Do this for all {remaining} remaining conflicts
            </label>
          )}
        </div>
        <div className="dialog-actions compact">
          <button className="btn subtle" onClick={cancel}>
            Cancel
          </button>
          <button className="btn subtle" onClick={() => choose("skip")}>
            Skip
          </button>
          <button
            className="btn subtle"
            disabled={!current.canReplace}
            onClick={() => choose("replace")}
          >
            Replace
          </button>
          <button ref={primaryRef} className="btn accent" onClick={() => choose("keepBoth")}>
            Keep both
          </button>
        </div>
      </div>
    </div>
  );
}
