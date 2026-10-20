/**
 * PiForge Agent Host wire protocol (v1).
 *
 * Transport: OS-local IPC only — a Windows named pipe or a Unix domain socket.
 * There is deliberately no TCP listener and no WebSocket.
 *
 * Framing: NDJSON. Every frame is one UTF-8 JSON object followed by "\n".
 * The receiver must buffer bytes (not strings) so multi-byte characters split
 * across socket chunks are reassembled correctly.
 *
 * Handshake: the first client frame MUST be `hello` with the matching
 * protocol version and the launch token. No other frame is accepted before
 * `hello_ok`.
 */

export const PROTOCOL_VERSION = 1 as const;

/** A client that does not complete the handshake in time is disconnected. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;
/** Host -> client ping cadence. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** No pong for this long => connection considered dead. */
export const HEARTBEAT_TIMEOUT_MS = 60_000;
/** Hard cap for one NDJSON line (control frame + future event frames). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Parent-port message used by the Electron supervisor. */
export const HOST_READY_MESSAGE_TYPE = "host_ready" as const;

export type ClientRole = "next-server" | "cli" | "dev-script";

/**
 * Error codes shared by every method. Domain-specific codes (for example
 * SESSION_NOT_FOUND) will be added when the corresponding domain moves into
 * the host; they keep the names already used by the HTTP routes.
 */
export type HostErrorCode =
  | "E_PROTOCOL"
  | "E_UNAUTHORIZED"
  | "E_HOST_UNAVAILABLE"
  | "E_FRAME_TOO_LARGE"
  | "E_TIMEOUT"
  | "E_BACKPRESSURE"
  | "E_UNKNOWN_METHOD"
  | "E_INVALID_PARAMS"
  | "E_HOST_SHUTTING_DOWN"
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_RUNNING"
  | "TARGET_ENTRY_NOT_FOUND"
  | "AGENT_START_FAILED"
  | "ACCESS_DENIED"
  | "MCP_SERVER_NOT_FOUND"
  | "MCP_PROJECT_UNTRUSTED"
  | "MCP_AUTH_REQUIRED"
  | "LTM_DISABLED"
  | "LTM_BUSY"
  | "INTERNAL";

export interface HostError {
  code: HostErrorCode;
  message: string;
  /** True when the caller may retry the same request after reconnecting. */
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export function hostError(
  code: HostErrorCode,
  message: string,
  extra?: Omit<HostError, "code" | "message">,
): HostError {
  return { code, message, ...extra };
}

// ---------------------------------------------------------------------------
// Client -> Host
// ---------------------------------------------------------------------------

export interface HelloFrame {
  kind: "hello";
  protocolVersion: number;
  token: string;
  client: {
    pid: number;
    role: ClientRole;
  };
}

export interface RequestFrame {
  kind: "req";
  id: number;
  method: string;
  params: Record<string, unknown>;
  /**
   * Optional idempotency key for mutating calls. The host keeps a small LRU
   * of recent keys so a reconnect can safely re-send a request that may have
   * been executed before the pipe dropped.
   */
  clientRequestId?: string;
}

export interface CancelFrame {
  kind: "cancel";
  id: number;
}

export interface PongFrame {
  kind: "pong";
  nonce: number;
}

export type ClientFrame = HelloFrame | RequestFrame | CancelFrame | PongFrame;

// ---------------------------------------------------------------------------
// Host -> client
// ---------------------------------------------------------------------------

export interface HelloOkFrame {
  kind: "hello_ok";
  protocolVersion: number;
  hostPid: number;
  startedAt: number;
}

export interface HelloErrorFrame {
  kind: "hello_error";
  error: HostError;
}

export interface SuccessFrame {
  kind: "res";
  id: number;
  ok: true;
  result: unknown;
}

export interface FailureFrame {
  kind: "res";
  id: number;
  ok: false;
  error: HostError;
}

export interface EventFrame {
  kind: "evt";
  subscriptionId: string;
  seq: number;
  topic: string;
  payload: unknown;
}

export interface PingFrame {
  kind: "ping";
  nonce: number;
}

export type HostFrame =
  | HelloOkFrame
  | HelloErrorFrame
  | SuccessFrame
  | FailureFrame
  | EventFrame
  | PingFrame;

// ---------------------------------------------------------------------------
// Electron utilityProcess parent-port messages
// ---------------------------------------------------------------------------

export interface HostReadyMessage {
  type: typeof HOST_READY_MESSAGE_TYPE;
  endpoint: string;
  protocolVersion: number;
  pid: number;
}

export interface HostShutdownMessage {
  type: "shutdown";
  reason?: string;
}

export type ParentMessage = HostShutdownMessage;
