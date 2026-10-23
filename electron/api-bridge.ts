/**
 * 外壳层 → Agent Host 的 `/api/**` 传输桥（P1-4）。
 *
 * 为什么需要它：拆掉 Next standalone 之后，渲染进程不能再对着
 * `http://127.0.0.1:30141` 发请求。Electron 的 `protocol.handle("piforge", …)`
 * 接住 `piforge://app/api/…`，再经由这里用**命名管道**把请求交给 Agent Host，
 * 由 Host 内已加载的 `app/api/**\/route.ts` 处理（见 `agent-host/api-router.ts`）。
 *
 * 传输形态：
 *   - 请求：一条 `api.request` RPC（method / url / headers / bodyBase64）；
 *   - 响应：`bodyBase64`（一次性）或 `streamId` + `api.stream.chunk` 事件（SSE）。
 *
 * 心跳：Host 每 15s `ping`，60s 没有 `pong` 就断链 —— 这里必须回 pong，
 * 否则会像 0.9.0 的 browser bridge 那样每 60s 重连一次（见 electron/browser-host-bridge.ts）。
 */
import net from "node:net";
import { randomUUID } from "node:crypto";

const PROTOCOL_VERSION = 1;
/** 唤醒 Host 的最短间隔：冷启动早期管道还不存在。 */
const CONNECT_RETRY_MS = 250;
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;
/** 早到的事件块先缓存：`res` 帧之前到达的 chunk 不能丢。 */
const MAX_EARLY_CHUNKS = 128;

export interface ApiBridgeOptions {
  endpoint: string;
  token: string;
  /** 仅测试注入。 */
  connect?: (endpoint: string) => net.Socket;
  log?: (message: string, detail?: unknown) => void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

interface StreamHandle {
  status: number;
  headers: Record<string, string>;
  stream: ReadableStream<Uint8Array>;
  cancel: () => void;
}

export class AgentHostApiBridge {
  private socket: net.Socket | null = null;
  private buffer = "";
  private nextId = 0;
  private pending = new Map<number, PendingCall>();
  private streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  private early = new Map<string, Uint8Array[]>();
  private connecting: Promise<void> | null = null;
  private stopped = false;
  private readonly options: ApiBridgeOptions;

  constructor(options: ApiBridgeOptions) {
    this.options = options;
  }

