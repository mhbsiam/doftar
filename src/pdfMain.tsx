import type { ReactNode } from "react";
import { PdfViewer } from "./components/PdfViewer";

/** Starts hidden. The backend shows the window when a PDF opens. */
export async function start(): Promise<{ ui: ReactNode; show: boolean }> {
  return { ui: <PdfViewer />, show: false };
}
