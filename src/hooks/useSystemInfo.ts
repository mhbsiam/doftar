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
    void api.watchPath("/Volumes").catch(() => {});
    const unlisten = listen<string>("fs:changed", (ev) => {
      if (ev.payload === "/Volumes" || ev.payload.startsWith("/Volumes/")) {
        load();
      }
    });
    return () => {
      cancelled = true;
      void unlisten.then((f) => f());
      void api.unwatchPath("/Volumes").catch(() => {});
    };
  }, []);

  return info;
}
