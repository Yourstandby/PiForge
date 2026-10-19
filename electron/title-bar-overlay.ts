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
  light: { color: "#f7fafe", symbolColor: "#24303f" },
  dark: { color: "#0b0d10", symbolColor: "#c7ccd3" },
  glacier: { color: "#13212b", symbolColor: "#d3e6f2" },
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
