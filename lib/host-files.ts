/**
 * Next-side adapter for the host-owned file policy.
 *
 * The host returns a canonical path after checking allowed roots and the
 * writable-path policy. Next performs the actual read/write from here.
 */
import { jsonError } from "./api-error.ts";
import { jsonAgentHostError } from "./agent-host-http.ts";
import { AgentHostError, getAgentHostClient } from "./agent-host-client.ts";

export type FileAccessOp = "read" | "write" | "list";

export async function authorizeHostPath(target: string, op: FileAccessOp): Promise<string> {
  const result = await getAgentHostClient().call("files.authorize", { path: target, op });
  return result.realPath;
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
