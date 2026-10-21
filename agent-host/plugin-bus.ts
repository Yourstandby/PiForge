/**
 * Authenticated WebSocket client used by the Host on behalf of plugins.
 *
 * Plugins never receive a socket or the launch token. They call the frozen
 * `api.hostCall` / `api.publish` wrappers; this module carries those calls over
 * the same local WS bus the UI can attach to.
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "../contract/protocol.ts";

const CALL_TIMEOUT_MS = 10_000;
const RECONNECT_MS = 500;

export interface PluginBus {
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  publish(topic: string, payload: unknown): void;
  /** Register a handler for events relayed by peers (UI/other plugins). */
  onEvent(handler: (topic: string, payload: unknown) => void): () => void;
  close(): void;
  readonly connected: boolean;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createPluginBus(url: string, token: string, log: (message: string) => void = () => {}): PluginBus {
  let socket: WebSocket | null = null;
  let closed = false;
  let authed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<string, PendingCall>();
  const eventHandlers = new Set<(topic: string, payload: unknown) => void>();

  function rejectPending(error: Error): void {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    pending.clear();
  }

  function connect(): void {
    if (closed) return;
    const ws = new WebSocket(url);
    socket = ws;
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", token, protocolVersion: PROTOCOL_VERSION }));
    });
    ws.on("message", (data) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.type === "hello_ok") {
        authed = true;
        log("plugin bus connected");
        return;
      }
      if (message.type === "call_result") {
        const id = typeof message.id === "string" ? message.id : "";
        const call = pending.get(id);
        if (!call) return;
        pending.delete(id);
        clearTimeout(call.timer);
        if (message.ok === true) call.resolve(message.result);
        else {
          const error = message.error as { message?: unknown } | undefined;
          call.reject(new Error(typeof error?.message === "string" ? error.message : "plugin bus call failed"));
        }
        return;
      }
      if (message.type === "event" && typeof message.topic === "string") {
        for (const handler of [...eventHandlers]) {
          try {
            handler(message.topic, message.payload);
          } catch (error) {
            log(`plugin event handler failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return;
      }
      if (message.type === "error") {
        log(`plugin bus error: ${String(message.message ?? message.code ?? "unknown")}`);
      }
    });
    ws.on("close", () => {
      authed = false;
      socket = null;
      rejectPending(new Error("plugin bus disconnected"));
      if (!closed) {
        reconnectTimer = setTimeout(connect, RECONNECT_MS);
        reconnectTimer.unref?.();
      }
    });
    ws.on("error", (error) => {
      log(`plugin bus socket error: ${error.message}`);
    });
  }

  connect();

  return {
    get connected() {
      return authed && socket !== null && socket.readyState === WebSocket.OPEN;
    },

    call(method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
      if (closed) return Promise.reject(new Error("plugin bus is closed"));
      if (!socket || !authed) return Promise.reject(new Error("plugin bus is not connected"));
      const id = randomUUID();
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`plugin host call timed out: ${method}`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        try {
          socket!.send(JSON.stringify({ type: "call", id, method, params }));
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    publish(topic, payload) {
      if (closed || !socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify({ type: "event", topic, payload }));
      } catch {
        // Reconnect will be handled by the close listener.
      }
    },

    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },

    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      rejectPending(new Error("plugin bus closed"));
      try {
        socket?.close();
      } catch {
        // already closed
      }
      socket = null;
    },
  };
}
