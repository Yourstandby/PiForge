import assert from "node:assert/strict";
import test from "node:test";
import {
  ON_DEMAND_DOMAIN_OPTIONS,
  formatOnDemandSummary,
  isSettingsOverriddenByEnv,
  normalizeOnDemandSelection,
  onDemandWarning,
} from "./on-demand-settings-view.ts";
import { resolveOnDemandDomains, DEFAULT_ON_DEMAND_DOMAINS, ON_DEMAND_DOMAINS } from "./domain-tools.ts";

test("options cover exactly the multi-domain tool names", () => {
  assert.deepEqual(
    ON_DEMAND_DOMAIN_OPTIONS.map((option) => option.value),
    ["shell", "browser", "fleet", "orchestrator", "memory", "plugin"]
  );
});

test("summary shows the effective list and its source (not the raw config)", () => {
  assert.equal(
    formatOnDemandSummary({ domains: ["shell"], source: "default" }),
    "实际生效：shell · 来源：默认值"
  );
  assert.equal(
    formatOnDemandSummary({ domains: ["shell", "browser"], source: "settings" }),
    "实际生效：shell, browser · 来源：设置项 onDemandDomains"
  );
  assert.equal(
    formatOnDemandSummary({ domains: [], source: "env" }),
    "实际生效：无（全部常驻） · 来源：环境变量 PIFORGE_ON_DEMAND_DOMAINS"
  );
});

test("env source disables the settings toggles", () => {
  assert.equal(isSettingsOverriddenByEnv("env"), true);
  assert.equal(isSettingsOverriddenByEnv("settings"), false);
  assert.equal(isSettingsOverriddenByEnv("default"), false);
});

test("memory / orchestrator selection warns without blocking", () => {
  const warning = onDemandWarning(["shell", "memory"]);
  assert.ok(warning && warning.includes("memory"));
  assert.ok(warning && warning.includes("负收益"));
  assert.equal(onDemandWarning(["shell"]), null);
  assert.ok(onDemandWarning(["orchestrator"]));
});

test("normalize keeps a stable option order and drops unknown names", () => {
  assert.deepEqual(normalizeOnDemandSelection(["memory", "shell", "nope"]), ["shell", "memory"]);
  assert.deepEqual(normalizeOnDemandSelection([]), []);
});

test("resolver priority: env > settings > default", () => {
  // 默认：shell
  assert.deepEqual(resolveOnDemandDomains({}), {
    domains: [...DEFAULT_ON_DEMAND_DOMAINS],
    source: "default",
  });
  // 设置项生效
  assert.deepEqual(resolveOnDemandDomains({ settings: ["browser"] }), {
    domains: ["browser"],
    source: "settings",
  });
  // 环境变量覆盖设置项
  assert.deepEqual(resolveOnDemandDomains({ env: { PIFORGE_ON_DEMAND_DOMAINS: "shell" }, settings: ["browser"] }), {
    domains: ["shell"],
    source: "env",
  });
  // 0 = 全常驻
  assert.deepEqual(resolveOnDemandDomains({ env: { PIFORGE_ON_DEMAND_DOMAINS: "0" }, settings: ["browser"] }), {
    domains: [],
    source: "env",
  });
  // 1 = 兼容别名（memory + orchestrator）
  assert.deepEqual(resolveOnDemandDomains({ env: { PIFORGE_ON_DEMAND_DOMAINS: "1" } }), {
    domains: [...ON_DEMAND_DOMAINS],
    source: "env",
  });
  // 未知域名被忽略
  assert.deepEqual(resolveOnDemandDomains({ env: { PIFORGE_ON_DEMAND_DOMAINS: "nope,shell" } }), {
    domains: ["shell"],
    source: "env",
  });
  // 空数组的 settings 是显式选择「全部常驻」
  assert.deepEqual(resolveOnDemandDomains({ settings: [] }), { domains: [], source: "settings" });
});
