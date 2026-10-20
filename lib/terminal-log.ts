/**
 * Ring buffer of shell output for the right-panel "终端" tab.
 *
 * `run_bg` processes already stream through lib/managed-processes.ts; this
 * module covers the *other* shell surface: the agent's regular `bash` /
 * `powershell` tool calls, which would otherwise only be visible in the
 * transcript. The inline extension (desktop-terminal-extension.ts) writes here
 * on `tool_call` / `tool_result`; the panel reads it over SSE.
 *
 * ANSI escape sequences are kept verbatim so the client can render colors.
 * State lives on globalThis so Next.js hot reloads do not clear the log.
 */
import { randomUUID } from "node:crypto";

export type TerminalBlockStatus = "running" | "ok" | "error";

export interface TerminalBlock {
  id: string;
  /** The command line (or process command) shown as the block header. */
  title: string;
  cwd: string | null;
  /** Raw stdout/stderr, ANSI sequences included. */
  text: string;
  status: TerminalBlockStatus;
  at: number;
  updatedAt: number;
}

export const TERMINAL_MAX_BLOCKS = 120;
export const TERMINAL_MAX_TEXT = 60_000;

interface TerminalLogState {
  blocks: TerminalBlock[];
  listeners: Set<() => void>;
}

declare global {
  var __piTerminalLog: TerminalLogState | undefined;
}

function state(): TerminalLogState {
  if (!globalThis.__piTerminalLog) {
    globalThis.__piTerminalLog = { blocks: [], listeners: new Set() };
  }
  return globalThis.__piTerminalLog;
}

function notify(): void {
  for (const listener of state().listeners) {
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

/** Subscribe to log changes (the SSE route uses this). */
export function onTerminalLogChange(listener: () => void): () => void {
  const listeners = state().listeners;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function listTerminalBlocks(): TerminalBlock[] {
  return state().blocks.map((block) => ({ ...block }));
}

function trimBlocks(blocks: TerminalBlock[]): TerminalBlock[] {
  if (blocks.length <= TERMINAL_MAX_BLOCKS) return blocks;
  return blocks.slice(blocks.length - TERMINAL_MAX_BLOCKS);
}

/** A shell command started: show it immediately with a running status. */
export function startShellBlock(input: {
  /** Tool call id; reused by the matching result so the block updates in place. */
  id?: string;
  command: string;
  cwd?: string | null;
}): TerminalBlock {
  const blocks = state().blocks;
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
  state().blocks = trimBlocks([...blocks, block]);
  notify();
  return { ...block };
}

/** Result arrived: fill in the captured output and final status. */
export function finishShellBlock(input: {
  id: string;
  text?: string;
  status?: TerminalBlockStatus;
}): TerminalBlock | null {
  const blocks = state().blocks;
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
  const block = state().blocks.find((item) => item.id === id);
  if (!block || !text) return;
  block.text = text.slice(-TERMINAL_MAX_TEXT);
  block.updatedAt = Date.now();
  notify();
}

/** Append a delta chunk for callers that stream incrementally. */
export function appendShellOutput(id: string, chunk: string): void {
  const block = state().blocks.find((item) => item.id === id);
  if (!block) return;
  block.text = appendText(block.text, chunk);
  block.updatedAt = Date.now();
  notify();
}

export function clearTerminalLog(): void {
  state().blocks = [];
  notify();
}

/** Test helper: reset all state. */
export function resetTerminalLogForTest(): void {
  globalThis.__piTerminalLog = undefined;
}
