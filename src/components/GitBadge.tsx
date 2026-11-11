import { useGit } from "../stores/git";
import { parentOf } from "../stores/tabs";
import type { FileEntry, GitCode } from "../types";

const LETTER: Record<GitCode, string> = {
  modified: "M",
  added: "A",
  untracked: "U",
  conflicted: "!",
  changed: "•",
};

const LABEL: Record<GitCode, string> = {
  modified: "Modified",
  added: "Added",
  untracked: "Untracked",
  conflicted: "Conflicted",
  changed: "Contains changes",
};

export function GitBadge({ entry }: { entry: FileEntry }) {
  const code = useGit((s) => s.byDir[parentOf(entry.path) ?? ""]?.files[entry.name]);
  if (!code) return null;
  return (
    <span className={`git-badge ${code}`} title={LABEL[code]} role="img" aria-label={`Git: ${LABEL[code]}`}>
      {LETTER[code]}
    </span>
  );
}
