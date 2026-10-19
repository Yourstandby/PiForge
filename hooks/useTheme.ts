"use client";

import { useCallback, useSyncExternalStore, useEffect } from "react";
import { nextTheme, normalizeTheme, themeClasses, type Theme } from "@/lib/theme";

const THEME_STORAGE_KEY = "pi-theme";
const GLACIER_CLASS = "theme-glacier";

const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function readTheme(): Theme {
  if (typeof document === "undefined") return "light";
  const root = document.documentElement;
  if (root.classList.contains(GLACIER_CLASS)) return "glacier";
  return root.classList.contains("dark") ? "dark" : "light";
}

function getSnapshot(): Theme {
  return readTheme();
}

function getServerSnapshot(): Theme {
  return "light";
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const classes = themeClasses(theme);
  root.classList.toggle("dark", classes.dark);
  root.classList.toggle(GLACIER_CLASS, classes.glacier);

  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
  listeners.forEach((cb) => cb());
}

type ToggleOrigin = { x: number; y: number };

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setTheme = useCallback((next: Theme, origin?: ToggleOrigin) => {
    if (next === readTheme()) return;

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const supportsVT = typeof document.startViewTransition === "function";

    if (!supportsVT || reduceMotion) {
      applyTheme(next);
      return;
    }

    const x = origin?.x ?? window.innerWidth / 2;
    const y = origin?.y ?? window.innerHeight / 2;
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    );

    const transition = document.startViewTransition(() => applyTheme(next));
    transition.ready
      .then(() => {
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${endRadius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 250,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => {
        // transition cancelled — ignore
      });
  }, []);

  const toggleTheme = useCallback((origin?: ToggleOrigin) => {
    setTheme(nextTheme(readTheme()), origin);
  }, [setTheme]);

  useEffect(() => {
    const customWindow = window as Window & {
      electronAPI?: {
        setTheme?: (theme: Theme) => void;
      };
    };
    customWindow.electronAPI?.setTheme?.(normalizeTheme(theme));
  }, [theme]);

  return { theme, setTheme, toggleTheme, isDark: theme !== "light" };
}
