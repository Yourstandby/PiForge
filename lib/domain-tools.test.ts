import assert from "node:assert/strict";
import test from "node:test";
import {
  DOMAIN_LEGACY_TOOLS,
  DOMAIN_ROUTES,
  DOMAIN_TOOL_NAMES,
  SUPERSEDED_LEGACY_TOOLS,
  collapseToolName,
  expandDomainToolCall,
  isDomainToolName,
  isLegacyDomainTool,
  isPlanAllowedDomainCall,
  planAllowedDomainActions,
  routeForAction,
} from "./domain-tools.ts";

test("every domain exposes at least one action and the routes are unique", () => {
  for (const domain of DOMAIN_TOOL_NAMES) {
    const routes = DOMAIN_ROUTES[domain];
    assert.ok(routes.length > 0, `${domain} must route something`);
    const actions = new Set(routes.map((route) => route.action));
    assert.equal(actions.size, routes.length, `${domain} has duplicate action values`);
  }
});

test("legacy tools map back to their domain; sub-action tools need the legacy action", () => {
  for (const domain of DOMAIN_TOOL_NAMES) {
    for (const route of DOMAIN_ROUTES[domain]) {
      const collapsed = collapseToolName(route.tool, route.legacyAction);
      assert.ok(collapsed, `${route.tool} must fold into ${domain}`);
      assert.equal(collapsed.tool, domain);
      if (route.legacyAction) {
        // 旧工具自己有多个子动作（browser_read: read/screenshot）：必须带上旧 action 才唯一。
        assert.deepEqual(collapsed, { tool: domain, action: route.action });
      }
    }
  }
});

test("expandDomainToolCall rewrites merged calls into the legacy shape", () => {
  assert.deepEqual(expandDomainToolCall("shell", { action: "run", command: "npm run dev" }), {
    toolName: "run_bg",
    input: { command: "npm run dev" },
  });
  // 旧工具自己也有 action：注入它自己的子动作值。
  assert.deepEqual(expandDomainToolCall("browser", { action: "screenshot" }), {
    toolName: "browser_read",
    input: { action: "screenshot" },
  });
  assert.deepEqual(expandDomainToolCall("browser", { action: "read", maxChars: 100 }), {
    toolName: "browser_read",
    input: { maxChars: 100, action: "read" },
  });
  // 非多态工具与未知 action 原样返回 null（执行层负责报错）。
  assert.equal(expandDomainToolCall("bash", { command: "ls" }), null);
  assert.equal(expandDomainToolCall("shell", { action: "nope" }), null);
});

test("merged and superseded legacy names are excluded from direct declaration", () => {
  for (const domain of DOMAIN_TOOL_NAMES) {
    assert.ok(isDomainToolName(domain));
    assert.ok(!isLegacyDomainTool(domain), `${domain} is the facade, not a legacy tool`);
  }
  assert.ok(isLegacyDomainTool("run_bg"));
  assert.ok(isLegacyDomainTool("web_preview"));
  for (const superseded of SUPERSEDED_LEGACY_TOOLS) {
    assert.ok(DOMAIN_LEGACY_TOOLS.has(superseded));
  }
});

test("plan mode allows only read-only actions", () => {
  assert.equal(isPlanAllowedDomainCall("memory", { action: "recall" }), true);
  assert.equal(isPlanAllowedDomainCall("memory", { action: "save" }), false);
  assert.equal(isPlanAllowedDomainCall("shell", { action: "read" }), true);
  assert.equal(isPlanAllowedDomainCall("shell", { action: "exec" }), false);
  assert.equal(isPlanAllowedDomainCall("browser", { action: "read" }), true);
  assert.equal(isPlanAllowedDomainCall("browser", { action: "open" }), false);
  assert.equal(isPlanAllowedDomainCall("fleet", { action: "spawn" }), false);
  assert.equal(isPlanAllowedDomainCall("bash", { action: "read" }), false);
  assert.deepEqual(planAllowedDomainActions("memory"), ["recall"]);
});

test("routeForAction ignores non-string actions", () => {
  assert.equal(routeForAction("shell", 42), undefined);
  assert.equal(routeForAction("shell", undefined), undefined);
  assert.equal(routeForAction("shell", "run")?.tool, "run_bg");
});
