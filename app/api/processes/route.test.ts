import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "./route.ts";

type GlobalShim = {
  __piforgeAgentHostClient?: unknown;
  __piforgeFilesHostClient?: unknown;
};

/**
 * 同时 stub 主连接与文件授权连接：`files.authorize` 走的是 lib/host-files.ts 的
 * 独立 socket（globalThis.__piforgeFilesHostClient）。只 stub 主连接时，本机有真
 * Host 在跑的情形会真的去问 policy，`/project` 被拒 → 403，测试就假红。
 */
function stubClient(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const shim = globalThis as unknown as GlobalShim;
  const previous = shim.__piforgeAgentHostClient;
  const previousFiles = shim.__piforgeFilesHostClient;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  shim.__piforgeAgentHostClient = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return handler(method, params);
    },
  };
  shim.__piforgeFilesHostClient = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "files.authorize") return { realPath: params.path };
      return handler(method, params);
    },
  };
  return {
    calls,
    restore: () => {
      shim.__piforgeAgentHostClient = previous;
      shim.__piforgeFilesHostClient = previousFiles;
    },
  };
}

test("POST /api/processes force-stops a managed process", async () => {
  const stub = stubClient((method) => (method === "processes.forceStop" ? { ok: true } : {}));
  try {
    const res = await POST(
      new Request("http://localhost/api/processes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "force-stop", id: "proc-1" }),
      }),
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);
    assert.equal(stub.calls[0]?.method, "processes.forceStop");
    assert.equal(stub.calls[0]?.params.id, "proc-1");
  } finally {
    stub.restore();
  }
});

test("POST /api/processes start marks manual starts as user-owned", async () => {
  const stub = stubClient((method, params) => {
    if (method === "files.authorize") return { realPath: params.path };
    if (method === "processes.start") {
      return {
        process: {
          id: "proc-2",
          owner: params.owner,
          status: "starting",
          readiness: "pending",
        },
      };
    }
    return {};
  });
  try {
    const res = await POST(
      new Request("http://localhost/api/processes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", cwd: "/project", command: "npm run dev" }),
      }),
    );
    assert.equal(res.status, 200);
    const startCall = stub.calls.find((call) => call.method === "processes.start");
    assert.ok(startCall);
    assert.equal(startCall.params.owner, "user");
  } finally {
    stub.restore();
  }
});

test("POST /api/processes rejects unknown actions", async () => {
  const res = await POST(
    new Request("http://localhost/api/processes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "obliterate", id: "x" }),
    }),
  );
  assert.equal(res.status, 400);
});
