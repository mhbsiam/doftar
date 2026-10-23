// The text typed into a rename box, kept outside React so the input survives
// being virtualized away (scrolled out of the rendered window) and remounts
// with what the user had typed instead of the original name.
let draft: { path: string; value: string } | null = null;

export const renameDraft = (path: string): string | undefined =>
  draft?.path === path ? draft.value : undefined;

export function setRenameDraft(path: string, value: string) {
  draft = { path, value };
}

export function clearRenameDraft() {
  draft = null;
}
