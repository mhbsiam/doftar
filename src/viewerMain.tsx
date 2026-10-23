import type { ReactNode } from "react";
import { ImageViewer } from "./components/ImageViewer";

/**
 * Starts the image viewer window. It stays hidden: the viewer shows itself
 * when an image is opened.
 */
export async function start(): Promise<{ ui: ReactNode; show: boolean }> {
  return { ui: <ImageViewer />, show: false };
}