  stop(): void {
    this.stopped = true;
    this.socket?.destroy();
    this.socket = null;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("API bridge stopped"));
    }
    this.pending.clear();
  }

  /** 一次性响应（JSON / 文本 / 图片）。 */
  async request(input: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: Uint8Array | null;
  }): Promise<ApiResponse> {
    const response = (await this.call("api.request", {
      method: input.method,
      url: input.url,
      headers: input.headers ?? {},
      bodyBase64: input.body ? Buffer.from(input.body).toString("base64") : null,
    })) as { status: number; headers: Record<string, string>; bodyBase64?: string; streamId?: string };

    if (response.streamId) {
      // 调用方要的是整体响应，但 Host 回了流（例如 SSE）：读完再返回。
      const chunks: Uint8Array[] = [];
      const handle = await this.adoptStream(response);
      const reader = handle.stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      return { status: response.status, headers: response.headers, body: concat(chunks) };
    }

    return {
      status: response.status,
      headers: response.headers,
      body: response.bodyBase64 ? new Uint8Array(Buffer.from(response.bodyBase64, "base64")) : new Uint8Array(),
    };
  }

  /** 流式响应（EventSource / SSE）：返回一个 ReadableStream 给 protocol.handle。 */
  async requestStream(input: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: Uint8Array | null;
  }): Promise<StreamHandle> {
    const response = (await this.call("api.request", {
      method: input.method,
      url: input.url,
      headers: input.headers ?? {},
      bodyBase64: input.body ? Buffer.from(input.body).toString("base64") : null,
    })) as { status: number; headers: Record<string, string>; bodyBase64?: string; streamId?: string };

    if (!response.streamId) {
      const body = response.bodyBase64 ? new Uint8Array(Buffer.from(response.bodyBase64, "base64")) : new Uint8Array();
      return {
        status: response.status,
        headers: response.headers,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            if (body.length > 0) controller.enqueue(body);
            controller.close();
          },
        }),
        cancel: () => {},
      };
    }

    return this.adoptStream(response);
  }

  /** 把 `streamId` 接到一个 ReadableStream 上（含早到块的回放）。 */
  private adoptStream(response: {
    status: number;
    headers: Record<string, string>;
    streamId?: string;
  }): StreamHandle {
    const streamId = response.streamId!;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controllerRef = controller;
        // res 帧之前到的块（Host 已经开始泵数据了）。
        for (const chunk of this.early.get(streamId) ?? []) {
          try {
            controller.enqueue(chunk);
          } catch {
            break;
          }
        }
        this.early.delete(streamId);
        this.streams.set(streamId, controller);
      },
      cancel: () => {
        this.streams.delete(streamId);
        void this.call("api.stream.close", { streamId }).catch(() => {});
      },
    });

    return {
      status: response.status,
      headers: response.headers,
      stream,
      cancel: () => {
        this.streams.delete(streamId);
        try {
          controllerRef?.close();
        } catch {
          // already closed
        }
        void this.call("api.stream.close", { streamId }).catch(() => {});
      },
    };
  }

  // -------------------------------------------------------------------------
  // 传输层
  // -------------------------------------------------------------------------

  private log(message: string, detail?: unknown): void {
    this.options.log?.(message, detail);
  }

  private ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + CONNECT_TIMEOUT_MS;
      const attempt = () => {
        if (this.stopped) {
          reject(new Error("API bridge stopped"));
          return;
        }
        const factory = this.options.connect ?? ((endpoint: string) => net.connect(endpoint));
        const socket = factory(this.options.endpoint);
        let settled = false;

        const giveUp = (error: Error) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (Date.now() > deadline) {
            reject(error);
            return;
          }
          // 冷启动：管道还没建好，退避再试。
          setTimeout(attempt, CONNECT_RETRY_MS);
        };

        socket.once("error", () => giveUp(new Error("connect failed")));
        socket.once("connect", () => {
          if (settled) return;
          settled = true;
          socket.setNoDelay(true);
          this.attach(socket);
          socket.write(
            `${JSON.stringify({
              kind: "hello",
              protocolVersion: PROTOCOL_VERSION,
              token: this.options.token,
              client: { pid: process.pid, role: "cli" },
            })}\n`,
          );
          resolve();
        });
      };
      attempt();
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  private attach(socket: net.Socket): void {
    this.socket = socket;
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.handleData(chunk));
    socket.on("close", () => this.handleClose());
    socket.on("error", () => this.handleClose());
  }

  private handleClose(): void {
    this.socket = null;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("Agent Host connection closed"));
    }
    this.pending.clear();
    for (const controller of this.streams.values()) {
      try {
        controller.close();
      } catch {
        // already closed
      }
    }
    this.streams.clear();
    this.early.clear();
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
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
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: Record<string, unknown>): void {
    if (frame.kind === "hello_ok") return;

    // 心跳：必须回 pong（0.9.0 的 browser bridge 漏了这一步，每 60s 断一次）。
    if (frame.kind === "ping" && typeof frame.nonce === "number") {
      this.socket?.write(`${JSON.stringify({ kind: "pong", nonce: frame.nonce })}\n`);
      return;
    }

    if (frame.kind === "evt") {
      const subscriptionId = typeof frame.subscriptionId === "string" ? frame.subscriptionId : "";
      if (!subscriptionId.startsWith("api-stream-")) return;
      const payload = (frame.payload ?? {}) as { chunkBase64?: string };
      if (frame.topic === "api.stream.end") {
        const controller = this.streams.get(subscriptionId);
        this.streams.delete(subscriptionId);
        this.early.delete(subscriptionId);
        try {
          controller?.close();
        } catch {
          // already closed
        }
        return;
      }
      if (frame.topic !== "api.stream.chunk" || typeof payload.chunkBase64 !== "string") return;
      const bytes = new Uint8Array(Buffer.from(payload.chunkBase64, "base64"));
      const controller = this.streams.get(subscriptionId);
      if (!controller) {
        const buffered = this.early.get(subscriptionId) ?? [];
        if (buffered.length < MAX_EARLY_CHUNKS) buffered.push(bytes);
        this.early.set(subscriptionId, buffered);
        return;
      }
      try {
        controller.enqueue(bytes);
      } catch {
        this.streams.delete(subscriptionId);
      }
      return;
    }

    if (frame.kind === "res" && typeof frame.id === "number") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.ok === false) {
        const error = frame.error as { message?: string } | undefined;
        pending.reject(new Error(error?.message ?? "Host RPC failed"));
      } else {
        pending.resolve(frame.result);
      }
    }
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Agent Host is not connected");

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
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array();
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** 供 protocol handler 生成一个唯一请求 id（仅用于日志关联）。 */
export function newApiRequestId(): string {
  return randomUUID();
}
