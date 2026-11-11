export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  // Judge each unit after rounding, so 1023.6 KB shows "1.0 MB", not "1024 KB".
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
 * Resolves `.` and `..` in an absolute path and removes empty and trailing separators, as the shell does.
 * `..` at the root stays at the root.
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

export type DateStyle = "mdy" | "dmy" | "dMonY" | "monDY";
export type ClockStyle = "12" | "24";
export const DATE_STYLES: [DateStyle, string][] = [
  ["mdy", "MM/DD/YYYY"],
  ["dmy", "DD/MM/YYYY"],
  ["dMonY", "DD/Mon/YYYY"],
  ["monDY", "Mon D, YYYY"],
];

/** The settings store sets it before any render. */
export const dateFormat: { date: DateStyle; clock: ClockStyle } = { date: "mdy", clock: "12" };

const pad = (n: number) => String(n).padStart(2, "0");

function datePart(d: Date, withYear = true): string {
  const day = d.getDate();
  const mm = pad(d.getMonth() + 1);
  const mon = d.toLocaleDateString([], { month: "short" });
  const y = d.getFullYear();
  switch (dateFormat.date) {
    case "dmy":
      return withYear ? `${pad(day)}/${mm}/${y}` : `${pad(day)}/${mm}`;
    case "dMonY":
      return withYear ? `${pad(day)}/${mon}/${y}` : `${pad(day)}/${mon}`;
    case "monDY":
      return withYear ? `${mon} ${day}, ${y}` : `${mon} ${day}`;
    default:
      return withYear ? `${mm}/${pad(day)}/${y}` : `${mm}/${pad(day)}`;
  }
}

function timePart(d: Date): string {
  const h = d.getHours();
  const m = pad(d.getMinutes());
  if (dateFormat.clock === "24") return `${pad(h)}:${m}`;
  return `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

export function formatDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  // A corrupt timestamp is past what a Date holds. Show no date, not "Invalid Date".
  if (Number.isNaN(d.getTime())) return "";
  return `${datePart(d)} ${timePart(d)}`;
}

/** The time for today. The date, without the year, for this year. */
export function shortDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return timePart(d);
  return datePart(d, d.getFullYear() !== now.getFullYear());
}

export function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export const formatDuration = (s: number) => {
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
};

/** 29.97, 25, 23.98: at most two decimals. */
export const formatFps = (fps: number) => String(Math.round(fps * 100) / 100);
