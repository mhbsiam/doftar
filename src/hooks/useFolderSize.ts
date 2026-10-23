import { useEffect, useState } from "react";
import { api } from "../ipc";
import type { SizeProgress } from "../types";

let nextJob = 1_000_000;

export function useFolderSize(paths: string[], enabled: boolean): SizeProgress | null {
  const [size, setSize] = useState<SizeProgress | null>(null);
  const key = paths.join("\n");
  useEffect(() => {
    if (!enabled) {
      setSize(null);
      return;
    }
    const id = nextJob++;
    let live = true;
    let replied = false;
    setSize(null);
    api
      .folderSize(paths, id, (p) => live && setSize(p))
      .then((p) => live && setSize(p))
      .catch(() => {})
      .finally(() => (replied = true));
    return () => {
      live = false;
      // Only a job still running needs stopping.
      if (!replied) void api.cancelSize(id).catch(() => {});
    };
  }, [key, enabled]);
  return size;
}
