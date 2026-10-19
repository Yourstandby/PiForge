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

/**
 * Height of the custom title bar. `components/TitleBar.tsx` draws a matching
 * 36px drag strip (`h-9`), so keep the two in sync.
 */
export const TITLE_BAR_OVERLAY_HEIGHT = 36;

/**
 * Window-control colors. `light` matches the rebuilt Frost Ledger palette:
 * the title bar surface (#f5f5f7, same as the side rails) with ink-soft glyphs.
 */
const OVERLAY_COLORS: Record<TitleBarTheme, OverlayColors> = {
  light: { color: "#f5f5f7", symbolColor: "#374151" },
  dark: { color: "#0b0d10", symbolColor: "#c7ccd3" },
  glacier: { color: "#13212b", symbolColor: "#d3e6f2" },
};

export function normalizeTitleBarTheme(value: unknown): TitleBarTheme {
  return value === "glacier" || value === "dark" ? value : "light";
}

/** Window options for `new BrowserWindow({ titleBarOverlay })`. */
export function titleBarOverlayOptions(theme: TitleBarTheme = "light") {
  return { ...OVERLAY_COLORS[theme], height: TITLE_BAR_OVERLAY_HEIGHT };
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
