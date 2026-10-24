import test from "node:test";
import assert from "node:assert/strict";
import { AgentHostApiBridge } from "./api-bridge.ts";

/** 最小 net.Socket 替身：记录写出的帧，可注入 Host → 客户端的帧。 */
class FakeSocket {
  destroyed = false;
  written: Array<Record<string, unknown>> = [];
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  setNoDelay(): void {}
  setEncoding(): void {}
  write(data: string): void {
    this.written.push(JSON.parse(data) as Record<string, unknown>);
  }
  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
  }
  once(event: string, listener: (...args: unknown[]) => void): void {
    this.on(event, listener);
  }
  destroy(): void {
    this.destroyed = true;
  }
  /** 模拟 Host 连上（触发 connect）。 */
  connect(): void {
    for (const listener of this.handlers.get("connect") ?? []) listener();
  }
  /** 模拟 Host 发来一帧。 */
  push(frame: Record<string, unknown>): void {
    for (const listener of this.handlers.get("data") ?? []) listener(`${JSON.stringify(frame)}\n`);
  }
  close(): void {
    for (const listener of this.handlers.get("close") ?? []) listener();
  }
}

function makeBridge(socket: FakeSocket) {
  return new AgentHostApiBridge({
    endpoint: "\\\\.\\pipe\\test",
    token: "token",
    connect: () => {
      queueMicrotask(() => socket.connect());
      return socket as unknown as import("node:net").Socket;
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}

test("api bridge 走握手 + api.request，返回 base64 响应体", async () => {
  const socket = new FakeSocket();
  const bridge = makeBridge(socket);

  const pending = bridge.request({ method: "GET", url: "piforge://app/api/health" });
  await waitFor(() => socket.written.some((frame) => frame.kind === "req"));

  const hello = socket.written.find((frame) => frame.kind === "hello");
  assert.equal(hello?.protocolVersion, 1);
  assert.equal((hello?.client as { pid?: number })?.pid, process.pid);

  const req = socket.written.find((frame) => frame.kind === "req");
  assert.equal(req?.method, "api.request");
  assert.equal((req?.params as { method?: string })?.method, "GET");

  socket.push({
    kind: "res",
    id: req?.id,
    ok: true,
    result: {
      status: 200,
      headers: { "content-type": "application/json" },
      bodyBase64: Buffer.from('{"ok":true}').toString("base64"),
    },
  });

  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(response.body).toString("utf8"), '{"ok":true}');
  bridge.stop();
});

test("api bridge 必须回 pong：否则 Host 每 60s 断链（心跳回归）", async () => {
  const socket = new FakeSocket();
  const bridge = makeBridge(socket);
  void bridge.request({ method: "GET", url: "piforge://app/api/health" }).catch(() => {});
  await waitFor(() => socket.written.some((frame) => frame.kind === "hello"));

  socket.push({ kind: "ping", nonce: 42 });
  await waitFor(() => socket.written.some((frame) => frame.kind === "pong"));
  const pong = socket.written.find((frame) => frame.kind === "pong");
  assert.equal(pong?.nonce, 42);

  // 非数字 nonce 不得被误回。
  socket.push({ kind: "ping", nonce: "nope" });
  assert.equal(socket.written.filter((frame) => frame.kind === "pong").length, 1);
  bridge.stop();
});

test("api bridge 的流式响应：早到块先缓存，adopt 之后按序吐出", async () => {
  const socket = new FakeSocket();
  const bridge = makeBridge(socket);

  const pending = bridge.requestStream({ method: "GET", url: "piforge://app/api/processes/events" });
  await waitFor(() => socket.written.some((frame) => frame.kind === "req"));
  const req = socket.written.find((frame) => frame.kind === "req");

  const streamId = "api-stream-test-1";
  socket.push({
    kind: "res",
    id: req?.id,
    ok: true,
    result: { status: 200, headers: { "content-type": "text/event-stream" }, streamId },
  });
  // res 与 adoptStream 之间到达的块（真实竞态）：必须先缓存再回放。
  socket.push({
    kind: "evt",
    subscriptionId: streamId,
    seq: 1,
    topic: "api.stream.chunk",
    payload: { chunkBase64: Buffer.from("data: {}\n\n").toString("base64") },
  });

  const handle = await pending;
  const reader = handle.stream.getReader();
  const first = await reader.read();
  assert.equal(Buffer.from(first.value ?? new Uint8Array()).toString("utf8"), "data: {}\n\n");

  socket.push({
    kind: "evt",
    subscriptionId: streamId,
    seq: 2,
    topic: "api.stream.chunk",
    payload: { chunkBase64: Buffer.from("data: {\"x\":1}\n\n").toString("base64") },
  });
  const second = await reader.read();
  assert.equal(Buffer.from(second.value ?? new Uint8Array()).toString("utf8"), 'data: {"x":1}\n\n');

  socket.push({ kind: "evt", subscriptionId: streamId, seq: 3, topic: "api.stream.end", payload: {} });
  const end = await reader.read();
  assert.equal(end.done, true);
  bridge.stop();
});

test("api bridge 连接断开时把挂起请求 reject 掉（不静默挂死）", async () => {
  const socket = new FakeSocket();
  const bridge = makeBridge(socket);
  const pending = bridge.request({ method: "GET", url: "piforge://app/api/health" });
  await waitFor(() => socket.written.some((frame) => frame.kind === "req"));
  socket.close();
  await assert.rejects(pending, /closed/);
  bridge.stop();
});
