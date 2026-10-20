import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserCommand, BrowserManager } from "./browser-manager.ts";
import { BrowserHostBridge, type BridgeSocket } from "./browser-host-bridge.ts";

class FakeSocket {
  frames: Array<Record<string, unknown>> = [];
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  commands: BrowserCommand[] = [];
  resolved: unknown[] = [];

  write(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.frames.push(frame);
    queueMicrotask(() => {
      if (frame.kind === "hello") this.emit("data", Buffer.from(`${JSON.stringify({ kind: "hello_ok" })}\n`));
      if (frame.kind === "req" && frame.method === "browser.poll") {
        this.respond(frame.id as number, { commands: this.commands.splice(0) });
      }
      if (frame.kind === "req" && frame.method === "browser.resolveCommand") {
        this.resolved.push(frame.params);
        this.respond(frame.id as number, { ok: true });
      }
      if (frame.kind === "req" && frame.method === "browser.pushSnapshot") {
        this.respond(frame.id as number, { ok: true });
      }
    });
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
  }

  destroy(): void {}
  emit(event: string, payload: unknown): void {
    for (const listener of this.handlers.get(event) ?? []) listener(payload);
  }
  private respond(id: number, result: unknown): void {
    this.emit("data", Buffer.from(`${JSON.stringify({ kind: "res", id, ok: true, result })}\n`));
  }
}

function managerStub(onOpen?: (url: string) => void, seen?: BrowserCommand[]) {
  return {
    executeCommand: async (command: BrowserCommand) => {
      seen?.push(command);
      if (command.kind === "open" && command.url) onOpen?.(command.url);
      return { id: command.id, ok: true, url: command.url ?? "http://localhost:3000" };
    },
    snapshot: async () => ({
      url: "http://localhost:3000",
      title: "fixture",
      text: "hello",
      truncated: false,
      native: true,
      ready: true,
      boundsGeneration: 3,
      updatedAt: Date.now(),
    }),
  } as unknown as BrowserManager;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}

test("Main bridge handshakes over a named-pipe socket and calls Host RPC", async () => {
  const socket = new FakeSocket();
  const bridge = new BrowserHostBridge({
    endpoint: "\\.\pipe\test",
    token: "secret-token",
    connect: () => socket as unknown as BridgeSocket,
    getManager: () => managerStub(),
    pollMs: 60_000,
    snapshotMs: 60_000,
  });
  bridge.start();
  await waitFor(() => socket.frames.some((frame) => frame.kind === "hello"));
  const hello = socket.frames.find((frame) => frame.kind === "hello");
  assert.equal(hello?.token, "secret-token");
  assert.equal((hello?.client as { role?: string } | undefined)?.role, "cli");

  assert.deepEqual(await bridge.call("browser.poll"), { commands: [] });
  bridge.stop();
});

test("Main bridge executes Host browser commands and posts results", async () => {
  const socket = new FakeSocket();
  const opened: string[] = [];
  const seen: BrowserCommand[] = [];
  const bridge = new BrowserHostBridge({
    endpoint: "\\.\pipe\test",
    token: "t",
    connect: () => socket as unknown as BridgeSocket,
    getManager: () => managerStub((url) => opened.push(url), seen),
    onAgentOpen: (url) => opened.push(`ui:${url}`),
    windowId: "win-1",
    ownerId: "owner-1",
    pollMs: 10,
    snapshotMs: 60_000,
  });
  bridge.start();
  await waitFor(() => socket.frames.some((frame) => frame.method === "browser.poll"));
  socket.commands.push({ id: "cmd-1", kind: "open", url: "http://localhost:5173" });
  await waitFor(() => socket.resolved.length > 0);
  assert.deepEqual(opened, ["ui:http://localhost:5173", "http://localhost:5173"]);
  assert.equal((socket.resolved[0] as { result: { ok: boolean } }).result.ok, true);
  assert.equal(seen[0]?.windowId, "win-1");
  assert.equal(seen[0]?.ownerId, "owner-1");
  const pushed = socket.frames.find((frame) => frame.method === "browser.pushSnapshot");
  const snapshot = (pushed?.params as { snapshot?: { ready?: boolean; boundsGeneration?: number; windowId?: string; ownerId?: string } } | undefined)?.snapshot;
  assert.equal(snapshot?.ready, true);
  assert.equal(snapshot?.boundsGeneration, 3);
  assert.equal(snapshot?.windowId, "win-1");
  assert.equal(snapshot?.ownerId, "owner-1");
  bridge.stop();
});
