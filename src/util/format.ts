export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  // Each unit is judged after rounding, so 1023.6 KB reads "1.0 MB", not "1024 KB".
  const kb = String(Math.ceil(bytes / 1024));
  if (Number(kb) < 1024) return `${kb} KB`;
  const mbv = bytes / 1024 ** 2;
  const mb = mbv < 10 ? mbv.toFixed(1) : String(Math.round(mbv));
  if (Number(mb) < 1024) return `${mb} MB`;
  const gbv = bytes / 1024 ** 3;
  const gb = gbv < 10 ? gbv.toFixed(2) : gbv.toFixed(1);
  if (Number(gb) < 1024) return `${gb} GB`;
  const tb = bytes / 1024 ** 4;
  return `${tb < 10 ? tb.toFixed(2) : tb.toFixed(1)} TB`;
}

/**
 * Resolves `.` and `..` in an absolute path and drops empty and trailing
 * separators, the way the shell reads it. `..` at the root stays at the root.
 */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

export function formatDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const date = d.toLocaleDateString([], {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const time = d.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} ${time}`;
}

export function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
