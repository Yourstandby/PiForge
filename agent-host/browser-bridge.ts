/**
 * Bridge between the renderer's built-in browser panel and the agent tool
 * `web_preview`.
 *
 * Runs inside the Agent Host. The live page still lives in the Electron
 * renderer's `<webview>`; the renderer polls the Next proxy, which forwards
 * polls/snapshots/results here. No network layer, no queue server.
 */
import { randomUUID } from "node:crypto";
import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserPageSnapshot,
} from "../contract/domains/browser.ts";

export type {
  BrowserCommand,
  BrowserCommandKind,
  BrowserCommandResult,
  BrowserPageSnapshot,
} from "../contract/domains/browser.ts";

export const BROWSER_PREVIEW_TOOL_NAME = "web_preview";

/** Hard cap on the page text kept in a snapshot (defensive, renderer is trusted). */
export const BROWSER_TEXT_LIMIT = 120_000;
/** A renderer that has not polled for this long is treated as disconnected. */
export const BROWSER_CONNECTED_WINDOW_MS = 5_000;
/** Bound the queue so a stuck renderer cannot grow it without limit. */
export const BROWSER_MAX_PENDING_COMMANDS = 8;

interface BrowserBridgeState {
  snapshot: BrowserPageSnapshot | null;
  pending: BrowserCommand[];
  waiters: Map<string, (result: BrowserCommandResult) => void>;
  lastPollAt: number;
}

let bridgeState: BrowserBridgeState | null = null;

function bridge(): BrowserBridgeState {
  if (!bridgeState) {
    bridgeState = {
      snapshot: null,
      pending: [],
      waiters: new Map(),
      lastPollAt: 0,
    };
  }
  return bridgeState;
}

function clipText(text: string): { text: string; truncated: boolean } {
  if (text.length <= BROWSER_TEXT_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, BROWSER_TEXT_LIMIT), truncated: true };
}

/** Latest page snapshot pushed by the renderer, or null when never reported. */
export function getBrowserSnapshot(): BrowserPageSnapshot | null {
  return bridge().snapshot;
}

/** True while the browser panel is alive and polling the bridge. */
export function isBrowserPanelConnected(now: number = Date.now()): boolean {
  const state = bridge();
  if (!state.snapshot && state.lastPollAt === 0) return false;
  return now - state.lastPollAt <= BROWSER_CONNECTED_WINDOW_MS;
}

/** Mark the renderer as alive (called by the GET handler). */
export function recordBrowserPoll(now: number = Date.now()): void {
  bridge().lastPollAt = now;
}

/** Store a renderer-pushed snapshot, normalizing every field. */
export function pushBrowserSnapshot(input: Partial<BrowserPageSnapshot>): BrowserPageSnapshot | null {
  const url = typeof input.url === "string" ? input.url.slice(0, 2048) : "";
  const rawText = typeof input.text === "string" ? input.text : "";
  if (!url && !rawText) return null;

  const { text, truncated } = clipText(rawText);
  const viewport = input.viewport && typeof input.viewport.width === "number" && typeof input.viewport.height === "number"
    ? { width: Math.round(input.viewport.width), height: Math.round(input.viewport.height) }
    : null;

  const snapshot: BrowserPageSnapshot = {
    url,
    title: typeof input.title === "string" ? input.title.slice(0, 512) : "",
    text,
    truncated: truncated || input.truncated === true,
    native: input.native !== false,
    webContentsId: typeof input.webContentsId === "number" ? input.webContentsId : null,
    viewport,
    scrollY: typeof input.scrollY === "number" ? input.scrollY : 0,
    updatedAt: Date.now(),
  };
  bridge().snapshot = snapshot;
  return snapshot;
}

/** Drain commands waiting for the renderer. */
export function takeBrowserCommands(): BrowserCommand[] {
  const state = bridge();
  const commands = state.pending;
  state.pending = [];
  return commands;
}

/** Enqueue a command for the renderer and wait (bounded) for its result. */
export function requestBrowserCommand(
  command: Omit<BrowserCommand, "id">,
  timeoutMs = 10_000,
): Promise<BrowserCommandResult> {
  const state = bridge();
  const id = randomUUID();
  const pendingCommand: BrowserCommand = { id, ...command };

  state.pending.push(pendingCommand);
  if (state.pending.length > BROWSER_MAX_PENDING_COMMANDS) {
    const dropped = state.pending.shift();
    if (dropped) state.waiters.get(dropped.id)?.({ id: dropped.id, ok: false, error: "Browser panel is busy" });
    if (dropped) state.waiters.delete(dropped.id);
  }

  return new Promise<BrowserCommandResult>((resolve) => {
    const settle = (result: BrowserCommandResult) => {
      const current = state.waiters.get(id);
      if (current !== settle) return;
      state.waiters.delete(id);
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      settle({ id, ok: false, error: `Browser panel did not answer within ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    // Never keep the Node event loop alive for a pending command.
    (timer as unknown as { unref?: () => void }).unref?.();

    state.waiters.set(id, settle);
  });
}

/** Deliver a renderer result to the waiting tool call. */
export function resolveBrowserCommand(result: BrowserCommandResult): boolean {
  const state = bridge();
  const waiter = state.waiters.get(result.id);
  if (!waiter) return false;
  waiter(result);
  return true;
}

/** Test helper: reset all bridge state. */
export function resetBrowserBridgeForTest(): void {
  bridgeState = null;
}
