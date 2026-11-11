export function RenameError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <span className="rename-error" id="wf-rename-error" role="alert">
      {error}
    </span>
  );
}
