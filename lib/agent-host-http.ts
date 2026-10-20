/**
 * Maps Agent Host RPC failures onto the HTTP error contract used by the UI.
 * Host-down / handshake problems are retryable (503); validation errors are
 * 400; everything else is an internal error.
 */
import { errorMessage, getRequestId, jsonError, logApiError } from "./api-error.ts";
import { AgentHostError, isAgentHostUnavailable } from "./agent-host-client.ts";

export function jsonAgentHostError(
  req: Request,
  error: unknown,
  context: { route: string; method: string },
): Response {
  const requestId = getRequestId(req);
  logApiError({ ...context, requestId, error });

  if (error instanceof AgentHostError) {
    const status =
      error.code === "E_INVALID_PARAMS"
        ? 400
        : isAgentHostUnavailable(error)
          ? 503
          : 500;
    return jsonError(req, status, error.message, { errorCode: error.code });
  }
  return jsonError(req, 500, errorMessage(error));
}
