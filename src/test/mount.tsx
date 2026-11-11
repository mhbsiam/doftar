import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { FluentProvider } from "@fluentui/react-components";
import { fluentTheme } from "../fluentTheme";
import { useSettings } from "../stores/settings";

export const SPLIT = 620;
export const WIDE = 1100;

export const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

export async function mount(node: ReactElement, width: number) {
  const host = document.createElement("div");
  host.style.width = `${width}px`;
  document.body.append(host);
  const root = createRoot(host);
  root.render(
    <FluentProvider theme={fluentTheme("light", useSettings.getState().folderColor)}>{node}</FluentProvider>
  );
  await settle();
  return {
    host,
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}
