import type { ReactNode } from "react";
import { ImageViewer } from "./components/ImageViewer";

/** Starts hidden. The viewer shows itself when an image opens. */
export async function start(): Promise<{ ui: ReactNode; show: boolean }> {
  return { ui: <ImageViewer />, show: false };
}
