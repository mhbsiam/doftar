import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

/** Downloading cloud files by path, with progress from 0 to 1. */
export const useDownloads = create<Record<string, number>>(() => ({}));

void listen<{ path: string; fraction: number }[]>("cloud:downloads", ({ payload }) =>
  useDownloads.setState(Object.fromEntries(payload.map((d) => [d.path, d.fraction])), true)
).catch(() => {});
