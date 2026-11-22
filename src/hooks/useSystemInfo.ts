import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../ipc";
import type { SystemInfo } from "../types";
import { ON_LINUX } from "../util/platform";

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
    // Where drives mount.
    const roots = ON_LINUX ? ["/media", "/run/media", "/mnt"] : ["/Volumes"];
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
