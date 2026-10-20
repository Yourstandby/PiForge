import test from "node:test";
import assert from "node:assert/strict";
import { GET } from "./route.ts";

test("GET /api/environment proxies env.probe to the agent host", async () => {
  const previous = globalThis.__piforgeAgentHostClient;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  globalThis.__piforgeAgentHostClient = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return {
        platform: "win32",
        arch: "x64",
        hostNode: "v24.0.0",
        probedAt: 1,
        tools: [
          {
            id: "node",
            name: "Node.js",
            command: "node",
            required: true,
            found: true,
            version: "v24.0.0",
            path: "C:\\\\Program Files\\\\nodejs\\\\node.exe",
          },
        ],
        missingRequired: [],
      };
    },
  } as unknown as typeof previous;
  try {
    const res = await GET(new Request("http://localhost/api/environment?refresh=1"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tools[0].id, "node");
    assert.equal(body.tools[0].found, true);
    assert.equal(calls[0]?.method, "env.probe");
    assert.equal(calls[0]?.params.refresh, true);
  } finally {
    globalThis.__piforgeAgentHostClient = previous;
  }
});
