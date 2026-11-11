import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSettings, type ThemePref } from "../stores/settings";
import { applyTextScale } from "../util/textScale";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function resolveTheme(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return darkQuery.matches ? "dark" : "light";
}

export function useResolvedTheme(override?: ThemePref | null): "light" | "dark" {
  const stored = useSettings((s) => s.theme);
  const pref = override ?? stored;
  const [systemDark, setSystemDark] = useState(darkQuery.matches);
  useEffect(() => {
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    darkQuery.addEventListener("change", onChange);
    return () => darkQuery.removeEventListener("change", onChange);
  }, []);
  if (pref !== "system") return pref;
  return systemDark ? "dark" : "light";
}

/**
 * `useResolvedTheme` for a viewer window. It follows theme and text size changes from other windows.
 * It applies them and does not save them. The settings copy of this window is old, so a save would overwrite newer changes.
 */
export function useViewerTheme(): "light" | "dark" {
  const [live, setLive] = useState<ThemePref | null>(null);
  useEffect(() => {
    const un = listen<{ state: { theme?: ThemePref; textScale?: number } }>(
      "sync:settings",
      ({ payload }) => {
        const { theme, textScale } = payload.state;
        if (theme) setLive(theme);
        if (textScale) applyTextScale(textScale);
      }
    );
    return () => void un.then((f) => f());
  }, []);
  return useResolvedTheme(live);
}
