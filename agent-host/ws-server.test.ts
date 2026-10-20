import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { createHostWebSocketServer } from "./ws-server.ts";

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await once(socket, "open");
  return socket;
}

function nextMessage(socket: WebSocket, timeoutMs = 2_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), timeoutMs);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

test("websocket bus binds an OS-assigned localhost port and requires token hello", async () => {
  const bus = createHostWebSocketServer({ token: "test-token" });
  await bus.start();
  try {
    const info = bus.info();
    assert.match(info.wsUrl ?? "", /^ws:\/\/127\.0\.0\.1:\d+\/agent-bus$/);
    const socket = await connect(info.wsUrl!);
    socket.send(JSON.stringify({ type: "hello", token: "wrong" }));
    const closed = once(socket, "close");
    await closed;

    const good = await connect(info.wsUrl!);
    good.send(JSON.stringify({ type: "hello", token: "test-token" }));
    const hello = await nextMessage(good);
    assert.equal(hello.type, "hello_ok");
    assert.equal(bus.info().wsClients, 1);

    const eventPromise = nextMessage(good);
    bus.publish("plugins.changed", { id: "p1" });
    const event = await eventPromise;
    assert.equal(event.type, "event");
    assert.equal(event.topic, "plugins.changed");
    good.close();
  } finally {
    await bus.close();
  }
});

test("websocket calls are dispatched to the host handler", async () => {
  const bus = createHostWebSocketServer({
    token: "t",
    onCall: async (request) => ({ echoed: request.method }),
  });
  await bus.start();
  try {
    const socket = await connect(bus.info().wsUrl!);
    socket.send(JSON.stringify({ type: "hello", token: "t" }));
    await nextMessage(socket);
    socket.send(JSON.stringify({ type: "call", id: "1", method: "plugin.ping", params: {} }));
    const result = await nextMessage(socket);
    assert.equal(result.type, "call_result");
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, { echoed: "plugin.ping" });
    socket.close();
  } finally {
    await bus.close();
  }
});
