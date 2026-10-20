/**
 * Inline pi extension: `web_preview` — let the agent see the built-in browser.
 *
 * The right-panel browser renders whatever the user (or the agent) loaded, so
 * the agent can verify its own UI work: read the rendered text, or take a
 * screenshot and look at it. Commands travel through lib/browser-bridge.ts to
 * the renderer; when the panel is closed the tool falls back to a plain HTTP
 * text fetch for loopback URLs so it still degrades usefully.
 */
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionFactory,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  BROWSER_PREVIEW_TOOL_NAME,
  getBrowserSnapshot,
  isBrowserPanelConnected,
  requestBrowserCommand,
} from "./browser-bridge.ts";

/** Chars of page text handed to the model by default. */
const DEFAULT_MAX_CHARS = 12_000;
const OPEN_TIMEOUT_MS = 25_000;
const READ_TIMEOUT_MS = 15_000;
const SCREENSHOT_TIMEOUT_MS = 20_000;

const WebPreviewParams = Type.Object({
  action: Type.Union(
    [Type.Literal("read"), Type.Literal("screenshot"), Type.Literal("open")],
    {
      description:
        "read = text content of the current page, screenshot = PNG of the visible viewport, open = navigate the built-in browser.",
    },
  ),
  url: Type.Optional(
    Type.String({
      description:
        "http(s) URL to open first, e.g. http://localhost:5173. Optional for read/screenshot (reads the page already open).",
    }),
  ),
  maxChars: Type.Optional(
    Type.Number({ description: `Max characters of page text to return (default ${DEFAULT_MAX_CHARS}).` }),
  ),
});

function textResult(text: string, details: Record<string, unknown> = {}, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

export function normalizeBrowserUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(\/|$)/i.test(value)) return `http://${value}`;
  return `https://${value}`;
}

export function isLoopbackHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Crude HTML → text, used only by the no-renderer fallback path. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clip(text: string, maxChars: number): { text: string; truncated: boolean } {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

function pageHeader(lines: Array<string | false | null | undefined>): string {
  return lines.filter(Boolean).join("\n");
}

/**
 * No renderer attached (browser-mode dev, or the right panel is collapsed):
 * fetch the loopback dev server directly. Static HTML only — no JS rendering.
 */
async function fetchLoopbackText(url: string, maxChars: number) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "follow" });
  const html = await response.text();
  const { text, truncated } = clip(htmlToText(html), maxChars);
  return textResult(
    pageHeader([
      "The built-in browser panel is not open, so this is a plain HTTP fetch (JavaScript is not executed).",
      `URL: ${url}`,
      `Status: ${response.status} ${response.statusText}`.trim(),
      `--- text ---`,
      text,
      truncated ? `\n[truncated to ${maxChars} chars]` : "",
    ]),
    { url, status: response.status, source: "fetch", truncated },
  );
}

function notConnectedResult(url: string | undefined) {
  const hint = url && isLoopbackHttpUrl(url)
    ? "The plain-fetch fallback could not read it either."
    : "Open the right panel's Browser tab first (or pass a localhost URL).";
  return textResult(
    pageHeader([
      "The built-in browser is not connected: its panel is collapsed or the page never loaded.",
      hint,
      "Screenshots require the desktop browser panel.",
    ]),
    { connected: false },
    true,
  );
}

