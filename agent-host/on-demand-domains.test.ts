import assert from "node:assert/strict";
import test from "node:test";
import { desktopRuntimeTools } from "./desktop-runtime-tools.ts";
import {
  ALWAYS_DECLARED_DOMAINS,
  ON_DEMAND_DOMAINS,
  enabledOnDemandDomains,
} from "../lib/domain-tools.ts";

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

function withOnDemand<T>(enabled: boolean, fn: () => T): T {
  const previous = process.env.PIFORGE_ON_DEMAND_DOMAINS;
  if (enabled) process.env.PIFORGE_ON_DEMAND_DOMAINS = "1";
  else delete process.env.PIFORGE_ON_DEMAND_DOMAINS;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PIFORGE_ON_DEMAND_DOMAINS;
    else process.env.PIFORGE_ON_DEMAND_DOMAINS = previous;
  }
}

test("on-demand domains are OFF by default (step 5 measurement: the spike outweighs the saving)", () => {
  assert.deepEqual(enabledOnDemandDomains({}), []);
  assert.deepEqual(enabledOnDemandDomains({ PIFORGE_ON_DEMAND_DOMAINS: "1" }), [
    ...ON_DEMAND_DOMAINS,
  ]);
  withOnDemand(false, () => {
    const declared = desktopRuntimeTools("full", "default", false, REGISTERED, []);
    for (const domain of ON_DEMAND_DOMAINS) {
      assert.ok(declared.includes(domain), `${domain} is declared by default`);
    }
  });
});

test("always-on domains are declared without activation", () => {
  const declared = desktopRuntimeTools("full", "default", false, REGISTERED, []);
  for (const domain of ALWAYS_DECLARED_DOMAINS) {
    assert.ok(declared.includes(domain), `${domain} must be declared by default`);
  }
});

test("with PIFORGE_ON_DEMAND_DOMAINS=1 the domains wait for tool_search", () => {
  withOnDemand(true, () => {
    const declared = desktopRuntimeTools("full", "default", false, REGISTERED, []);
    for (const domain of ON_DEMAND_DOMAINS) {
      assert.ok(!declared.includes(domain), `${domain} must stay undeclared until activated`);
    }
    const activated = desktopRuntimeTools("full", "default", false, REGISTERED, ["memory"]);
    assert.ok(activated.includes("memory"), "activated on-demand domain must be declared next turn");
    assert.ok(!activated.includes("orchestrator"), "only the activated domain is declared");
  });
});

test("plan mode declares the read-only memory facade via PLAN_TOOLS", () => {
  const declared = desktopRuntimeTools("plan", "default", false, REGISTERED, []);
  assert.ok(declared.includes("memory"));
  assert.ok(!declared.includes("shell"));
  assert.ok(!declared.includes("orchestrator"));
});
