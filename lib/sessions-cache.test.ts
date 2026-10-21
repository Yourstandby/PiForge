import test from "node:test";
import assert from "node:assert/strict";
import { fetchSessions, invalidateSessions } from "./sessions-cache.ts";

function stubFetch() {
  const calls: number[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true, json: async () => ({ sessions: [{ id: "a" }] }) } as never;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("desktop boot makes a single /api/sessions request", async () => {
  const stub = stubFetch();
  invalidateSessions();
  try {
    const [a, b] = await Promise.all([fetchSessions(), fetchSessions()]);
    assert.equal(stub.calls.length, 1, "concurrent callers share one request");
    assert.deepEqual(a, b);
    // 缓存窗口内再调不再发请求
    await fetchSessions();
    assert.equal(stub.calls.length, 1);
    // force 绕过缓存
    await fetchSessions({ force: true });
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
    invalidateSessions();
  }
});
