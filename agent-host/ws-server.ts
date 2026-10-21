/**
 * Local WebSocket bus (v0.7.0 module 1).
 *
 * Bound to 127.0.0.1 with an OS-assigned port, so multiple app instances and
 * tests never collide. Authentication reuses the Agent Host launch token:
 * clients must send a hello frame before any other message.
 *
 * Transport only: plugin execution and RPC dispatch stay in plugin-manager.ts
 * and server.ts. This module never exposes Node built-ins to clients.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../contract/protocol.ts";
import type { HostTransportInfo } from "../contract/domains/providers.ts";

const HELLO_TIMEOUT_MS = 5_000;
const MAX_MESSAGE_BYTES = 1_000_000;
const MAX_CLIENTS = 32;

export interface WsCallRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export type WsCallHandler = (
  request: WsCallRequest,
  client: { id: number; remote: string },
) => Promise<unknown>;

export interface HostWebSocketServer {
  start(): Promise<void>;
  close(): Promise<void>;
  info(): HostTransportInfo;
  /** Broadcast a JSON event to authenticated clients. */
  publish(topic: string, payload: unknown): void;
}

export interface HostWebSocketOptions {
  token: string;
  onCall?: WsCallHandler;
  log?: (message: string) => void;
}

interface ClientState {
  id: number;
  socket: WebSocket;
  authed: boolean;
  helloTimer: NodeJS.Timeout | null;
  remote: string;
}

function safeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function remoteOf(request: IncomingMessage): string {
  const address = request.socket.remoteAddress ?? "unknown";
  const port = request.socket.remotePort ?? 0;
  return `${address}:${port}`;
}

export function createHostWebSocketServer(
  options: HostWebSocketOptions,
): HostWebSocketServer {
  const log = options.log ?? (() => {});
  const clients = new Map<number, ClientState>();
  let server: WebSocketServer | null = null;
  let nextClientId = 0;
  let port: number | null = null;

  function send(socket: WebSocket, message: unknown): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The close handler removes the client.
    }
  }

  function broadcast(message: unknown): void {
    for (const client of clients.values()) {
      if (client.authed) send(client.socket, message);
    }
  }

  function closeClient(client: ClientState, code: number, reason: string): void {
    if (client.helloTimer) clearTimeout(client.helloTimer);
    client.helloTimer = null;
    clients.delete(client.id);
    try {
      client.socket.close(code, reason);
    } catch {
      // already closed
    }
  }

  async function handleMessage(client: ClientState, raw: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      send(client.socket, { type: "error", code: "E_INVALID_JSON", message: "invalid JSON" });
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      send(client.socket, { type: "error", code: "E_INVALID_PARAMS", message: "message must be an object" });
      return;
    }
    const record = message as Record<string, unknown>;
    const type = record.type;
    if (type === "hello") {
      if (client.authed) return;
      if (record.protocolVersion !== undefined && record.protocolVersion !== PROTOCOL_VERSION) {
        closeClient(client, 1008, "protocol mismatch");
        return;
      }
      if (typeof record.token !== "string" || !safeEqual(record.token, options.token)) {
        closeClient(client, 1008, "unauthorized");
        return;
      }
      client.authed = true;
      if (client.helloTimer) clearTimeout(client.helloTimer);
      client.helloTimer = null;
      send(client.socket, {
        type: "hello_ok",
        protocolVersion: PROTOCOL_VERSION,
        clientId: client.id,
      });
      return;
    }
    if (!client.authed) {
      closeClient(client, 1008, "hello required");
      return;
    }
    if (type === "ping") {
      send(client.socket, { type: "pong", nonce: record.nonce });
      return;
    }
    if (type === "event") {
      if (typeof record.topic !== "string" || !record.topic) {
        send(client.socket, { type: "error", code: "E_INVALID_PARAMS", message: "topic is required" });
        return;
      }
      // Client-originated events are relayed to peers (UI/plugin bus), never
      // interpreted as lifecycle state by the Host.
      broadcast({ type: "event", topic: record.topic, payload: record.payload ?? null });
      return;
    }
    if (type === "call") {
      const id = typeof record.id === "string" ? record.id : "";
      const method = typeof record.method === "string" ? record.method : "";
      const params =
        record.params && typeof record.params === "object" && !Array.isArray(record.params)
          ? (record.params as Record<string, unknown>)
          : {};
      if (!id || !method) {
        send(client.socket, { type: "call_result", id, ok: false, error: { code: "E_INVALID_PARAMS", message: "id and method are required" } });
        return;
      }
      if (!options.onCall) {
        send(client.socket, { type: "call_result", id, ok: false, error: { code: "E_UNAVAILABLE", message: "no call handler" } });
        return;
      }
      try {
        const result = await options.onCall({ id, method, params }, { id: client.id, remote: client.remote });
        send(client.socket, { type: "call_result", id, ok: true, result });
      } catch (error) {
        send(client.socket, {
          type: "call_result",
          id,
          ok: false,
          error: { code: "E_PLUGIN", message: error instanceof Error ? error.message : String(error) },
        });
      }
      return;
    }
    send(client.socket, { type: "error", code: "E_INVALID_PARAMS", message: `unknown message type: ${String(type)}` });
  }

  return {
    async start(): Promise<void> {
      if (server) return;
      await new Promise<void>((resolve, reject) => {
        const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: MAX_MESSAGE_BYTES });
        server = wss;
        wss.once("listening", () => {
          const address = wss.address();
          port = typeof address === "object" && address ? address.port : null;
          if (!port) {
            reject(new Error("WebSocket server did not report a port"));
            return;
          }
          log(`websocket bus listening on 127.0.0.1:${port}`);
          resolve();
        });
        wss.once("error", reject);
        wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
          if (clients.size >= MAX_CLIENTS) {
            socket.close(1013, "too many clients");
            return;
          }
          nextClientId += 1;
          const client: ClientState = {
            id: nextClientId,
            socket,
            authed: false,
            helloTimer: setTimeout(() => closeClient(client, 1008, "hello timeout"), HELLO_TIMEOUT_MS),
            remote: remoteOf(request),
          };
          client.helloTimer?.unref?.();
          clients.set(client.id, client);
          socket.on("message", (data) => {
            const text = typeof data === "string" ? data : data.toString("utf8");
            void handleMessage(client, text);
          });
          socket.on("close", () => {
            if (client.helloTimer) clearTimeout(client.helloTimer);
            clients.delete(client.id);
          });
          socket.on("error", () => {
            if (client.helloTimer) clearTimeout(client.helloTimer);
            clients.delete(client.id);
          });
        });
      });
    },

    async close(): Promise<void> {
      const wss = server;
      server = null;
      port = null;
      for (const client of [...clients.values()]) closeClient(client, 1001, "host shutdown");
      if (!wss) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        wss.close(done);
        setTimeout(done, 1_000).unref?.();
      });
    },

    info(): HostTransportInfo {
      return {
        wsUrl: port ? `ws://127.0.0.1:${port}/agent-bus` : null,
        wsPort: port,
        wsClients: [...clients.values()].filter((client) => client.authed).length,
      };
    },

    publish(topic: string, payload: unknown): void {
      broadcast({ type: "event", topic, payload });
    },
  };
}
