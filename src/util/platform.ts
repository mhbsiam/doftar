/** WebKitGTK names Linux in the user agent; the macOS build says Macintosh. */
export const ON_LINUX =
  /\bLinux\b/.test(navigator.userAgent) && !/\bAndroid\b/.test(navigator.userAgent);

/** The system file manager, as menus name it. */
export const FILE_MANAGER = ON_LINUX ? "File Manager" : "Finder";

/** Where installed apps live: the Apps page and Go → Applications. */
export const APPS_DIR = ON_LINUX ? "/usr/share/applications" : "/Applications";

/** Paths on an external or network drive: /Volumes on macOS, /media, /run/media and /mnt on Linux. */
export const EXTERNAL_PATH = /^\/(Volumes\/|(media\/[^/]+|run\/media\/[^/]+\/[^/]+|mnt)\/[^/]+)/;

/** Keys that Linux names differently from the ⌘ glyph rule below. */
const LINUX_EXCEPTIONS: [string, string][] = [
  ["⌃⌘N", "Ctrl+Alt+Shift+N"],
  ["⌘+", "Ctrl+="],
];

/** A macOS key label in Linux form: ⌘ and ⌃ are Ctrl, ⌥ is Alt, ⇧ is Shift, ⌫ is Backspace. */
export function linuxKeys(mac: string): string {
  let out = mac;
  for (const [from, to] of LINUX_EXCEPTIONS) out = out.split(from).join(to);
  return out
    .replace(/([⌃⌥⇧⌘]+)(?: \+ )?/g, (_, m: string) =>
      [/[⌘⌃]/.test(m) && "Ctrl", m.includes("⌥") && "Alt", m.includes("⇧") && "Shift"].filter(Boolean).join("+") + "+"
    )
    .replace(/⌫/g, "Backspace");
}

/** A key label written the macOS way, shown in this system's form. */
export const keys = (mac: string): string => (ON_LINUX ? linuxKeys(mac) : mac);

/** An aria-keyshortcuts value written with Meta, in this system's form. */
export const ariaKeys = (mac: string): string => (ON_LINUX ? mac.replace(/\bMeta\b/g, "Control") : mac);

/** One of two texts: the macOS one, or the Linux one. */
export const os = <T,>(mac: T, linux: T): T => (ON_LINUX ? linux : mac);
