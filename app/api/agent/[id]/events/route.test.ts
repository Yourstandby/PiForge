import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("agent events route proxies the host stream and keeps the JSON error contract", () => {
  assert.match(source, /import \{ getAgentHostClient \}/);
  assert.match(source, /return jsonError\(req, 404, ["']Session not found["']/);
  assert.match(source, /errorCode: ["']SESSION_NOT_FOUND["']/);

  // Trust gate + lazy session start stay at the HTTP boundary.
  assert.match(source, /client\.call\(["']trust\.evaluate["']/);
  assert.match(source, /status: 409/);
  assert.match(source, /client\.call\(["']agent\.ensure["']/);

  // Streaming is a host subscription fanned out as SSE; Next owns no queue.
  assert.match(source, /client\.subscribeAgent\(/);
  assert.match(source, /id: \$\{seq\}/);
  assert.match(source, /agent\.keepAlive/);
  assert.match(source, /subscription\?\.close\(\)/);
});
