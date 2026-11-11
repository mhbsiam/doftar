import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";

export const ZOOM_EVENT = "wf:zoom";

// Resolve it once. Then the resize subscription stays across renders.
const win = getCurrentWindow();

/** Every window draws these in place of the native buttons. Kept apart from the file manager stores for the viewer windows. */
export function CaptionButtons() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // The bar moves between halves when split view changes. Catch up on mount.
    void win.isMaximized().then(setMaximized).catch(() => {});
    let nudgedFor = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unlisten = win
      .onResized(async () => {
        setMaximized(await win.isMaximized());
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            const s = await win.outerSize();
            const key = `${s.width}x${s.height}`;
            if (key === nudgedFor) return;
            nudgedFor = key;
            await win.setSize(new PhysicalSize(s.width, s.height));
          } catch {
          }
        }, 150);
      });
    return () => {
      if (timer) clearTimeout(timer);
      void unlisten.then((f) => f());
    };
  }, []);

  const toggleMaximize = () =>
    void invoke<boolean>("toggle_maximize_window")
      .then(setMaximized)
      .catch(() => {});

  useEffect(() => {
    const onZoom = () => toggleMaximize();
    window.addEventListener(ZOOM_EVENT, onZoom);
    return () => window.removeEventListener(ZOOM_EVENT, onZoom);
  }, []);

  // Both styles render and data-window-buttons (see main.tsx) hides one: viewer windows do not mirror the settings store.
  // macOS traffic lights: grey while the window is in the background (see data-inactive in main.tsx).
  // Glyphs show on hover.
  return (
    <>
      <div className="caption-windows">
        <button title="Minimize" aria-label="Minimize" onClick={() => void win.minimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
            <path d="M0 5.5 H10" />
          </svg>
        </button>
        <button
          title={maximized ? "Restore" : "Maximize"}
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={toggleMaximize}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
            {maximized ? (
              <>
                <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
                <path d="M2.5 2.5 V1.5 A1 1 0 0 1 3.5 0.5 H8.5 A1 1 0 0 1 9.5 1.5 V6.5 A1 1 0 0 1 8.5 7.5 H7.5" />
              </>
            ) : (
              <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
            )}
          </svg>
        </button>
        <button className="caption-close" title="Close" aria-label="Close window" onClick={() => void win.close()}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
            <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" />
          </svg>
        </button>
      </div>
      <div className="traffic-lights">
        <button className="light close" title="Close" aria-label="Close window" onClick={() => void win.close()}>
          <svg width="6" height="6" viewBox="0 0 6 6">
            <path d="M0.5 0.5 L5.5 5.5 M5.5 0.5 L0.5 5.5" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
        <button className="light minimize" title="Minimize" aria-label="Minimize" onClick={() => void win.minimize()}>
          <svg width="6" height="6" viewBox="0 0 6 6">
            <path d="M0 3 H6" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
        <button
          className="light zoom"
          title={maximized ? "Restore" : "Zoom"}
          aria-label={maximized ? "Restore" : "Zoom"}
          onClick={toggleMaximize}
        >
          <svg width="6" height="6" viewBox="0 0 6 6">
            <path d="M0 0 H4 L0 4 Z M6 6 H2 L6 2 Z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </>
  );
}
