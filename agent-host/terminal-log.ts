/**
 * Ring buffer of shell output for the right-panel "终端" tab.
 *
 * Owned by the Agent Host after the Step 1 migration. The desktop terminal
 * extension (still running in the Next process until the Pi SDK moves) mirrors
 * `bash` / `powershell` tool calls here over RPC.
 *
 * ANSI escape sequences are kept verbatim so the client can render colors.
 */
import { randomUUID } from "node:crypto";
import type {
  TerminalBlock,
  TerminalBlockStatus,
} from "../contract/domains/terminal.ts";

export const TERMINAL_MAX_BLOCKS = 120;
export const TERMINAL_MAX_TEXT = 60_000;

let blocks: TerminalBlock[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("terminal-log listener failed:", error);
    }
  }
}

/** Append keeping only the tail, so a chatty command cannot balloon memory. */
function appendText(current: string, chunk: string): string {
  const next = current ? `${current}${chunk}` : chunk;
  if (next.length <= TERMINAL_MAX_TEXT) return next;
  return next.slice(next.length - TERMINAL_MAX_TEXT);
}

/** Subscribe to log changes (the host event broadcaster uses this). */
export function onTerminalLogChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function listTerminalBlocks(): TerminalBlock[] {
  return blocks.map((block) => ({ ...block }));
}

function trimBlocks(next: TerminalBlock[]): TerminalBlock[] {
  if (next.length <= TERMINAL_MAX_BLOCKS) return next;
  return next.slice(next.length - TERMINAL_MAX_BLOCKS);
}

/** A shell command started: show it immediately with a running status. */
export function startShellBlock(input: {
  /** Tool call id; reused by the matching result so the block updates in place. */
  id?: string;
  command: string;
  cwd?: string | null;
}): TerminalBlock {
  const id = input.id ?? randomUUID();
  const existing = blocks.find((block) => block.id === id);
  const now = Date.now();
  if (existing) {
    existing.title = input.command;
    existing.status = "running";
    existing.updatedAt = now;
    notify();
    return { ...existing };
  }

  const block: TerminalBlock = {
    id,
    title: input.command.slice(0, 2_000),
    cwd: input.cwd ?? null,
    text: "",
    status: "running",
    at: now,
    updatedAt: now,
  };
  blocks = trimBlocks([...blocks, block]);
  notify();
  return { ...block };
}

/** Result arrived: fill in the captured output and final status. */
export function finishShellBlock(input: {
  id: string;
  text?: string;
  status?: TerminalBlockStatus;
}): TerminalBlock | null {
  const block = blocks.find((item) => item.id === input.id);
  if (!block) return null;
  // The tool result is the complete output, not a delta: replace whatever the
  // streaming updates already painted instead of appending a duplicate.
  if (input.text) block.text = input.text.slice(-TERMINAL_MAX_TEXT);
  block.status = input.status ?? "ok";
  block.updatedAt = Date.now();
  notify();
  return { ...block };
}

/**
 * Streaming snapshot for a running shell call. pi throttles these updates and
 * each one carries the accumulated output, so the block text is replaced.
 */
export function setShellOutput(id: string, text: string): void {
  const block = blocks.find((item) => item.id === id);
  if (!block || !text) return;
  block.text = text.slice(-TERMINAL_MAX_TEXT);
  block.updatedAt = Date.now();
  notify();
}

/** Append a delta chunk for callers that stream incrementally. */
export function appendShellOutput(id: string, chunk: string): void {
  const block = blocks.find((item) => item.id === id);
  if (!block) return;
  block.text = appendText(block.text, chunk);
  block.updatedAt = Date.now();
  notify();
}

export function clearTerminalLog(): void {
  blocks = [];
  notify();
}

/** Test helper: reset all state. */
export function resetTerminalLogForTest(): void {
  blocks = [];
  listeners.clear();
}
