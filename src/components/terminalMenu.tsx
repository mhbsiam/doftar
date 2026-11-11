import { WinTerminalIcon } from "./FileIcon";
import { openInTerminal } from "../actions";
import type { MenuItemSpec } from "../stores/ui";

/** A fixed label that opens the default terminal. The address bar "⋮" menu sets the terminal. */
export function terminalMenuItems(dir: string | null, dividerBefore = false): MenuItemSpec[] {
  return [
    {
      key: "terminal",
      label: "Open in Terminal",
      icon: <WinTerminalIcon />,
      disabled: !dir,
      dividerBefore,
      onSelect: () => dir && openInTerminal(dir),
    },
  ];
}