export function createDesktopBrowserFactory(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: BROWSER_PREVIEW_TOOL_NAME,
      label: "Web Preview",
      description:
        "Inspect the page loaded in PiForge's built-in browser (right panel → 浏览器). " +
        "Use `open` to point it at a dev server URL (http://localhost:PORT), `read` to get the rendered " +
        "text of the current page, and `screenshot` to receive a PNG you can look at. " +
        "Use it to verify UI you just wrote instead of guessing.",
      promptSnippet: "Read or screenshot the page in the built-in browser",
      promptGuidelines: [
        "After starting a dev server with run_bg, open its URL in the built-in browser and screenshot it to verify the UI renders.",
      ],
      parameters: WebPreviewParams,
      async execute(_toolCallId, params) {
        const action = params.action;
        const url = typeof params.url === "string" && params.url.trim() ? normalizeBrowserUrl(params.url) : undefined;
        const maxChars = typeof params.maxChars === "number" ? params.maxChars : DEFAULT_MAX_CHARS;

        if (!isBrowserPanelConnected()) {
          if (action === "read" && url && isLoopbackHttpUrl(url)) {
            try {
              return await fetchLoopbackText(url, maxChars);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return textResult(`Built-in browser is not connected and the fetch failed: ${message}`, { error: message }, true);
            }
          }
          return notConnectedResult(url ?? getBrowserSnapshot()?.url);
        }

        if (action === "open") {
          if (!url) return textResult("`open` needs a `url` parameter.", { error: "missing url" }, true);
          const opened = await requestBrowserCommand({ kind: "open", url }, OPEN_TIMEOUT_MS);
          if (!opened.ok) {
            return textResult(`Could not open ${url} in the built-in browser: ${opened.error ?? "unknown error"}`, { error: opened.error, url }, true);
          }
          return textResult(
            pageHeader([
              "Opened in the built-in browser.",
              `URL: ${opened.url ?? url}`,
              opened.title ? `Title: ${opened.title}` : "",
              "Call this tool with action=read or action=screenshot to inspect it.",
            ]),
            { url: opened.url ?? url, title: opened.title ?? null },
          );
        }

        // read / screenshot may navigate first — one round trip for the agent.
        if (url) {
          const opened = await requestBrowserCommand({ kind: "open", url }, OPEN_TIMEOUT_MS);
          if (!opened.ok) {
            return textResult(`Could not open ${url} in the built-in browser: ${opened.error ?? "unknown error"}`, { error: opened.error, url }, true);
          }
        }

        if (action === "screenshot") {
          const shot = await requestBrowserCommand({ kind: "screenshot" }, SCREENSHOT_TIMEOUT_MS);
          if (!shot.ok || !shot.image?.data) {
            return textResult(`Screenshot failed: ${shot.error ?? "no image returned"}`, { error: shot.error }, true);
          }
          const bytes = Math.round((shot.image.data.length * 3) / 4);
          return {
            content: [
              { type: "image" as const, data: shot.image.data, mimeType: shot.image.mimeType },
              {
                type: "text" as const,
                text: pageHeader([
                  "Screenshot of the built-in browser viewport.",
                  `URL: ${shot.url ?? url ?? "unknown"}`,
                  shot.title ? `Title: ${shot.title}` : "",
                  `Size: ~${Math.round(bytes / 1024)} KB PNG`,
                ]),
              },
            ],
            details: { url: shot.url ?? url ?? null, bytes, source: "webview" },
          };
        }

        const read = await requestBrowserCommand({ kind: "read" }, READ_TIMEOUT_MS);
        if (!read.ok) {
          return textResult(`Could not read the page: ${read.error ?? "unknown error"}`, { error: read.error }, true);
        }
        const { text, truncated } = clip(read.text ?? "", maxChars);
        return textResult(
          pageHeader([
            "Page loaded in the built-in browser.",
            `URL: ${read.url ?? url ?? "unknown"}`,
            read.title ? `Title: ${read.title}` : "",
            "--- rendered text ---",
            text || "(page has no text content)",
            truncated ? `\n[truncated to ${maxChars} chars — pass a larger maxChars for more]` : "",
          ]),
          { url: read.url ?? url ?? null, title: read.title ?? null, truncated, source: "webview" },
        );
      },
    });
  };
}

export function desktopBrowserInlineExtension(): InlineExtension {
  return {
    name: "desktop-browser",
    factory: createDesktopBrowserFactory(),
  };
}
