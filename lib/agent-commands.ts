/**
 * Whitelist of command types accepted by POST /api/agent/[id] → session.send().
 * Must stay in sync with the `switch (type)` cases in lib/rpc-manager.ts.
 * Defense in depth: even if middleware Origin check is bypassed, malformed
 * commands are rejected at the route boundary instead of relying on pi's
 * internal throw (which could leak error details via errorMessage).
 */
const AGENT_COMMAND_TYPE_LIST = [
  "prompt",
  "abort",
  "get_state",
  "set_model",
  "fork",
  "navigate_tree",
  "set_thinking_level",
  "compact",
  "set_auto_compaction",
  "steer",
  "follow_up",
  "reorder_follow_ups",
  "remove_follow_up",
  "get_tools",
  "set_tools",
  "abort_compaction",
  "set_auto_retry",
  "set_agent_mode",
  "reload_resources",
  "extension_ui_response",
  "prewarm",
] as const;

export type AgentCommandType = (typeof AGENT_COMMAND_TYPE_LIST)[number];

export const AGENT_COMMAND_TYPES: ReadonlySet<AgentCommandType> = new Set(
  AGENT_COMMAND_TYPE_LIST
);

/**
 * RPC 默认超时是 15s（lib/agent-host-client.ts），只够一次快速往返。
 * 下面这些命令要等一次真实模型往返或重建整个 AgentSession，几分钟很正常：
 * 用默认超时会把「压缩还在跑」误报成 `agent.command timed out after 15000ms`，
 * 用户再点一次又撞上 Host 的 `Session is streaming`。
 */
export const LONG_RUNNING_AGENT_COMMAND_TIMEOUT_MS = 10 * 60_000;

/** 冷启动大会话（几百 MB jsonl + 扩展加载）同样可能超过 15s。 */
export const AGENT_ENSURE_TIMEOUT_MS = 5 * 60_000;

const LONG_RUNNING_AGENT_COMMANDS: ReadonlySet<string> = new Set([
  "compact",
  "fork",
  "reload_resources",
]);

/** 给 `agent.command` 选一个 RPC 超时；`undefined` 表示走客户端默认值。 */
export function agentCommandTimeoutMs(body: unknown): number | undefined {
  const type = (body as { type?: unknown } | null | undefined)?.type;
  if (typeof type !== "string") return undefined;
  return LONG_RUNNING_AGENT_COMMANDS.has(type)
    ? LONG_RUNNING_AGENT_COMMAND_TIMEOUT_MS
    : undefined;
}

/**
 * Minimal structural validation for an incoming agent command.
 * Returns an error message string if invalid, null if valid.
 *
 * NOTE: This is intentionally minimal — we check `type` is whitelisted and
 * that the body is an object. Deep field validation is left to
 * agent-host/rpc-manager.ts / pi (which will throw on malformed payloads,
 * surfaced as 500 with sanitized errorMessage).
 */
export function validateAgentCommand(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return "Command body must be an object";
  }
  const cmd = body as { type?: unknown };
  if (typeof cmd.type !== "string") {
    return "Command type must be a string";
  }
  if (!AGENT_COMMAND_TYPES.has(cmd.type as AgentCommandType)) {
    return `Unknown command type: ${cmd.type}`;
  }
  return null;
}
