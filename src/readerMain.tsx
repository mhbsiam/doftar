import type { ReactNode } from "react";
import { Reader } from "./components/Reader";

/** Starts hidden. The window shows after it draws the first document. */
export async function start(): Promise<{ ui: ReactNode; show: boolean }> {
  return { ui: <Reader />, show: false };
}
