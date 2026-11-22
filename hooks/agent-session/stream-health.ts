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

/**
 * 本轮起步宽限：agentRunning 刚翻成 true 的头几秒里，status 还可能是上一轮留下的
 * disconnected（handleSend 先 dispatch start，connect 在 await 之后才发生），或者
 * SSE 刚建连就被浏览器取消重来一次。这些都不是「断流」，本来也不该提示；超过宽限
 * 仍没连上才报。原先的判定只看 status，于是每次发送都会闪一下提示条。
 */
export const STREAM_STARTUP_GRACE_MS = 3_000;

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
  /** agentRunning 变成 true 的时刻（0/undefined 表示未知，按无宽限处理）。 */
  runningSince?: number;
  startupGraceMs?: number;
}): StreamHealth {
  const { agentRunning, status, lastEventAt, now } = input;
  const attempts = input.attempts ?? 0;
  const stallMs = input.stallMs ?? STREAM_STALL_MS;
  const graceMs = input.startupGraceMs ?? STREAM_STARTUP_GRACE_MS;
  const runningSince = input.runningSince ?? 0;
  const starting = runningSince > 0 && now - runningSince < graceMs;

  // 未运行时不关心断流：下一轮 handleSend 会重新 connectEvents。
  if (!agentRunning) return { kind: "ok" };
  if (status === "failed") return { kind: "failed", attempts };
  // 起步宽限内的「还没连上」是正常开局，不是断流（见 STREAM_STARTUP_GRACE_MS）。
  if (starting && (status === "connecting" || status === "disconnected")) return { kind: "ok" };
  // 本轮刚发出的 connect 还在握手阶段（attempts=0）：这是正常开局，不是断流。
  // 表面上像故障，实际只是 SSE 还没建连。真正的重连一定是从 attempts>=1 开始的。
  if (attempts === 0 && (status === "connecting" || status === "disconnected")) {
    return { kind: "ok" };
  }
  if (status === "connecting" || status === "disconnected") {
    return { kind: "reconnecting", attempts };
  }

  // connected：连接在，但没有增量 —— 缓冲/订阅错位的典型形态。
  if (!lastEventAt) return { kind: "ok" };
  const idleMs = now - lastEventAt;
  return idleMs >= stallMs ? { kind: "stalled", idleMs } : { kind: "ok" };
}
