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

export async function authorizeHostPath(target: string, op: FileAccessOp): Promise<string> {
  const params = { path: target, op };
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
