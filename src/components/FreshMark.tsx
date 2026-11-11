import { ArrowSyncRegular, SparkleFilled } from "@fluentui/react-icons";
import { isFresh } from "../util/itemFilter";
import { useWriting } from "../stores/writing";
import type { FileEntry } from "../types";

export function FreshMark({ entry }: { entry: FileEntry }) {
  const writing = useWriting((s) => s.paths[entry.path] === true);
  if (writing) {
    const title = "Still being written: a render, download or recording in progress";
    return (
      <span className="fresh-mark writing" title={title} role="img" aria-label={title}>
        <ArrowSyncRegular />
      </span>
    );
  }
  if (!isFresh(entry.modifiedMs, Date.now())) return null;
  return (
    <span className="fresh-mark" title="Changed in the last day" role="img" aria-label="Changed in the last day">
      <SparkleFilled />
    </span>
  );
}
