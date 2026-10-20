import type {
  ClientFrame,
  ClientRole,
  HostError,
  HostErrorCode,
  HostFrame,
} from "./protocol.ts";

const CLIENT_ROLES: readonly ClientRole[] = ["next-server", "cli", "dev-script"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHostError(value: unknown): HostError | null {
  if (!isRecord(value)) return null;
  if (typeof value.code !== "string" || typeof value.message !== "string") return null;
  const error: HostError = {
    code: value.code as HostErrorCode,
    message: value.message,
  };
  if (typeof value.retryable === "boolean") error.retryable = value.retryable;
  if (isRecord(value.details)) error.details = value.details;
  return error;
}

/**
 * Parse one NDJSON line into a client frame.
 *
 * Shape validation only: method names and parameter payloads are validated
 * again by the host dispatcher. Returning null means "drop the frame and
 * close the connection" — a host must never guess at malformed input.
 */
export function parseClientFrame(line: string): ClientFrame | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;

  switch (raw.kind) {
    case "hello": {
      if (typeof raw.protocolVersion !== "number") return null;
      if (typeof raw.token !== "string") return null;
      const client = raw.client;
      if (!isRecord(client)) return null;
      if (typeof client.pid !== "number" || !Number.isFinite(client.pid)) return null;
      if (typeof client.role !== "string") return null;
      if (!CLIENT_ROLES.includes(client.role as ClientRole)) return null;
      return {
        kind: "hello",
        protocolVersion: raw.protocolVersion,
        token: raw.token,
        client: { pid: client.pid, role: client.role as ClientRole },
      };
    }
    case "req": {
      if (typeof raw.id !== "number" || !Number.isFinite(raw.id)) return null;
      if (typeof raw.method !== "string" || raw.method.length === 0) return null;
      if (!isRecord(raw.params)) return null;
      if (raw.clientRequestId !== undefined && typeof raw.clientRequestId !== "string") {
        return null;
      }
      const frame: ClientFrame = {
        kind: "req",
        id: raw.id,
        method: raw.method,
        params: raw.params,
      };
      if (typeof raw.clientRequestId === "string") {
        frame.clientRequestId = raw.clientRequestId;
      }
      return frame;
    }
    case "cancel": {
      if (typeof raw.id !== "number" || !Number.isFinite(raw.id)) return null;
      return { kind: "cancel", id: raw.id };
    }
    case "pong": {
      if (typeof raw.nonce !== "number" || !Number.isFinite(raw.nonce)) return null;
      return { kind: "pong", nonce: raw.nonce };
    }
    default:
      return null;
  }
}

/**
 * Parse one NDJSON line into a host frame. The host is trusted, but a broken
 * or truncated pipe must not throw inside the client's data handler.
 */
export function parseHostFrame(line: string): HostFrame | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;

  switch (raw.kind) {
    case "hello_ok": {
      const { protocolVersion, hostPid, startedAt } = raw;
      if (typeof protocolVersion !== "number") return null;
      if (typeof hostPid !== "number" || !Number.isFinite(hostPid)) return null;
      if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
      return { kind: "hello_ok", protocolVersion, hostPid, startedAt };
    }
    case "hello_error": {
      const error = parseHostError(raw.error);
      if (!error) return null;
      return { kind: "hello_error", error };
    }
    case "res": {
      if (typeof raw.id !== "number" || !Number.isFinite(raw.id)) return null;
      if (raw.ok === true) {
        return { kind: "res", id: raw.id, ok: true, result: raw.result };
      }
      if (raw.ok === false) {
        const error = parseHostError(raw.error);
        if (!error) return null;
        return { kind: "res", id: raw.id, ok: false, error };
      }
      return null;
    }
    case "evt": {
      if (typeof raw.subscriptionId !== "string") return null;
      if (typeof raw.seq !== "number" || !Number.isFinite(raw.seq)) return null;
      if (typeof raw.topic !== "string") return null;
      return {
        kind: "evt",
        subscriptionId: raw.subscriptionId,
        seq: raw.seq,
        topic: raw.topic,
        payload: raw.payload,
      };
    }
    case "ping": {
      if (typeof raw.nonce !== "number" || !Number.isFinite(raw.nonce)) return null;
      return { kind: "ping", nonce: raw.nonce };
    }
    default:
      return null;
  }
}
