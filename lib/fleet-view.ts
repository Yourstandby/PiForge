/**
 * Agents 面板的展示逻辑（纯函数）：
 * 把「临时子 Agent（subagents）」和「舰队 Agent（herdr）」拼成一份有序列表，
 * 并给常驻配置生成"待唤醒"行。面板与单测共用同一套规则。
 */
import type { HerdrAgentView } from "@contract/domains/herdr";
import type { FleetAgentProfile } from "@contract/domains/fleet";

/** 舰队配置里可勾选的只读工具。 */
export const FLEET_TOOL_CHOICES = [
  { id: "read", label: "读文件" },
  { id: "grep", label: "搜内容" },
  { id: "find", label: "找文件" },
  { id: "ls", label: "列目录" },
] as const;

export type AgentRowKind = "subagent" | "fleet";

export interface AgentRow {
  kind: AgentRowKind;
  id: string;
  name: string;
  task: string;
  status: string;
  /** running / starting / working 都算"活着"。 */
  active: boolean;
  startedAt: number;
  turns?: number;
  error?: string;
}

/** 舰队配置 + 运行时：同一份配置可能还没唤醒（没有对应 agent）。 */
export interface FleetRow {
  profile: FleetAgentProfile;
  agent: HerdrAgentView | null;
  /** 还没唤醒的常驻配置（面板里显示"待唤醒"）。 */
  dormant: boolean;
}

const LIVE_STATUSES = new Set(["starting", "running", "working", "stopping"]);

export function isFleetAgentActive(agent: HerdrAgentView | null): boolean {
  return Boolean(agent && LIVE_STATUSES.has(agent.status));
}

/** 临时子 Agent → 行。 */
export function subagentRow(agent: {
  id: string;
  name: string;
  task: string;
  status: string;
  startedAt: number;
  error?: string;
}): AgentRow {
  return {
    kind: "subagent",
    id: agent.id,
    name: agent.name,
    task: agent.task,
    status: agent.status,
    active: agent.status === "running",
    startedAt: agent.startedAt,
    ...(agent.error ? { error: agent.error } : {}),
  };
}

/** 舰队 Agent → 行（带轮数）。 */
export function fleetAgentRow(agent: HerdrAgentView): AgentRow {
  return {
    kind: "fleet",
    id: agent.id,
    name: agent.name,
    task: agent.task,
    status: agent.status === "running" && agent.activity === "working" ? "working" : agent.status,
    active: isFleetAgentActive(agent),
    startedAt: agent.startedAt,
    turns: agent.turns,
    ...(agent.error ? { error: agent.error } : {}),
  };
}

/**
 * 配置 ↔ 运行时配对：
 * 优先按名字匹配（配置里保存的是名字，唤醒后 herdr 记录用的也是名字）。
 */
export function pairFleetRows(
  profiles: readonly FleetAgentProfile[],
  agents: readonly HerdrAgentView[],
): FleetRow[] {
  const rows: FleetRow[] = [];
  const claimed = new Set<string>();
  for (const profile of profiles) {
    const live = agents.find(
      (agent) => !claimed.has(agent.id) && agent.name === profile.name && isFleetAgentActive(agent),
    );
    if (live) claimed.add(live.id);
    rows.push({ profile, agent: live ?? null, dormant: !live });
  }
  // 没有配置的活跃舰队 Agent（例如模型用 herdr_spawn 直接拉的）也要显示。
  for (const agent of agents) {
    if (claimed.has(agent.id)) continue;
    rows.push({
      profile: {
        id: agent.id,
        name: agent.name,
        systemPrompt: "",
        tools: [],
        persistent: false,
        createdAt: agent.startedAt,
        updatedAt: agent.startedAt,
      },
      agent,
      dormant: false,
    });
  }
  return rows;
}

/** 面板顺序：活着的在前（新的在前），待唤醒的沉底。 */
export function sortAgentRows(rows: readonly AgentRow[]): AgentRow[] {
  return [...rows].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function sortFleetRows(rows: readonly FleetRow[]): FleetRow[] {
  return [...rows].sort((a, b) => {
    const activeA = !a.dormant && isFleetAgentActive(a.agent);
    const activeB = !b.dormant && isFleetAgentActive(b.agent);
    if (activeA !== activeB) return activeA ? -1 : 1;
    if (a.dormant !== b.dormant) return a.dormant ? 1 : -1;
    const startedA = a.agent?.startedAt ?? a.profile.updatedAt;
    const startedB = b.agent?.startedAt ?? b.profile.updatedAt;
    return startedB - startedA;
  });
}

/** 舰队 Agent 状态文案（success / error / idle 三态收敛，便于用户读）。 */
export function fleetStatusLabel(agent: HerdrAgentView | null): string {
  if (!agent) return "待唤醒";
  if (agent.status === "starting") return "启动中";
  if (agent.status === "running") {
    if (agent.activity === "working") return "运行中";
    return agent.error ? "出错" : "待命";
  }
  if (agent.status === "crashed") return "已崩溃";
  if (agent.status === "stopped") return "已停止";
  if (agent.status === "exited") return "已退出";
  return agent.status;
}
