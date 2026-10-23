import test from "node:test";
import assert from "node:assert/strict";
import { GET, hostProbeState } from "./route.ts";

test("hostProbeState 把冷启动的 connecting 归为 starting（不是断线重连）", () => {
  assert.equal(hostProbeState("connecting"), "starting");
  assert.equal(hostProbeState("idle"), "starting");
  assert.equal(hostProbeState("ready"), "ready");
  assert.equal(hostProbeState("reconnecting"), "reconnecting");
  assert.equal(hostProbeState("offline"), "offline");
});

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
      hostState?: "ready" | "starting" | "reconnecting" | "offline";
    };
    assert.equal(body.ok, true);
    assert.equal(body.host, "down");
    assert.ok(
      body.hostState === "starting" ||
        body.hostState === "reconnecting" ||
        body.hostState === "offline",
    );
  } finally {
    if (previousEndpoint === undefined) delete process.env.PIFORGE_AGENT_ENDPOINT;
    else process.env.PIFORGE_AGENT_ENDPOINT = previousEndpoint;
    if (previousToken === undefined) delete process.env.PIFORGE_AGENT_TOKEN;
    else process.env.PIFORGE_AGENT_TOKEN = previousToken;
  }
});
