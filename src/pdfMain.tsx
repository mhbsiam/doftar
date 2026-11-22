import type { ReactNode } from "react";
import { ON_LINUX } from "./util/platform";

/** Starts hidden. The backend shows the window when a PDF opens. */
export async function start(): Promise<{ ui: ReactNode; show: boolean }> {
  // macOS draws the document with a native PDFKit view; Linux draws it with pdf.js.
  const { PdfViewer } = ON_LINUX ? await import("./components/PdfJsViewer") : await import("./components/PdfViewer");
  return { ui: <PdfViewer />, show: false };
}
