import test from "node:test";
import assert from "node:assert/strict";
import { GET } from "./route.ts";

test("health route reports host status", async () => {
  const previousEndpoint = process.env.PIFORGE_AGENT_ENDPOINT;
  const previousToken = process.env.PIFORGE_AGENT_TOKEN;
  delete process.env.PIFORGE_AGENT_ENDPOINT;
  delete process.env.PIFORGE_AGENT_TOKEN;

  try {
    const response = await GET();
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      ok: boolean;
      host: "ok" | "down";
      hostState?: "ready" | "reconnecting" | "offline";
    };
    assert.equal(body.ok, true);
    assert.equal(body.host, "down");
    assert.ok(body.hostState === "reconnecting" || body.hostState === "offline");
  } finally {
    if (previousEndpoint === undefined) delete process.env.PIFORGE_AGENT_ENDPOINT;
    else process.env.PIFORGE_AGENT_ENDPOINT = previousEndpoint;
    if (previousToken === undefined) delete process.env.PIFORGE_AGENT_TOKEN;
    else process.env.PIFORGE_AGENT_TOKEN = previousToken;
  }
});
