import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopCodemodeObserverFactory } from "./desktop-codemode-observer-extension.ts";

type Handler = (event: {
  toolName: string;
  isError: boolean;
  result?: unknown;
}) => void;

function setup(): { end: Handler; logs: string[] } {
  const logs: string[] = [];
  let end: Handler = () => {};
  const factory = createDesktopCodemodeObserverFactory({ log: (line) => logs.push(line) });
  factory({
    on: (name: string, handler: Handler) => {
      if (name === "tool_execution_end") end = handler;
      return () => {};
    },
  } as never);
  return { end, logs };
}

test("a timed out codemode script logs the held slot and the pool size", () => {
  const { end, logs } = setup();
  end({
    toolName: "codemode",
    isError: true,
    result: {
      content: [{ type: "text", text: "Script error:\nScript timed out: Execution timed out after 30000 ms" }],
    },
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^\[codemode\] worker still exiting, slot held \(pool=\d+\)/);
});

test("queue starvation logs a separate line", () => {
  const { end, logs } = setup();
  end({
    toolName: "codemode",
    isError: true,
    result: "No codemode worker became free within 60 seconds. All 2 workers, shared by every session",
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^\[codemode\] all codemode workers busy for 60s/);
});

test("successful runs, other tools and unrelated errors stay silent", () => {
  const { end, logs } = setup();
  end({ toolName: "codemode", isError: false, result: { content: [] } });
  end({ toolName: "bash", isError: true, result: { content: [{ type: "text", text: "boom" }] } });
  end({
    toolName: "codemode",
    isError: true,
    result: { content: [{ type: "text", text: "Script error:\nTypeError: x is not a function" }] },
  });
  assert.deepEqual(logs, []);
});
