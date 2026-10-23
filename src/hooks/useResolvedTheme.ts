import { useEffect, useState } from "react";
import { useSettings, type ThemePref } from "../stores/settings";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function resolveTheme(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return darkQuery.matches ? "dark" : "light";
}

export function useResolvedTheme(): "light" | "dark" {
  const pref = useSettings((s) => s.theme);
  const [systemDark, setSystemDark] = useState(darkQuery.matches);
  useEffect(() => {
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    darkQuery.addEventListener("change", onChange);
    return () => darkQuery.removeEventListener("change", onChange);
  }, []);
  if (pref !== "system") return pref;
  return systemDark ? "dark" : "light";
}
