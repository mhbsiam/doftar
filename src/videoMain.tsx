import type { ReactNode } from "react";
import { VideoPlayer } from "./components/VideoPlayer";

/** Starts hidden. The backend shows the window when a video opens. */
export async function start(): Promise<{ ui: ReactNode; show: boolean }> {
  return { ui: <VideoPlayer />, show: false };
}
