import { formatSize } from "./format";
import type { DiskReport } from "../types";

export function csvField(v: string | number | boolean): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function diskCsv(report: DiskReport): string {
  const rows: (string | number | boolean)[][] = [
    ["kind", "path", "name", "size_bytes", "size", "category", "modified", "safe_to_trash", "note"],
  ];
  for (const f of report.topFiles) {
    const modified = f.modifiedMs ? new Date(f.modifiedMs).toISOString() : "";
    rows.push(["file", f.path, f.name, f.size, formatSize(f.size), f.category, modified, "", ""]);
  }
  for (const j of report.devFolders ?? []) {
    rows.push(["developer", j.path, j.label, j.bytes, formatSize(j.bytes), "", "", j.safe, j.note]);
  }
  return rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}
