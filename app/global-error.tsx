"use client";

// Next.js global-error convention: when this boundary activates it REPLACES
// the whole root layout, so it must render its own <html>/<body>, cannot rely
// on globals.css, and cannot consume the i18n context provider (which lives
// inside the layout it replaced). It is the last line of defense when the
// crash originates in the layout/provider itself — without it the window
// stays permanently blank (white-screen fix, see app/error.tsx for the
// in-layout boundary).
// Word lookup therefore goes through the context-free translate() helper from
// lib/i18n, and the locale is resolved from the same localStorage key the
// provider uses. All styling is embedded below (no globals.css).
import { useEffect, useState } from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  normalizePreference,
  resolveLocale,
  translate,
  type Locale,
} from "@/lib/i18n";

const THEME_STORAGE_KEY = "pi-theme";

// Same contract as the inline script in app/layout.tsx (only "dark" maps to
// the dark class). toggle() also clears a stale class if the old document
// element survived the crash.
const themeInitScript = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");var d=document.documentElement;d.classList.toggle("dark",t==="dark"||t==="glacier");d.classList.toggle("theme-glacier",t==="glacier")}catch(e){}})();`;

// Minimal mirror of the app/globals.css palette tokens (Frost / Graphite /
// Haze), self-contained so the error document renders correctly on its own.
const globalStyles = `
  :root {
    --pge-bg: #edf2f8;
    --pge-panel: #ffffff;
    --pge-border: #cbd7e4;
    --pge-text: #24303f;
    --pge-text-strong: #0f1a26;
    --pge-text-muted: #566576;
    --pge-accent: #2b5fd9;
    --pge-accent-hover: #1e4dba;
    --pge-accent-contrast: #ffffff;
    --pge-danger: #b3352e;
    --pge-danger-bg: #f9e8e6;
    --pge-danger-border: #ebc6c2;
    --pge-wash: none;
    --pge-shadow: 0 18px 40px -20px rgba(21, 43, 74, 0.16);
    color-scheme: light;
  }
  html.dark {
    --pge-bg: #0e1013;
    --pge-panel: #1a1e23;
    --pge-border: #2a3037;
    --pge-text: #c7ccd3;
    --pge-text-strong: #f0f3f6;
    --pge-text-muted: #8b929b;
    --pge-accent: #8c9eff;
    --pge-accent-hover: #b0beff;
    --pge-accent-contrast: #0a0c10;
    --pge-danger: #ff9d9d;
    --pge-danger-bg: rgba(255, 157, 157, 0.08);
    --pge-danger-border: rgba(255, 157, 157, 0.28);
    --pge-wash: none;
    --pge-shadow: 0 16px 36px -22px rgba(0, 0, 0, 0.75);
    color-scheme: dark;
  }
  html.dark.theme-glacier {
    --pge-bg: #172631;
    --pge-panel: #233845;
    --pge-border: #334e5e;
    --pge-text: #d3e6f2;
    --pge-text-strong: #eef8ff;
    --pge-text-muted: #9cb8c9;
    --pge-accent: #6fd7ff;
    --pge-accent-hover: #a5e9ff;
    --pge-accent-contrast: #06222c;
    --pge-danger: #ff9fa8;
    --pge-danger-bg: rgba(255, 159, 168, 0.08);
    --pge-danger-border: rgba(255, 159, 168, 0.28);
    /* Glacier-only fog; the other two themes stay flat. */
    --pge-wash:
      radial-gradient(80ch 60ch at 8% -10%, rgba(46, 120, 180, 0.3), transparent 70%),
      radial-gradient(60ch 50ch at 96% 4%, rgba(111, 215, 255, 0.1), transparent 72%);
    --pge-shadow: 0 16px 36px -22px rgba(0, 0, 0, 0.75);
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background-color: var(--pge-bg);
    background-image: var(--pge-wash);
    background-attachment: fixed;
    color: var(--pge-text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .pge-panel {
    width: 100%;
    max-width: 28rem;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 24px;
    border: 1px solid var(--pge-border);
    border-radius: 10px;
    background: var(--pge-panel);
    box-shadow: var(--pge-shadow);
  }
  .pge-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--pge-text-strong);
  }
  .pge-description {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.6;
    color: var(--pge-text-muted);
  }
  .pge-message {
    margin: 0;
    max-height: 10rem;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    padding: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.75rem;
    color: var(--pge-danger);
    background: var(--pge-danger-bg);
    border: 1px solid var(--pge-danger-border);
    border-radius: 6px;
  }
  .pge-digest {
    margin: 0;
    font-size: 0.75rem;
    color: var(--pge-text-muted);
    opacity: 0.75;
  }
  .pge-footer { display: flex; justify-content: flex-end; }
  .pge-button {
    cursor: pointer;
    padding: 6px 12px;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--pge-accent-contrast);
    background: var(--pge-accent);
    border: none;
    border-radius: 4px;
    transition: background-color 0.15s ease;
  }
  .pge-button:hover { background: var(--pge-accent-hover); }
`;

// Context-free locale detection: mirrors the i18n provider's hydration logic
// (stored preference, then browser languages, then default) without React
// context, which is unavailable outside the replaced layout.
function detectLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const preference = normalizePreference(localStorage.getItem(LOCALE_STORAGE_KEY));
    const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
    return resolveLocale(preference, languages);
  } catch {
    return DEFAULT_LOCALE;
  }
}

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  // Resolve after mount: keeps SSR markup stable (default locale) and avoids
  // a hydration mismatch, mirroring the provider's own hydration behavior.
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    setLocale(detectLocale());
    console.error("[global-error-boundary]", error);
  }, [error]);

  return (
    // suppressHydrationWarning: the theme script above mutates <html> before
    // hydration, exactly like app/layout.tsx.
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
      </head>
      <body>
        <div className="pge-panel">
          <h2 className="pge-title">{translate(locale, "error.title")}</h2>
          <p className="pge-description">{translate(locale, "error.description")}</p>
          <pre className="pge-message">{error.message}</pre>
          {error.digest ? (
            <p className="pge-digest">
              {translate(locale, "error.digest", { digest: error.digest })}
            </p>
          ) : null}
          <div className="pge-footer">
            <button type="button" onClick={() => retry()} className="pge-button">
              {translate(locale, "error.reload")}
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
