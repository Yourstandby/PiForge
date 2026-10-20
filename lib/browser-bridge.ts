/**
 * Type-only re-export for the UI.
 *
 * The bridge runtime lives in the Agent Host (`agent-host/browser-bridge.ts`).
 */
export type {
  BrowserCommand,
  BrowserCommandKind,
  BrowserCommandResult,
  BrowserPageSnapshot,
} from "../contract/domains/browser.ts";
