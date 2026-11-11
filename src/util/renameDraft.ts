// Rename box text is kept outside React. A virtualized row that scrolls away
// then remounts with the typed text, not the original name.
let draft: { path: string; value: string } | null = null;

export const renameDraft = (path: string): string | undefined =>
  draft?.path === path ? draft.value : undefined;

export function setRenameDraft(path: string, value: string) {
  draft = { path, value };
}

export function clearRenameDraft() {
  draft = null;
}
