import type { ReactNode } from "react";
import { PdfViewer } from "./components/PdfViewer";

/**
 * Starts the PDF viewer window. It stays hidden: the backend shows it when a
 * PDF is opened.
 */
export async function start(): Promise<{ ui: ReactNode; show: boolean }> {
  return { ui: <PdfViewer />, show: false };
}
