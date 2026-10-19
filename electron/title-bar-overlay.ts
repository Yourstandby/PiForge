export interface TitleBarOverlayTarget {
  setTitleBarOverlay?: (options: {
    color: string;
    symbolColor: string;
  }) => void;
}

export type TitleBarTheme = "light" | "dark" | "glacier";

interface OverlayColors {
  color: string;
  symbolColor: string;
}

const OVERLAY_COLORS: Record<TitleBarTheme, OverlayColors> = {
  light: { color: "#ffffff", symbolColor: "#364152" },
  dark: { color: "#0c1118", symbolColor: "#d9deea" },
  glacier: { color: "#070d18", symbolColor: "#c9d9ee" },
};

export function normalizeTitleBarTheme(value: unknown): TitleBarTheme {
  return value === "glacier" || value === "dark" ? value : "light";
}

/**
 * Updates window controls where the Electron runtime exposes title-bar overlays.
 * The API is unavailable on macOS and may be absent in some Electron builds.
 */
export function applyTitleBarOverlayTheme(
  target: TitleBarOverlayTarget | null,
  theme: unknown,
): boolean {
  if (typeof target?.setTitleBarOverlay !== "function") {
    return false;
  }

  target.setTitleBarOverlay(OVERLAY_COLORS[normalizeTitleBarTheme(theme)]);
  return true;
}
