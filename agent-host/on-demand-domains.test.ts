import assert from "node:assert/strict";
import test from "node:test";
import { desktopRuntimeTools } from "./desktop-runtime-tools.ts";
import { ON_DEMAND_DOMAINS, ALWAYS_DECLARED_DOMAINS } from "../lib/domain-tools.ts";

const REGISTERED = [
  { name: "read", description: "" },
  { name: "bash", description: "" },
  { name: "browser", description: "" },
  { name: "shell", description: "" },
  { name: "fleet", description: "" },
  { name: "memory", description: "" },
  { name: "orchestrator", description: "" },
  { name: "tool_search", description: "" },
];

test("always-on domains are declared without activation", () => {
  const declared = desktopRuntimeTools("full", "default", false, REGISTERED, []);
  for (const domain of ALWAYS_DECLARED_DOMAINS) {
    assert.ok(declared.includes(domain), `${domain} must be declared by default`);
  }
});

test("on-demand domains are not declared until tool_search activates them", () => {
  const declared = desktopRuntimeTools("full", "default", false, REGISTERED, []);
  for (const domain of ON_DEMAND_DOMAINS) {
    assert.ok(!declared.includes(domain), `${domain} must stay undeclared by default`);
  }
  const activated = desktopRuntimeTools("full", "default", false, REGISTERED, ["memory"]);
  assert.ok(activated.includes("memory"), "activated on-demand domain must be declared next turn");
  assert.ok(!activated.includes("orchestrator"), "only the activated domain is declared");
});

test("plan mode declares the read-only memory facade via PLAN_TOOLS", () => {
  const declared = desktopRuntimeTools("plan", "default", false, REGISTERED, []);
  assert.ok(declared.includes("memory"));
  assert.ok(!declared.includes("shell"));
  assert.ok(!declared.includes("orchestrator"));
});
