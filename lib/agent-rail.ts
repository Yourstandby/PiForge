/**
 * 右栏 Agents 的分组（项目 → 会话）。
 *
 * 要解决的问题：子 Agent / 舰队 Agent 以前只有一张全局列表，做完做不完都看不出
 * 它是哪个项目的哪个对话派生出来的。这里把「归属」做成纯函数：
 *   - scope: session（当前对话派生）> project（当前项目、其它对话）> other（其它项目）
 *   - 组内按运行状态 / 开始时间排序，组间按「本会话 → 本项目 → 其它」排
 *
 * 纯函数、不碰网络，方便单测（UI 只负责渲染返回值）。
 */

export type RailAgentKind = "subagent" | "fleet";

export interface RailAgentInput {
  id: string;
  kind: RailAgentKind;
  name: string;
  status: string;
  cwd?: string;
  parentSessionId: string;
  startedAt: number;
  durationMs: number;
  verified?: boolean;
  error?: string;
}

export interface RailAgent extends RailAgentInput {
  running: boolean;
  /** 终态且没有测试证据：UI 显示"未验证"徽章。 */
  unverified: boolean;
}

export interface RailAgentGroup {
  key: string;
  scope: "session" | "project" | "other";
  projectName: string;
  sessionTitle: string;
  parentSessionId: string;
  cwd: string;
  running: number;
  failed: number;
  agents: RailAgent[];
  /** 组内最新的结束时间，用于组间次要排序。 */
  latestAt: number;
}

const RUNNING_STATUSES = new Set(["running", "starting", "stopping"]);

export function isRunningStatus(status: string): boolean {
  return RUNNING_STATUSES.has(status);
}

/** 末段目录名即项目名（Windows / POSIX 都吃）。 */
export function projectNameOf(cwd: string | undefined): string {
  if (!cwd) return "未归属项目";
  const normalized = cwd.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/);
  return parts[parts.length - 1] || normalized;
}

/** 只有路径比较需要归一：大小写与分隔符不该造成两个"同一个项目"。 */
export function sameCwd(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ===
    b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function shortSessionTitle(title: string | undefined, sessionId: string): string {
  const trimmed = title?.trim();
  if (trimmed) return trimmed;
  const tail = sessionId.replace(/^session[-_]?/, "");
  return tail.length > 6 ? `会话 ${tail.slice(0, 6)}` : `会话 ${tail}`;
}

export function groupAgentsForRail(
  agents: readonly RailAgentInput[],
  options: {
    activeCwd: string | null;
    activeSessionId: string | null;
    /** sessionId → 会话标题（没有就显示短 id）。 */
    sessionTitleById?: Readonly<Record<string, string | undefined>>;
    /** 最多保留多少个分组（其余折叠成计数，避免长列表）。 */
    maxGroups?: number;
  },
): { groups: RailAgentGroup[]; hiddenGroups: number; running: number; unverified: number } {
  const titleOf = options.sessionTitleById ?? {};
  const bySession = new Map<string, RailAgentGroup>();

  for (const agent of agents) {
    const running = isRunningStatus(agent.status);
    const unverified = !running && agent.verified === false;
    const key = agent.parentSessionId || "unknown";
    let group = bySession.get(key);
    if (!group) {
      group = {
        key,
        scope: agent.parentSessionId === options.activeSessionId
          ? "session"
          : sameCwd(agent.cwd, options.activeCwd ?? undefined)
            ? "project"
            : "other",
        projectName: projectNameOf(agent.cwd),
        sessionTitle: shortSessionTitle(titleOf[agent.parentSessionId], agent.parentSessionId || "unknown"),
        parentSessionId: agent.parentSessionId,
        cwd: agent.cwd ?? "",
        running: 0,
        failed: 0,
        agents: [],
        latestAt: 0,
      };
      bySession.set(key, group);
    }
    group.agents.push({ ...agent, running, unverified });
    if (running) group.running += 1;
    if (!running && (agent.status === "failed" || agent.status === "stopped" || agent.status === "crashed")) {
      group.failed += 1;
    }
    group.latestAt = Math.max(group.latestAt, agent.startedAt + agent.durationMs);
  }

  const all = [...bySession.values()];
  for (const group of all) {
    group.agents.sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      return b.startedAt - a.startedAt;
    });
  }

  const scopeRank = { session: 0, project: 1, other: 2 } as const;
  all.sort((a, b) => {
    const rank = scopeRank[a.scope] - scopeRank[b.scope];
    if (rank !== 0) return rank;
    if (a.running !== b.running) return b.running - a.running;
    return b.latestAt - a.latestAt;
  });

  const maxGroups = options.maxGroups ?? 6;
  const running = all.reduce((sum, group) => sum + group.running, 0);
  const unverified = all.reduce(
    (sum, group) => sum + group.agents.filter((agent) => agent.unverified).length,
    0,
  );

  return {
    groups: all.slice(0, maxGroups),
    hiddenGroups: Math.max(0, all.length - maxGroups),
    running,
    unverified,
  };
}
