import { csvField } from "./diskCsv";
import { formatDuration, formatFps, formatSize } from "./format";
import type { FileEntry, MediaInfo } from "../types";

export function shotListCsv(entries: FileEntry[], media: (MediaInfo | null)[]): string {
  const rows: (string | number)[][] = [
    ["name", "path", "duration", "duration_seconds", "width", "height", "fps", "codec", "camera", "size_bytes", "size", "modified", "tags"],
  ];
  entries.forEach((e, i) => {
    const m = media[i];
    rows.push([
      e.name,
      e.path,
      m?.durationS != null ? formatDuration(m.durationS) : "",
      m?.durationS ?? "",
      m?.width ?? "",
      m?.height ?? "",
      m?.fps ? formatFps(m.fps) : "",
      m?.codec ?? "",
      m?.camera ?? "",
      e.size,
      formatSize(e.size),
      e.modifiedMs ? new Date(e.modifiedMs).toISOString() : "",
      (e.tags ?? []).map((t) => t.name).join("; "),
    ]);
  });
  return rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}
