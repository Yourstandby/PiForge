import test from "node:test";
import assert from "node:assert/strict";
import {
  CHILD_CORE_TOOLS,
  ToolGrantError,
  childToolSummary,
  isChildToolDenied,
  resolveChildTools,
} from "./tool-grants.ts";

const FULL_REGISTRY = [
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
  "spawn_agent",
  "herdr_spawn",
  "herdr_status",
  "orchestrator_spawn",
  "desktop_use_tool",
  "web_preview",
  "process_read",
];

test("默认继承父 Agent 的 activeTools，并强制保留核心工具", () => {
  const grants = resolveChildTools({
    parentActive: ["bash", "read", "spawn_agent"],
    available: FULL_REGISTRY,
  });
  for (const tool of CHILD_CORE_TOOLS) assert.ok(grants.tools.includes(tool), `missing ${tool}`);
  // 父 Agent 没开的工具不会凭空多出来（提权只按需，不擅自扩权）
  assert.ok(!grants.tools.includes("grep"));
  // 递归工具永不下放（spawn_agent 折叠成 fleet 多态工具后被拒绝）
  assert.ok(!grants.tools.includes("fleet"));
  assert.deepEqual(grants.denied, ["fleet"]);
});

test("显式 tools 按需放开，且与继承结果取并集（不会削减）", () => {
  const grants = resolveChildTools({
    parentActive: ["read"],
    requested: ["bash", "powershell"],
    available: [...FULL_REGISTRY, "powershell"],
  });
  // 旧名字（powershell）折叠成 shell 多态工具，不再作为独立工具下放。
  assert.ok(grants.tools.includes("shell"));
  assert.ok(grants.tools.includes("bash"));
  assert.ok(grants.tools.includes("read"));
  assert.ok(grants.tools.includes("write"));
});

test("工具集按 A-Z 排序去重（子 Agent 前缀缓存保持稳定）", () => {
  const grants = resolveChildTools({
    parentActive: ["write", "read", "read", "bash"],
    requested: ["bash"],
    available: FULL_REGISTRY,
  });
  assert.deepEqual(grants.tools, [...grants.tools].sort());
  assert.equal(new Set(grants.tools).size, grants.tools.length);
  // 同输入两次结果字节一致
  const again = resolveChildTools({
    parentActive: ["write", "read", "read", "bash"],
    requested: ["bash"],
    available: FULL_REGISTRY,
  });
  assert.deepEqual(grants.tools, again.tools);
});

test("运行时没有的工具立刻抛 PERMISSION_MISSING（第一轮就上报）", () => {
  assert.throws(
    () => resolveChildTools({ requested: ["mcp__nope"], available: FULL_REGISTRY }),
    (error: unknown) =>
      error instanceof ToolGrantError &&
      error.code === "PERMISSION_MISSING" &&
      error.message.includes("mcp__nope"),
  );
});

test("没有任何可下放工具时也报权限缺失，而不是派生一个瞎子", () => {
  assert.throws(
    () => resolveChildTools({ available: ["spawn_agent", "herdr_spawn"] }),
    (error: unknown) => error instanceof ToolGrantError,
  );
});

test("递归 / UI 副作用工具一律拒绝", () => {
  for (const name of ["spawn_agent", "herdr_spawn", "orchestrator_spawn", "desktop_use_tool", "web_preview"]) {
    assert.ok(isChildToolDenied(name), `${name} should be denied`);
  }
  assert.ok(!isChildToolDenied("bash"));
});

test("子 Agent 自述包含真实工具清单，避免它以为自己是瞎子", () => {
  const summary = childToolSummary(["bash", "read"], ["herdr_spawn"]);
  assert.ok(summary.includes("bash, read"));
  assert.ok(summary.includes("herdr_spawn"));
  assert.ok(summary.includes("never fabricate"));
});
