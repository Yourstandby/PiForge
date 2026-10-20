/**
 * Pi SDK adapter (v0.7.0 architecture step 1).
 *
 * This is the ONLY file under `agent-host/` allowed to import
 * `@earendil-works/*` directly. Everything else imports this module.
 *
 * Why a re-export facade instead of many wrapper functions:
 *   - Pi's public surface is large and mostly structural (AgentSession,
 *     SessionManager, ModelRuntime, extension types). Re-exporting keeps the
 *     adapter zero-cost while creating one, greppable upgrade seam.
 *   - When an upstream signature changes, the fix is localized here (add an
 *     overload/normalizer) instead of touching every tool and manager.
 *   - A future `resources/pi-core/index.js` loader can implement the same
 *     exports from a dynamically loaded module without changing call sites.
 *
 * Contract for business modules: do not add a direct `@earendil-works/*`
 * import outside this file. CI checks that rule (`scripts/check-sdk-imports.mjs`).
 */
import {
  createAgentSession as createPiAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";

export * from "@earendil-works/pi-coding-agent";

/** Stable error shape for Host callers; keeps upstream stack in `cause`. */
export class SdkAdapterError extends Error {
  readonly operation: string;
  readonly cause: unknown;

  constructor(operation: string, cause: unknown) {
    super(`${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SdkAdapterError";
    this.operation = operation;
    this.cause = cause;
  }
}

/**
 * Compatibility wrapper for the most common construction seam. A future Pi
 * release that renames options or changes the return shape is normalized here;
 * callers keep one Host-owned error type.
 */
export async function createHostAgentSession(
  options: CreateAgentSessionOptions,
): Promise<CreateAgentSessionResult> {
  try {
    return await createPiAgentSession(options);
  } catch (error) {
    throw new SdkAdapterError("createHostAgentSession", error);
  }
}

// Pi-ai and agent-core types used by Host managers. Keep this list explicit so
// an upstream rename is visible in one diff instead of silently breaking the
// whole Host.
export type {
  Api,
  AssistantMessage,
  ClassifierAnswer,
  ClassifierContext,
  ClassifierModel,
  ClassifierQuestion,
  Context,
  ImageContent,
  ImageModel,
  Model,
  TextContent,
} from "@earendil-works/pi-ai";
export { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
export type { ThinkingLevel } from "@earendil-works/pi-agent-core";

// MCP transport/OAuth surface used only by mcp-service.ts.
export {
  McpAuthRequiredError,
  McpClient,
  McpError,
  StdioTransport,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
export type { AuthProvider, McpTransport, Tool as McpTool } from "@earendil-works/pi-mcp";
export {
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  OAuthCallbackServer,
  authorizeMcp,
  parseWwwAuthenticate,
} from "@earendil-works/pi-mcp/oauth";
export type {
  McpOAuthState,
  McpOAuthStateStore,
  OAuthChallenge,
} from "@earendil-works/pi-mcp/oauth";
