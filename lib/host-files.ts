/**
 * Next-side adapter for the host-owned file policy.
 *
 * The host returns a canonical path after checking allowed roots and the
 * writable-path policy. Next performs the actual read/write from here.
 */
import type { AgentHostClient } from "../contract/client.ts";
import { jsonError } from "./api-error.ts";
import { jsonAgentHostError } from "./agent-host-http.ts";
import {
  AgentHostError,
  createAgentHostClient,
  getAgentHostClient,
} from "./agent-host-client.ts";

export type FileAccessOp = "read" | "write" | "list";

declare global {
  var __piforgeFilesHostClient: AgentHostClient | undefined;
}

/**
 * File authorization runs on its own connection.
 *
 * The main connection carries the agent event stream. A socket's write queue is
 * FIFO, so while a tool is streaming output the `files.authorize` response sits
 * behind those frames and the right panel spins until the 15s call timeout.
 * A dedicated connection keeps small authorization RPCs off that queue.
 *
 * Cached on `globalThis` so Next.js hot reloads reuse the connection.
 */
function filesHostClient(): AgentHostClient {
  if (!globalThis.__piforgeFilesHostClient) {
    globalThis.__piforgeFilesHostClient = createAgentHostClient();
  }
  return globalThis.__piforgeFilesHostClient;
}

export async function authorizeHostPath(
  target: string,
  op: FileAccessOp,
  scope?: string | null,
): Promise<string> {
  const params = scope ? { path: target, op, scope } : { path: target, op };
  try {
    const result = await filesHostClient().call("files.authorize", params);
    return result.realPath;
  } catch (error) {
    if (error instanceof AgentHostError) {
      // A policy answer is final.
      if (error.code === "ACCESS_DENIED") throw error;
      // Already waited out a timeout on the fast path: the shared connection
      // would only wait again, so surface the failure instead of doubling it.
      if (error.code === "E_TIMEOUT") throw error;
    }
    // Transport failure on the dedicated connection only: fall back so a shaky
    // extra socket never turns into a hard file-access error.
    const result = await getAgentHostClient().call("files.authorize", params);
    return result.realPath;
  }
}

export function isHostAccessDenied(error: unknown): boolean {
  return error instanceof AgentHostError && error.code === "ACCESS_DENIED";
}

/**
 * Host 的 ACCESS_DENIED 混着两件事：目标路径不存在（多半是链接指向了别的
 * 项目，或路径拼错），以及真的越权。以前两者都回 "Access denied"，用户
 * 看不出该去改什么。这里按 Host 的原文案把它们分开，并把目标路径带回去。
 */
const MISSING_TARGET_PATTERN = /is not accessible/i;

export function describeHostAccessDenied(
  error: unknown,
  target?: string,
): { status: number; message: string } | null {
  if (!isHostAccessDenied(error)) return null;
  const detail = error instanceof Error ? error.message : "";
  if (MISSING_TARGET_PATTERN.test(detail)) {
    return {
      status: 404,
      message: target ? `文件不存在：${target}` : "文件不存在或不可读",
    };
  }
  const reason = detail && detail !== "Access denied" ? `：${detail}` : "";
  return {
    status: 403,
    message: target ? `无权访问：${target}${reason}` : `无权访问${reason}`,
  };
}

/**
 * 上报「当前项目」：项目隔离开启时，Host 只放行这个目录内的文件访问。
 * 失败不抛：上报不上最多退回旧行为，不能因此卡住 UI。
 */
export async function setHostActiveScope(cwd: string | null): Promise<boolean> {
  try {
    await filesHostClient().call("files.setScope", { cwd });
    return true;
  } catch {
    return false;
  }
}

/** Map a host authorization failure onto the HTTP error contract. */
export function hostFileAccessError(
  req: Request,
  error: unknown,
  route: string,
  method: string,
): Response {
  if (isHostAccessDenied(error)) {
    return jsonError(req, 403, "Access denied");
  }
  return jsonAgentHostError(req, error, { route, method });
}
