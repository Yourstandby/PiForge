/**
 * Main ↔ Host browser bridge.
 *
 * Electron Main is the only place a WebContentsView exists. Host tools enqueue
 * BrowserCommands; this client polls them over the existing named pipe (never
 * TCP), executes them with the Main-owned BrowserManager, and posts results
 * back through the same RPC connection.
 */
import type { BrowserCommand, BrowserCommandResult, BrowserManager } from "./browser-manager.ts";

export interface BridgeSocket {
  write(data: string): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  destroy(): void;
}

export interface BrowserHostBridgeOptions {
  endpoint: string;
  token: string;
  connect: (endpoint: string) => BridgeSocket;
  getManager: () => BrowserManager | null;
  onAgentOpen?: (url: string) => void;
  /** Smoke hook; production callers omit it. */
  onCommandResult?: (command: BrowserCommand, result: BrowserCommandResult) => void;
  /** Reserved for future multi-window sharing; passed through, not implemented. */
  windowId?: string;
  ownerId?: string;
  pollMs?: number;
  snapshotMs?: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CALL_TIMEOUT_MS = 10_000;

export class BrowserHostBridge {
  private socket: BridgeSocket | null = null;
  private buffer = "";
  private nextId = 0;
  private pending = new Map<number, PendingCall>();
  private stopped = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly options: BrowserHostBridgeOptions;

  constructor(options: BrowserHostBridgeOptions) {
    this.options = options;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pollTimer = null;
    this.snapshotTimer = null;
    this.reconnectTimer = null;
    this.rejectAll(new Error("Browser bridge stopped"));
    this.socket?.destroy();
    this.socket = null;
  }

  /** Exposed for tests; production calls are internal. */
  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("Browser bridge is not connected"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Host RPC timed out: ${method}`));
      }, CALL_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ kind: "req", id, method, params })}\n`);
    });
  }

  private connect(): void {
    if (this.stopped) return;
    let socket: BridgeSocket;
    try {
      socket = this.options.connect(this.options.endpoint);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.buffer = "";
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("close", () => this.handleClose(socket));
    socket.on("error", () => this.handleClose(socket));
    socket.write(`${JSON.stringify({
      kind: "hello",
      protocolVersion: 1,
      token: this.options.token,
      client: { pid: process.pid, role: "cli" },
    })}\n`);
  }

  private handleData(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (frame.kind === "hello_ok") {
        this.startPolling();
        continue;
      }
      if (frame.kind === "res" && typeof frame.id === "number") {
        const pending = this.pending.get(frame.id);
        if (!pending) continue;
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.ok === false) pending.reject(new Error(String((frame.error as { message?: unknown })?.message ?? "Host RPC failed")));
        else pending.resolve(frame.result);
      }
    }
  }

  private handleClose(socket: BridgeSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.socket = null;
    this.rejectAll(new Error("Browser bridge disconnected"));
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.snapshotTimer = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1_000);
    this.reconnectTimer.unref?.();
  }

  private rejectAll(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private startPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const tick = async () => {
      if (this.stopped || !this.socket) return;
      try {
        const result = (await this.call("browser.poll", {})) as { commands?: BrowserCommand[] };
        for (const command of result.commands ?? []) {
          await this.execute(command);
        }
      } catch {
        // Reconnect logic handles a dead pipe; polling resumes after hello_ok.
      } finally {
        if (!this.stopped && this.socket) {
          this.pollTimer = setTimeout(() => void tick(), this.options.pollMs ?? 700);
          this.pollTimer.unref?.();
        }
      }
    };
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.snapshotTimer = setInterval(() => void this.pushSnapshot(), this.options.snapshotMs ?? 2_500);
    this.snapshotTimer.unref?.();
    void this.pushSnapshot();
    void tick();
  }

  private async execute(command: BrowserCommand): Promise<void> {
    const manager = this.options.getManager();
    if (!manager) {
      await this.postResult({ id: command.id, ok: false, error: "Browser view is not attached" });
      return;
    }
    const enriched = {
      ...command,
      ...(this.options.windowId ? { windowId: this.options.windowId } : {}),
      ...(this.options.ownerId ? { ownerId: this.options.ownerId } : {}),
    };
    if (enriched.kind === "open" && enriched.url) this.options.onAgentOpen?.(enriched.url);
    const result = await manager.executeCommand(enriched);
    await this.postResult(result);
    this.options.onCommandResult?.(enriched, result);
    await this.pushSnapshot();
  }

  private async postResult(result: BrowserCommandResult): Promise<void> {
    try {
      await this.call("browser.resolveCommand", { result });
    } catch {
      // The tool call may have timed out already.
    }
  }

  private async pushSnapshot(): Promise<void> {
    const manager = this.options.getManager();
    if (!manager || !this.socket) return;
    const snapshot = await manager.snapshot();
    if (!snapshot) return;
    const owned = {
      ...snapshot,
      ...(this.options.windowId ? { windowId: this.options.windowId } : {}),
      ...(this.options.ownerId ? { ownerId: this.options.ownerId } : {}),
    };
    try {
      await this.call("browser.pushSnapshot", { snapshot: owned });
    } catch {
      // Best effort; the next tick retries.
    }
  }
}
