import { useEffect, useRef, useState, type RefObject } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MusicNote2Regular, NextRegular, PreviousRegular } from "@fluentui/react-icons";
import { api } from "../ipc";
import { extOf, isPlayableAudio } from "../util/kinds";
import { CaptionButtons } from "./CaptionButtons";

const win = getCurrentWindow();
const SKIP_S = 5;
const ART_PX = 512;

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export function VideoPlayer() {
  const [path, setPath] = useState<string | null>(null);
  // Kept when the path clears, so the same element releases the file.
  const [audio, setAudio] = useState(false);
  const [order, setOrder] = useState<string[] | null>(null);
  const [art, setArt] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const video = useRef<HTMLMediaElement>(null);

  const play = (p: string) => {
    setFailed(false);
    setAudio(isPlayableAudio(extOf(p)));
    setPath(p);
    const title = nameOf(p);
    document.title = title;
    void win.setTitle(title).catch(() => {});
  };

  // Listen first. Then tell the backend that it can send files here.
  useEffect(() => {
    type Open = { path: string; order: string[] | null };
    const open = ({ path: p, order: o }: Open, show: boolean) => {
      setOrder(o);
      play(p);
      // The backend shows a ready window. A window still starting shows itself.
      if (show) void api.showZoomed().catch(() => {});
    };
    const unOpen = win.listen<Open>("video:open", ({ payload }) => open(payload, false));
    void unOpen
      .then(() => api.videoReady())
      .then((first) => {
        if (first) open(first, true);
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

  useEffect(() => {
    setArt(null);
    if (!path || !audio) return;
    let live = true;
    api
      .thumbnail(path, ART_PX)
      .then((t) => live && setArt(convertFileSrc(t)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path, audio]);

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
      else if (e.key === "f" && v instanceof HTMLVideoElement)
        void (document.fullscreenElement ? document.exitFullscreen() : v.requestFullscreen());
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const at = path && order ? order.indexOf(path) : -1;
  const prev = order && at > 0 ? order[at - 1] : null;
  const next = order && at >= 0 && at < order.length - 1 ? order[at + 1] : null;

  return (
    <div className="iv">
      <header className="iv-bar" data-tauri-drag-region>
        <CaptionButtons />
        <span className="iv-name" data-tauri-drag-region title={path ?? undefined}>
          {path ? nameOf(path) : "Player"}
        </span>
        <span className="iv-meta" data-tauri-drag-region>
          {path ? dirOf(path) : ""}
        </span>
      </header>
      {audio ? (
        <div className="ap-stage">
          <div className="ap-art">
            {art ? <img src={art} alt="" onError={() => setArt(null)} /> : <MusicNote2Regular />}
          </div>
          <div className="ap-title" title={path ?? undefined}>
            {path ? nameOf(path) : ""}
          </div>
          <div className="ap-sub" role={failed ? "alert" : undefined}>
            {failed
              ? "Doftar can't play this file."
              : order && at >= 0 && order.length > 1
                ? `${at + 1} of ${order.length}`
                : ""}
          </div>
          <div className="ap-controls">
            <button className="iv-btn" aria-label="Previous track" disabled={!prev} onClick={() => prev && play(prev)}>
              <PreviousRegular />
            </button>
            <audio
              ref={video}
              className="ap-audio"
              src={path ? convertFileSrc(path) : undefined}
              controls
              autoPlay
              onError={() => path && setFailed(true)}
              onEnded={() => next && play(next)}
            />
            <button className="iv-btn" aria-label="Next track" disabled={!next} onClick={() => next && play(next)}>
              <NextRegular />
            </button>
          </div>
          {failed && path && (
            <button className="iv-btn wide" onClick={() => void api.openPath(path).catch(() => {})}>
              Open in Default App
            </button>
          )}
        </div>
      ) : (
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
              ref={video as RefObject<HTMLVideoElement>}
              className="vp-video"
              src={path ? convertFileSrc(path) : undefined}
              controls
              autoPlay
              playsInline
              onError={() => path && setFailed(true)}
            />
          )}
        </div>
      )}
    </div>
  );
}
