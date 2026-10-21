import test from "node:test";
import assert from "node:assert/strict";
import type { HerdrAgentView } from "@contract/domains/herdr";
import type { FleetAgentProfile } from "@contract/domains/fleet";
import {
  FLEET_TOOL_CHOICES,
  fleetAgentRow,
  fleetStatusLabel,
  isFleetAgentActive,
  pairFleetRows,
  sortAgentRows,
  sortFleetRows,
  subagentRow,
} from "./fleet-view.ts";

function profile(name: string, updatedAt = 1): FleetAgentProfile {
  return {
    id: `fleet-${name}`,
    name,
    systemPrompt: `${name} prompt`,
    tools: ["read"],
    persistent: true,
    createdAt: updatedAt,
    updatedAt,
  };
}

function herdrAgent(
  id: string,
  name: string,
  status: HerdrAgentView["status"],
  startedAt: number,
  extra: Partial<HerdrAgentView> = {},
): HerdrAgentView {
  return {
    id,
    name,
    task: `${name} task`,
    parentSessionId: "p",
    status,
    activity: status === "running" ? "idle" : "idle",
    startedAt,
    endedAt: status === "running" || status === "starting" ? null : startedAt + 10,
    durationMs: 10,
    finishedAt: null,
    verified: false,
    turns: 1,
    output: "",
    toolCalls: [],
    verification: { verified: false, checkedAt: 0, reason: "", evidence: [] },
    ...extra,
  };
}

test("fleet tool choices are the read-only set", () => {
  assert.deepEqual(FLEET_TOOL_CHOICES.map((tool) => tool.id), ["read", "grep", "find", "ls"]);
});

test("profiles pair with their live agent by name", () => {
  const rows = pairFleetRows(
    [profile("auditor"), profile("researcher")],
    [herdrAgent("h1", "auditor", "running", 100)],
  );
  const auditor = rows.find((row) => row.profile.name === "auditor");
  const researcher = rows.find((row) => row.profile.name === "researcher");
  assert.equal(auditor?.agent?.id, "h1");
  assert.equal(auditor?.dormant, false);
  assert.equal(researcher?.agent, null);
  assert.equal(researcher?.dormant, true, "没唤醒的配置要显示为待唤醒");
});

test("a herdr agent without a saved profile still shows up", () => {
  const rows = pairFleetRows([], [herdrAgent("h9", "spawned-by-model", "running", 5)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent?.id, "h9");
  assert.equal(rows[0].profile.persistent, false);
});

test("stopped agents do not claim their profile (shows as dormant)", () => {
  const rows = pairFleetRows([profile("auditor")], [herdrAgent("h1", "auditor", "stopped", 10)]);
  assert.equal(rows[0].agent, null);
  assert.equal(rows[0].dormant, true);
});

test("fleet rows sort live first, then newest, dormant last", () => {
  const rows = sortFleetRows([
    { profile: profile("dormant-old", 10), agent: null, dormant: true },
    {
      profile: profile("live-old"),
      agent: herdrAgent("h1", "live-old", "running", 100),
      dormant: false,
    },
    {
      profile: profile("live-new"),
      agent: herdrAgent("h2", "live-new", "running", 200),
      dormant: false,
    },
    { profile: profile("dormant-new", 300), agent: null, dormant: true },
  ]);
  assert.deepEqual(
    rows.map((row) => row.profile.name),
    ["live-new", "live-old", "dormant-new", "dormant-old"],
  );
});

test("subagent rows put running ones first and keep the task text", () => {
  const rows = sortAgentRows([
    subagentRow({ id: "a1", name: "done", task: "t1", status: "completed", startedAt: 300 }),
    subagentRow({ id: "a2", name: "live", task: "目标：审查登录", status: "running", startedAt: 100 }),
  ]);
  assert.equal(rows[0].id, "a2");
  assert.equal(rows[0].active, true);
  assert.equal(rows[0].task, "目标：审查登录");
});

test("fleet agent rows surface the working state and turn count", () => {
  const row = fleetAgentRow(herdrAgent("h1", "auditor", "running", 10, { activity: "working", turns: 2 }));
  assert.equal(row.kind, "fleet");
  assert.equal(row.status, "working");
  assert.equal(row.active, true);
  assert.equal(row.turns, 2);
});

test("status labels collapse to idle / error / terminal wording", () => {
  assert.equal(fleetStatusLabel(null), "待唤醒");
  assert.equal(fleetStatusLabel(herdrAgent("h", "a", "starting", 1)), "启动中");
  assert.equal(fleetStatusLabel(herdrAgent("h", "a", "running", 1, { activity: "working" })), "运行中");
  assert.equal(fleetStatusLabel(herdrAgent("h", "a", "running", 1, { activity: "idle" })), "待命");
  assert.equal(
    fleetStatusLabel(herdrAgent("h", "a", "running", 1, { activity: "idle", error: "熔断" })),
    "出错",
  );
  assert.equal(fleetStatusLabel(herdrAgent("h", "a", "crashed", 1)), "已崩溃");
  assert.equal(fleetStatusLabel(herdrAgent("h", "a", "stopped", 1)), "已停止");
});

test("only starting/running/stopping count as live", () => {
  assert.equal(isFleetAgentActive(null), false);
  assert.equal(isFleetAgentActive(herdrAgent("h", "a", "starting", 1)), true);
  assert.equal(isFleetAgentActive(herdrAgent("h", "a", "running", 1)), true);
  assert.equal(isFleetAgentActive(herdrAgent("h", "a", "stopped", 1)), false);
  assert.equal(isFleetAgentActive(herdrAgent("h", "a", "crashed", 1)), false);
});
