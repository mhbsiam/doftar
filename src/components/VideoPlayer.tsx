import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../ipc";
import { CaptionButtons } from "./CaptionButtons";

const win = getCurrentWindow();
const SKIP_S = 5;

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export function VideoPlayer() {
  const [path, setPath] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  // Listen first. Then tell the backend that it can send videos here.
  useEffect(() => {
    const open = (p: string, show: boolean) => {
      setFailed(false);
      setPath(p);
      const title = nameOf(p);
      document.title = title;
      void win.setTitle(title).catch(() => {});
      // The backend shows a ready window. A window still starting shows itself.
      if (show) void api.showZoomed().catch(() => {});
    };
    const unOpen = win.listen<{ path: string }>("video:open", ({ payload }) => open(payload.path, false));
    void unOpen
      .then(() => api.videoReady())
      .then((first) => {
        if (first) open(first.path, true);
      })
      .catch(() => {});
    // Closing hides the window. Stop here to release the file.
    const unHidden = win.listen("video:hidden", () => setPath(null));
    const unMenu = win.listen<string>("menu", ({ payload }) => {
      if (payload === "close_tab") void win.close();
    });
    return () => {
      for (const un of [unOpen, unHidden, unMenu]) void un.then((f) => f());
    };
  }, []);

  // Without a src, the element releases its file.
  useEffect(() => {
    const v = video.current;
    if (v && !path) {
      v.removeAttribute("src");
      v.load();
    }
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = video.current;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") void win.close();
      else if (!v) return;
      else if (e.key === " " || e.key === "k") void (v.paused ? v.play() : v.pause());
      else if (e.key === "ArrowLeft") v.currentTime = Math.max(0, v.currentTime - SKIP_S);
      else if (e.key === "ArrowRight") v.currentTime += SKIP_S;
      else if (e.key === "m") v.muted = !v.muted;
      else if (e.key === "f") void (document.fullscreenElement ? document.exitFullscreen() : v.requestFullscreen());
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="iv">
      <header className="iv-bar" data-tauri-drag-region>
        <CaptionButtons />
        <span className="iv-name" data-tauri-drag-region title={path ?? undefined}>
          {path ? nameOf(path) : "Video"}
        </span>
        <span className="iv-meta" data-tauri-drag-region>
          {path ? dirOf(path) : ""}
        </span>
      </header>
      <div className="vp-stage">
        {failed && path ? (
          <div className="vp-failed" role="alert">
            <p>Doftar can't play this video. It may use a format WebKit doesn't support.</p>
            <button className="iv-btn wide" onClick={() => void api.openPath(path).catch(() => {})}>
              Open in Default App
            </button>
          </div>
        ) : (
          <video
            ref={video}
            className="vp-video"
            src={path ? convertFileSrc(path) : undefined}
            controls
            autoPlay
            playsInline
            onError={() => path && setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}
