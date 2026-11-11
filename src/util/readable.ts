import { api } from "../ipc";
import { extOf, isDataFile, isMarkdown, isPlainText } from "./kinds";

/** A text extension can belong to a binary format too, for example .ts video. */
export async function readable(path: string): Promise<boolean> {
  const ext = extOf(path);
  return isMarkdown(ext) || isDataFile(ext) || (isPlainText(ext) && (await api.isTextFile(path).catch(() => false)));
}
