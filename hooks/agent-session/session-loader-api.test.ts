import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchSession, fetchContext } from "./session-loader-api.ts";

describe("session-loader-api", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; options?: RequestInit }[] = [];
  let mockResponse: { status: number; ok: boolean; json: () => Promise<unknown> };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
    globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
      fetchCalls.push({ url: String(url), options });
      return mockResponse as unknown as Response;
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("fetchSession sends correct request and returns JSON data", async () => {
    const dummyData = { sessionId: "123", filePath: "path/to/session" };
    mockResponse = {
      status: 200,
      ok: true,
      json: async () => dummyData,
    };

    const result = await fetchSession("123", false);

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "/api/sessions/123");
    assert.deepEqual(result, dummyData);
  });

  test("fetchSession formats URL correctly when includeState is true", async () => {
    mockResponse = {
      status: 200,
      ok: true,
      json: async () => ({}),
    };

    await fetchSession("foo/bar", true);

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "/api/sessions/foo%2Fbar?includeState");
  });

  test("fetchSession returns null on 404 response", async () => {
    mockResponse = {
      status: 404,
      ok: false,
      json: async () => ({}),
    };

    const result = await fetchSession("123");
    assert.equal(result, null);
  });

  test("fetchSession throws error on non-ok non-404 response", async () => {
    mockResponse = {
      status: 500,
      ok: false,
      json: async () => ({}),
    };

    await assert.rejects(
      async () => {
        await fetchSession("123");
      },
      /HTTP 500/
    );
  });

  test("fetchSession retries one network failure", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return {
        status: 200,
        ok: true,
        json: async () => ({ sessionId: "retried" }),
      } as unknown as Response;
    }) as typeof globalThis.fetch;

    const result = await fetchSession("123");
    assert.equal(calls, 2);
    assert.equal(result?.sessionId, "retried");
  });

  test("fetchSession retries one 5xx but not a 4xx", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1
        ? ({ status: 503, ok: false, json: async () => ({}) } as unknown as Response)
        : ({ status: 200, ok: true, json: async () => ({ sessionId: "ok" }) } as unknown as Response);
    }) as typeof globalThis.fetch;
    await fetchSession("123");
    assert.equal(calls, 2);

    calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return { status: 401, ok: false, json: async () => ({}) } as unknown as Response;
    }) as typeof globalThis.fetch;
    await assert.rejects(() => fetchSession("123"), /HTTP 401/);
    assert.equal(calls, 1);
  });

  test("fetchSession aborts at the deadline and retries once", async () => {
    let calls = 0;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    }) as typeof globalThis.fetch;

    await assert.rejects(() => fetchSession("123", false, { timeoutMs: 10 }), /timed out after 10ms/);
    assert.equal(calls, 2);
  });

  test("fetchContext sends correct request without leafId", async () => {
    const dummyContext = { context: { messages: [], entryIds: [] } };
    mockResponse = {
      status: 200,
      ok: true,
      json: async () => dummyContext,
    };

    const result = await fetchContext("123", null);

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "/api/sessions/123/context");
    assert.deepEqual(result, dummyContext);
  });

  test("fetchContext sends correct request with leafId", async () => {
    const dummyContext = { context: { messages: [], entryIds: [] } };
    mockResponse = {
      status: 200,
      ok: true,
      json: async () => dummyContext,
    };

    const result = await fetchContext("123", "leaf-abc");

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, "/api/sessions/123/context?leafId=leaf-abc");
    assert.deepEqual(result, dummyContext);
  });

  test("fetchContext throws error on non-ok response", async () => {
    mockResponse = {
      status: 400,
      ok: false,
      json: async () => ({}),
    };

    await assert.rejects(
      async () => {
        await fetchContext("123", null);
      },
      /HTTP 400/
    );
  });
});
