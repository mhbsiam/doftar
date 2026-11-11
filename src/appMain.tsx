import type { ReactNode } from "react";
import App from "./App";
import { TermsGate } from "./components/TermsGate";
import { migrateFolderColors } from "./stores/fileIds";
import { startWindowSync } from "./stores/windowSync";
import { startTabTransfer } from "./tabTransfer";
import { startTerminals } from "./stores/terminals";
import { startViewerFlight } from "./viewerFlight";
import { startViewMorph } from "./util/viewMorph";
import { useTabs } from "./stores/tabs";
import { api } from "./ipc";
import { openHanded } from "./actions";
import { restoreSession, startSessionSave } from "./session";
import { getCurrentWindow } from "@tauri-apps/api/window";

export async function start(): Promise<{ ui: ReactNode; show: boolean }> {
  startWindowSync();
  startTabTransfer();
  startTerminals();
  startViewerFlight();
  startViewMorph();
  void migrateFolderColors();

  // A window from a dragged-out tab starts on that tab, not on Home.
  const tab = await api.takeWindowInit().catch(() => null);
  if (tab) useTabs.getState().adopt(tab);
  else if (getCurrentWindow().label === "main") await restoreSession().catch(() => {});
  startSessionSave();
  if (getCurrentWindow().label === "main") {
    // Drain once the listener is in place, so nothing handed over in between waits for the next event.
    void getCurrentWindow().listen("opened", openHanded).then(openHanded);
  }
  return {
    ui: (
      <TermsGate>
        <App />
      </TermsGate>
    ),
    show: true,
  };
}
