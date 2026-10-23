import type { ReactNode } from "react";
import App from "./App";
import { migrateFolderColors } from "./stores/fileIds";
import { startWindowSync } from "./stores/windowSync";
import { startTabTransfer } from "./tabTransfer";
import { startTerminals } from "./stores/terminals";
import { startViewerFlight } from "./viewerFlight";
import { startViewMorph } from "./util/viewMorph";
import { useTabs } from "./stores/tabs";
import { api } from "./ipc";

/** Starts a file manager window and returns what it shows. */
export async function start(): Promise<{ ui: ReactNode; show: boolean }> {
  startWindowSync();
  startTabTransfer();
  startTerminals();
  startViewerFlight();
  startViewMorph();
  void migrateFolderColors();

  // A window made by dragging a tab out starts on that tab, not on Home.
  const tab = await api.takeWindowInit().catch(() => null);
  if (tab) useTabs.getState().adopt(tab);
  return { ui: <App />, show: true };
}
