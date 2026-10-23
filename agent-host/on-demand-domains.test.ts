import assert from "node:assert/strict";
import test from "node:test";
import { desktopRuntimeTools } from "./desktop-runtime-tools.ts";
import {
  ALWAYS_DECLARED_DOMAINS,
  DEFAULT_ON_DEMAND_DOMAINS,
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

function withEnvValue<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.PIFORGE_ON_DEMAND_DOMAINS;
  if (value === undefined) delete process.env.PIFORGE_ON_DEMAND_DOMAINS;
  else process.env.PIFORGE_ON_DEMAND_DOMAINS = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PIFORGE_ON_DEMAND_DOMAINS;
    else process.env.PIFORGE_ON_DEMAND_DOMAINS = previous;
  }
}

test("defaults: shell is on-demand (step 8 A/B), low-frequency domains stay declared", () => {
  assert.deepEqual(enabledOnDemandDomains({}), [...DEFAULT_ON_DEMAND_DOMAINS]);
  assert.deepEqual([...DEFAULT_ON_DEMAND_DOMAINS], ["shell"]);
  assert.deepEqual(enabledOnDemandDomains({ PIFORGE_ON_DEMAND_DOMAINS: "0" }), []);
  assert.deepEqual(enabledOnDemandDomains({ PIFORGE_ON_DEMAND_DOMAINS: "1" }), [...ON_DEMAND_DOMAINS]);
  assert.deepEqual(enabledOnDemandDomains({ PIFORGE_ON_DEMAND_DOMAINS: "browser,shell" }), [
    "browser",
    "shell",
  ]);
});

test("with the default switch, only shell waits for tool_search", () => {
  withEnvValue(undefined, () => {
    const declared = desktopRuntimeTools("full", "default", false, REGISTERED, []);
    assert.ok(!declared.includes("shell"), "shell waits for tool_search by default");
    for (const domain of ON_DEMAND_DOMAINS) {
      assert.ok(declared.includes(domain), `${domain} is declared by default`);
    }
    for (const domain of ALWAYS_DECLARED_DOMAINS) {
      if (DEFAULT_ON_DEMAND_DOMAINS.includes(domain)) continue;
      assert.ok(declared.includes(domain), `${domain} must be declared by default`);
    }
  });
});

test("PIFORGE_ON_DEMAND_DOMAINS=0 declares everything (A group of the A/B)", () => {
  withEnvValue("0", () => {
    const declared = desktopRuntimeTools("full", "default", false, REGISTERED, []);
    for (const domain of [...ALWAYS_DECLARED_DOMAINS, ...ON_DEMAND_DOMAINS]) {
      assert.ok(declared.includes(domain), `${domain} must be declared with =0`);
    }
  });
});

test("PIFORGE_ON_DEMAND_DOMAINS=1 moves memory/orchestrator behind tool_search", () => {
  withEnvValue("1", () => {
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
