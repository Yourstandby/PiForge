/**
 * 流健康度判定（纯函数）。
 *
 * 背景：SSE 断掉时界面原先只停在「PiForge 正在思考…」——因为所有内容都靠
 * `agent_end → reloadSession` 从磁盘重载，用户不点「停止」就永远看不到已经产出的
 * 结果。"连上了但一个字节都没来"（服务端把响应缓冲住、或 host 侧订阅没接上）与
 * "连接反复失败"是两个不同的故障，这里分别给出可操作的提示。
 */
import type { ConnectionStatus } from "./agent-events-manager";

/**
 * 运行中多久没收到任何真实增量就算「疑似卡住」。
 *
 * 120s：正常流式每几百毫秒就有 message_update，但长 bash 工具（tsc / build / 测试）
 * 在跑的时候本来就不吐事件，30s 会把「工具在正常干活」误报成卡死；
 * provider 攒完一次性返回、长思考阶段不出增量同理。2 分钟是可容忍的上限。
 */
export const STREAM_STALL_MS = 120_000;

export type StreamHealth =
  | { kind: "ok" }
  | { kind: "reconnecting"; attempts: number }
  | { kind: "failed"; attempts: number }
  | { kind: "stalled"; idleMs: number };

export function evaluateStreamHealth(input: {
  agentRunning: boolean;
  status: ConnectionStatus;
  lastEventAt: number;
  now: number;
  attempts?: number;
  stallMs?: number;
}): StreamHealth {
  const { agentRunning, status, lastEventAt, now } = input;
  const attempts = input.attempts ?? 0;
  const stallMs = input.stallMs ?? STREAM_STALL_MS;

  // 未运行时不关心断流：下一轮 handleSend 会重新 connectEvents。
  if (!agentRunning) return { kind: "ok" };
  if (status === "failed") return { kind: "failed", attempts };
  if (status === "connecting" || status === "disconnected") {
    return { kind: "reconnecting", attempts };
  }

  // connected：连接在，但没有增量 —— 缓冲/订阅错位的典型形态。
  if (!lastEventAt) return { kind: "ok" };
  const idleMs = now - lastEventAt;
  return idleMs >= stallMs ? { kind: "stalled", idleMs } : { kind: "ok" };
}
