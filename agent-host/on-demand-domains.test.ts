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

/**
 * 激活尖峰回归护栏（P2-6 的前提）。
 *
 * 历史上把 memory/orchestrator 收成按需时，激活那一轮前缀重写 + 1 次
 * tool_search 往返，30 轮实测多烧 11.6k tok（前缀 7.8k–14.5k 的尖峰）。
 * 这里的断言把"允许的变化"钉死：**每次激活只多一个工具名，且绝不撤销已激活的域**
 * —— 满足它，前缀最多重写一次，历史缓存之后即可整段复用。
 */
test("三个域都按需时：每次激活只加 1 个工具，且不会撤销已激活的域", () => {
  withEnvValue("shell,memory,orchestrator", () => {
    const addedBetween = (previous: string[], next: string[]) => next.filter((n) => !previous.includes(n));
    const removedBetween = (previous: string[], next: string[]) => previous.filter((n) => !next.includes(n));

    const step0 = desktopRuntimeTools("full", "default", false, REGISTERED, []);
    for (const domain of ["shell", "memory", "orchestrator"]) {
      assert.ok(!step0.includes(domain), `${domain} must wait for tool_search`);
    }

    const step1 = desktopRuntimeTools("full", "default", false, REGISTERED, ["shell"]);
    assert.deepEqual(addedBetween(step0, step1), ["shell"]);
    assert.deepEqual(removedBetween(step0, step1), []);

    const step2 = desktopRuntimeTools("full", "default", false, REGISTERED, ["shell", "memory"]);
    assert.deepEqual(addedBetween(step1, step2), ["memory"]);
    assert.deepEqual(removedBetween(step1, step2), [], "已激活的域必须保持声明（latched）");

    // 同一份激活集合必须序稳定（否则缓存失效于"顺序抖动"而不是"新增"）。
    const repeat = desktopRuntimeTools("full", "default", false, REGISTERED, ["memory", "shell"]);
    assert.deepEqual(repeat, step2);
  });
});
