/**
 * 界面明暗（夜晚模式）的唯一写入口。
 *
 * 令牌与字面量映射都在 `app/globals.css` 的 `:root[data-theme="dark"]` 里，
 * 这里只负责：解析偏好（跟随系统 / 浅色 / 深色）→ 把结果写到
 * `<html data-theme>` + `color-scheme`，并持久化到 localStorage。
 *
 * 首屏防闪烁由 `app/layout.tsx` 里的内联脚本负责（在 React 之前跑一次），
 * 之后由 `components/ThemeBoot.tsx` 挂载时再校正并监听系统主题变化。
 */
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "pi-theme";

export const THEME_OPTIONS: ReadonlyArray<{
  label: string;
  value: ThemePreference;
}> = [
  { label: "跟随系统", value: "system" },
  { label: "浅色", value: "light" },
  { label: "深色", value: "dark" },
];

export function readStoredTheme(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw === "light" || raw === "dark" || raw === "system"
      ? raw
      : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") return preference;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  }
  return resolved;
}

export function saveThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // private mode / restricted storage
  }
}

/**
 * 跟随系统时订阅 prefers-color-scheme 变化。返回取消订阅函数。
 * 偏好不是 `system` 时不做任何事。
 */
export function watchSystemTheme(
  preference: ThemePreference,
  onChange: (resolved: ResolvedTheme) => void,
): () => void {
  if (preference !== "system" || typeof window === "undefined") return () => {};
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!media) return () => {};
  const listener = (event: MediaQueryListEvent) =>
    onChange(event.matches ? "dark" : "light");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
