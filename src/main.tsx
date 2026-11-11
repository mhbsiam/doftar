import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useSettings, type WindowButtons } from "./stores/settings";
import { resolveTheme } from "./hooks/useResolvedTheme";
import { applyTextScale } from "./util/textScale";
import { applyMotionScale } from "./util/motion";
import { startUiErrorLog } from "./util/uiErrors";
import { PaneBoundary } from "./components/PaneBoundary";
import { CaptionButtons } from "./components/CaptionButtons";
import "./global.css";

startUiErrorLog();

/** Must match `LABEL` in viewer.rs. */
const VIEWER_LABEL = "viewer";
/** Must match `LABEL` in reader.rs. */
const READER_LABEL = "reader";
/** Must match `LABEL` in pdf.rs. */
const PDF_LABEL = "pdf";
/** Must match `LABEL` in video.rs. */
const VIDEO_LABEL = "video";

applyTextScale(useSettings.getState().textScale);
void applyMotionScale();
// Registered custom properties let the spring-loading ring sweep. Without them it shows whole.
if (!("registerProperty" in CSS)) document.documentElement.classList.add("no-arc");
document.documentElement.setAttribute(
  "data-theme",
  resolveTheme(useSettings.getState().theme)
);

window.addEventListener("contextmenu", (e) => {
  if (e.defaultPrevented) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, [contenteditable='true'], [contenteditable='']")) return;
  e.preventDefault();
});

// A background window shows its traffic lights and selection in grey, as macOS does.
void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
  document.documentElement.toggleAttribute("data-inactive", !focused);
});

const setWindowButtons = (style: WindowButtons) =>
  document.documentElement.setAttribute("data-window-buttons", style);
setWindowButtons(useSettings.getState().windowButtons);
// Viewer windows do not mirror the settings store, so every window follows the event.
void listen<{ state: { windowButtons?: WindowButtons } }>("sync:settings", ({ payload }) => {
  if (payload.state.windowButtons) setWindowButtons(payload.state.windowButtons);
});

// Load it apart, so the viewer window does not start the file manager stores.
const label = getCurrentWindow().label;
const entry =
  label === VIEWER_LABEL
    ? import("./viewerMain")
    : label === READER_LABEL
      ? import("./readerMain")
      : label === PDF_LABEL
        ? import("./pdfMain")
        : label === VIDEO_LABEL
          ? import("./videoMain")
          : import("./appMain");

void entry
  .then((m) => m.start())
  .then(({ ui, show }) => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <PaneBoundary what="this window" chrome={<CaptionButtons />}>
          {ui}
        </PaneBoundary>
      </React.StrictMode>
    );
    if (!show) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void getCurrentWindow()
          .show()
          .catch(() => {});
      })
    );
  });
