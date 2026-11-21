import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../ipc";
import type { SystemInfo } from "../types";

export function useSystemInfo(): SystemInfo | null {
  const [info, setInfo] = useState<SystemInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .systemInfo()
        .then((i) => {
          if (!cancelled) setInfo(i);
        })
        .catch(() => {});
    load();
    const roots = ["/media", "/run/media", "/mnt"];
    for (const r of roots) void api.watchPath(r).catch(() => {});
    const unlisten = listen<string>("fs:changed", (ev) => {
      if (roots.some((r) => ev.payload === r || ev.payload.startsWith(`${r}/`))) {
        load();
      }
    });
    return () => {
      cancelled = true;
      void unlisten.then((f) => f());
      for (const r of roots) void api.unwatchPath(r).catch(() => {});
    };
  }, []);

  return info;
}
