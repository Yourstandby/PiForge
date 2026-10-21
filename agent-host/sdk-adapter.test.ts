import assert from "node:assert/strict";
import test from "node:test";
import * as sdk from "./sdk-adapter.ts";

test("sdk adapter exposes the stable Pi surface used by the Host", () => {
  assert.equal(typeof sdk.createAgentSession, "function");
  assert.equal(typeof sdk.SessionManager?.create, "function");
  assert.equal(typeof sdk.ModelRuntime?.create, "function");
  assert.equal(typeof sdk.getAgentDir, "function");
  assert.equal(typeof sdk.fauxProvider, "function");
});
