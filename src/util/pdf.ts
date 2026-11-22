import { convertFileSrc } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

/**
 * pdf.js draws PDFs in the webview itself, so the viewer window and the preview bar work
 * without a native document view. The legacy build avoids syntax and APIs WebKitGTK lacks.
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };

/** One opened PDF. Destroy it when it stops being shown, so the worker frees its memory. */
export type PdfDocument = pdfjs.PDFDocumentProxy;

/** Width and height of a page at 1:1, in CSS pixels. */
export interface PageSize {
  w: number;
  h: number;
}

/** Asked when a document is locked. Call `ask` with the password to keep loading. */
export type PasswordAsk = (ask: (password: string) => void, wrong: boolean) => void;

/**
 * Open `path`. `onPassword` is called when the file is locked; call its first argument with the
 * password to keep loading, and it is called again with `wrong` if that one didn't open it.
 * Destroy the task to stop a load that is still running.
 */
export function openDoc(path: string, onPassword?: PasswordAsk): pdfjs.PDFDocumentLoadingTask {
  const params = {
    url: convertFileSrc(path),
    // CJK text needs the packed cmaps, font-substituted PDFs the standard fonts, and
    // JPEG2000 images the wasm decoders (served or copied by vite.config.ts).
    cMapUrl: `${import.meta.env.BASE_URL}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${import.meta.env.BASE_URL}standard_fonts/`,
    wasmUrl: `${import.meta.env.BASE_URL}wasm/`,
  };
  if (onPassword) {
    // The typings only know a plain password, but the runtime takes the callback.
    (params as { password?: unknown }).password = (ask: (password: string) => void, reason: number) =>
      onPassword(ask, reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
  }
  return pdfjs.getDocument(params);
}

/** The size of every page, read one by one. A 1000-page document takes a moment. */
export async function pageSizes(doc: PdfDocument): Promise<PageSize[]> {
  const sizes: PageSize[] = [];
  for (let i = 0; i < doc.numPages; i++) {
    const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
  }
  return sizes;
}

/** What a failed open means. `"need"` asks for a password, `"wrong"` says the last one didn't open it. */
export function passwordProblem(err: unknown): "need" | "wrong" | null {
  // The error class is not exported, so the name tells.
  if ((err as { name?: string } | null)?.name !== "PasswordException") return null;
  return (err as { code?: number }).code === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? "wrong" : "need";
}
