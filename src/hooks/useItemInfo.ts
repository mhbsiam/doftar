import { useEffect, useState } from "react";
import { api } from "../ipc";
import type { ItemInfo } from "../types";

export function useItemInfo(path: string | null): ItemInfo | null {
  const [info, setInfo] = useState<ItemInfo | null>(null);
  useEffect(() => {
    setInfo(null);
    if (!path) return;
    let live = true;
    api
      .itemInfo(path)
      .then((i) => live && setInfo(i))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path]);
  return info;
}
