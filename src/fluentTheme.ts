import {
  createDarkTheme,
  createLightTheme,
  type Theme,
} from "@fluentui/react-components";
import type { FolderColorId } from "./util/folderColors";
import { accentFor } from "./util/accent";

const bridge: Partial<Theme> = {
  colorNeutralBackground1: "var(--menu-solid)",
  colorNeutralBackground1Hover: "var(--bg-hover)",
  colorNeutralBackground1Pressed: "var(--bg-active)",
  colorNeutralForeground1: "var(--text)",
  colorNeutralForeground2: "var(--text)",
  colorNeutralForeground3: "var(--text-2)",
  colorNeutralStroke1: "var(--border-strong)",
  colorNeutralStroke2: "var(--border)",
  colorSubtleBackgroundHover: "var(--bg-hover)",
  colorSubtleBackgroundPressed: "var(--bg-active)",
  colorBrandBackground: "var(--accent-btn)",
  colorBrandBackgroundHover: "var(--accent-btn-hover)",
  colorBrandBackgroundPressed: "var(--accent-btn-active)",
  colorNeutralForegroundOnBrand: "var(--on-accent)",
  colorBrandForeground1: "var(--accent)",
  colorBrandForegroundLink: "var(--accent)",
  colorStrokeFocus2: "var(--focus)",
  // Fluent's defaults name Segoe UI first; use the app's system font stack.
  fontFamilyBase: "var(--font)",
  fontFamilyMonospace: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontFamilyNumeric: "var(--font)",
};

const themes = new Map<string, Theme>();

/**
 * Fluent's theme with its brand ramp in the accent's hue, so Fluent's own
 * brand colors (focus underlines, links, compound buttons) match the app.
 */
export function fluentTheme(mode: "light" | "dark", folderColor: FolderColorId): Theme {
  const key = `${mode}:${folderColor}`;
  let theme = themes.get(key);
  if (!theme) {
    const { ramp } = accentFor(folderColor, mode);
    theme = { ...(mode === "light" ? createLightTheme(ramp) : createDarkTheme(ramp)), ...bridge };
    themes.set(key, theme);
  }
  return theme;
}
