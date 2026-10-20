# Agent Host contract

TypeScript contract shared by the Next.js server (client) and the Agent Host
(server).

## Layout

- `protocol.ts` — protocol version, frame envelopes, error codes, limits.
- `methods.ts` — typed method map (`domain.verb`).
- `events.ts` — event topics and payloads.
- `guards.ts` — runtime frame validation used at the host boundary.
- `client.ts` — `AgentHostClient` interface implemented by every transport.

## Rules

1. This directory contains **types and protocol constants only**. Business
   logic lives in `agent-host/` (server side) or `lib/` (Next side).
2. Imports inside this directory use explicit `.ts` extensions so the same
   sources compile under Next (`moduleResolution: bundler`) and the host
   (`rewriteRelativeImportExtensions`).
3. Methods are named `<domain>.<verb>`. Parameters and results are objects;
   never add positional arguments.
4. Every new method must be added to `AgentHostMethods` **and** to
   `IMPLEMENTED_HOST_METHODS` once the host actually handles it.
5. The host validates every inbound frame with `guards.ts`; the client-side
   validation performed by Next.js route handlers is not trusted.

## Transports

- Production/desktop: Windows named pipe (`\\.\pipe\piforge-agent-*`) or a Unix
  domain socket under the app data directory.
- Tests: in-process direct transport (same `AgentHostClient` interface).

No TCP listener, no WebSocket, no localhost HTTP is exposed by the host.
