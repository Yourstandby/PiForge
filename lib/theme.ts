export const THEMES = ["light", "dark", "glacier"] as const;

export type Theme = (typeof THEMES)[number];

/**
 * Glacier is a blue theme for PiForge. It is layered on top of the dark
 * palette (`dark` stays applied) so dark-only behaviour keeps working.
 */
export function themeClasses(theme: Theme): { dark: boolean; glacier: boolean } {
  return { dark: theme !== "light", glacier: theme === "glacier" };
}

export function normalizeTheme(value: unknown): Theme {
  return value === "dark" || value === "glacier" ? value : "light";
}

/** Cycle order used by the keyboard shortcut: light → dark → glacier → light. */
export function nextTheme(current: Theme): Theme {
  return THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
}
