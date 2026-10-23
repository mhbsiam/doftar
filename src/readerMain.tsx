import type { ReactNode } from "react";
import { Reader } from "./components/Reader";

/**
 * Starts the reader window. It stays hidden until it has drawn the
 * first document.
 */
export async function start(): Promise<{ ui: ReactNode; show: boolean }> {
  return { ui: <Reader />, show: false };
}
