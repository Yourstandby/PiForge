import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "./route.ts";

test("POST /api/files/apply proxies the write to the agent host", async () => {
  const previous = globalThis.__piforgeAgentHostClient;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  globalThis.__piforgeAgentHostClient = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { path: params.path, mode: params.mode, bytes: 12 };
    },
  } as unknown as typeof previous;
  try {
    const res = await POST(
      new Request("http://localhost/api/files/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/project/src/a.ts", content: "export {};", mode: "append" }),
      }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, "append");
    assert.equal(calls[0]?.method, "files.applyCode");
    assert.equal(calls[0]?.params.path, "/project/src/a.ts");
    assert.equal(calls[0]?.params.content, "export {};");
    assert.equal(calls[0]?.params.mode, "append");
  } finally {
    globalThis.__piforgeAgentHostClient = previous;
  }
});

test("POST /api/files/apply validates path, content and mode", async () => {
  const cases: Array<Record<string, unknown>> = [
    {},
    { path: "/x", content: "a" },
    { path: "/x", content: "a", mode: "replace" },
    { path: "/x", content: 42, mode: "overwrite" },
  ];
  for (const body of cases) {
    const res = await POST(
      new Request("http://localhost/api/files/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});
