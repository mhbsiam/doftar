import { WinTerminalIcon } from "./FileIcon";
import { openInTerminal } from "../actions";
import { currentTerminals } from "../stores/terminals";
import type { MenuItemSpec } from "../stores/ui";

/**
 * "Open in Warp" (the default terminal, one click) for the right-click menus.
 * The other terminals are in the address bar's "⋮" menu.
 */
export function terminalMenuItems(dir: string | null, dividerBefore = false): MenuItemSpec[] {
  const { def } = currentTerminals();
  return [
    {
      key: "terminal",
      label: `Open in ${def?.name ?? "Terminal"}`,
      icon: <WinTerminalIcon />,
      shortcut: "⌥⌘T",
      disabled: !dir,
      dividerBefore,
      onSelect: () => dir && openInTerminal(dir),
    },
  ];
}
