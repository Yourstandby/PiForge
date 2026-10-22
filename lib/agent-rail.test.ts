import test from "node:test";
import assert from "node:assert/strict";
import {
  groupAgentsForRail,
  isRunningStatus,
  projectNameOf,
  sameCwd,
  shortSessionTitle,
  type RailAgentInput,
} from "./agent-rail.ts";

function agent(overrides: Partial<RailAgentInput> & { id: string }): RailAgentInput {
  return {
    kind: "subagent",
    name: overrides.name ?? overrides.id,
    status: "running",
    cwd: "D:/Pi/PiForge",
    parentSessionId: "session-aaa",
    startedAt: 1_000,
    durationMs: 500,
    ...overrides,
  };
}

test("本会话 / 本项目 / 其它项目 的 scoping 与顺序", () => {
  const { groups, running } = groupAgentsForRail(
    [
      agent({ id: "other", parentSessionId: "s3", cwd: "D:/Pi/Other" }),
      agent({ id: "project", parentSessionId: "s2", cwd: "D:/Pi/PiForge" }),
      agent({ id: "mine", parentSessionId: "s1", cwd: "D:/Pi/PiForge" }),
    ],
    { activeCwd: "D:/Pi/PiForge", activeSessionId: "s1" },
  );
  assert.deepEqual(groups.map((group) => group.scope), ["session", "project", "other"]);
  assert.equal(running, 3);
  assert.equal(groups[0].projectName, "PiForge");
});

test("同一会话的 Agent 归入一组，运行中的排前面", () => {
  const { groups } = groupAgentsForRail(
    [
      agent({ id: "done", status: "completed", startedAt: 900, verified: true }),
      agent({ id: "live", status: "running", startedAt: 800 }),
    ],
    { activeCwd: "D:/Pi/PiForge", activeSessionId: "session-aaa" },
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].agents.map((item) => item.id), ["live", "done"]);
  assert.equal(groups[0].running, 1);
});

test("终态但无证据 → 标未验证（与护栏口径一致）", () => {
  const { unverified, groups } = groupAgentsForRail(
    [
      agent({ id: "a", status: "completed", verified: false }),
      agent({ id: "b", status: "completed", verified: true }),
      agent({ id: "c", status: "running", verified: false }),
    ],
    { activeCwd: "D:/Pi/PiForge", activeSessionId: "session-aaa" },
  );
  assert.equal(unverified, 1);
  const flags = groups[0].agents.map((item) => item.unverified);
  assert.deepEqual(flags, [false, true, false]);
});

test("分组数超上限时折叠成 hiddenGroups 计数", () => {
  const agents = Array.from({ length: 9 }, (_, index) =>
    agent({ id: `a${index}`, parentSessionId: `s${index}` }),
  );
  const result = groupAgentsForRail(agents, {
    activeCwd: "D:/Pi/PiForge",
    activeSessionId: "s0",
    maxGroups: 3,
  });
  assert.equal(result.groups.length, 3);
  assert.equal(result.hiddenGroups, 6);
});

test("会话标题缺失时用短 id 兜底，不显示空标题", () => {
  assert.equal(shortSessionTitle("  修复 bug  ", "s1"), "修复 bug");
  const title = shortSessionTitle(undefined, "session-01a1625e7777");
  assert.ok(title.startsWith("会话 "));
  assert.ok(title.length < 20);
});

test("路径归一：大小写与分隔符不同不算两个项目", () => {
  assert.equal(sameCwd("D:\\Pi\\PiForge", "d:/pi/piforge/"), true);
  assert.equal(sameCwd("D:/Pi/PiForge", "D:/Pi/Other"), false);
  assert.equal(sameCwd(undefined, "D:/Pi/PiForge"), false);
  assert.equal(projectNameOf("D:\\Pi\\PiForge\\"), "PiForge");
  assert.equal(projectNameOf(undefined), "未归属项目");
});

test("运行态判定覆盖 starting / stopping（这两个也算在跑）", () => {
  for (const status of ["running", "starting", "stopping"]) {
    assert.equal(isRunningStatus(status), true);
  }
  for (const status of ["completed", "failed", "cancelled", "stopped", "crashed"]) {
    assert.equal(isRunningStatus(status), false);
  }
});
