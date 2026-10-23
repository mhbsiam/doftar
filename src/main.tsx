import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettings } from "./stores/settings";
import { resolveTheme } from "./hooks/useResolvedTheme";
import { applyTextScale } from "./util/textScale";
import { applyMotionScale } from "./util/motion";
import "./global.css";

/** The image viewer's window label; matches `LABEL` in viewer.rs. */
const VIEWER_LABEL = "viewer";
/** The reader's window label; matches `LABEL` in reader.rs. */
const READER_LABEL = "reader";
/** The PDF viewer's window label; matches `LABEL` in pdf.rs. */
const PDF_LABEL = "pdf";

applyTextScale(useSettings.getState().textScale);
void applyMotionScale();
// Without registered custom properties the spring-loading ring can't sweep;
// it shows whole instead.
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

// Loaded apart so the viewer window doesn't start the file manager's stores.
const label = getCurrentWindow().label;
const entry =
  label === VIEWER_LABEL
    ? import("./viewerMain")
    : label === READER_LABEL
      ? import("./readerMain")
      : label === PDF_LABEL
        ? import("./pdfMain")
        : import("./appMain");

void entry
  .then((m) => m.start())
  .then(({ ui, show }) => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>{ui}</React.StrictMode>
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
