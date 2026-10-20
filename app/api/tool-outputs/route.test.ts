import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "./route.ts";

test("POST /api/tool-outputs proxies a page request to the agent host", async () => {
  const previous = globalThis.__piforgeAgentHostClient;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  globalThis.__piforgeAgentHostClient = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return {
        file: params.file,
        text: "line 201\nline 202",
        offset: 200,
        limit: 200,
        totalLines: 500,
        hasMore: true,
      };
    },
  } as unknown as typeof previous;
  try {
    const res = await POST(
      new Request("http://localhost/api/tool-outputs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "/tmp/sessions/tool-outputs/s/call.log", offset: 200, limit: 200 }),
      }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.totalLines, 500);
    assert.equal(body.hasMore, true);
    assert.equal(calls[0]?.method, "toolOutput.read");
    assert.equal(calls[0]?.params.file, "/tmp/sessions/tool-outputs/s/call.log");
    assert.equal(calls[0]?.params.offset, 200);
  } finally {
    globalThis.__piforgeAgentHostClient = previous;
  }
});

test("POST /api/tool-outputs validates its input", async () => {
  const missing = await POST(
    new Request("http://localhost/api/tool-outputs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  assert.equal(missing.status, 400);

  const badOffset = await POST(
    new Request("http://localhost/api/tool-outputs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "/x.log", offset: -1 }),
    }),
  );
  assert.equal(badOffset.status, 400);
});
