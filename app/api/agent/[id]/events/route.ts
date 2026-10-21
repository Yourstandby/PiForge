import { resolveSessionPath, getHeaderAsync } from "@/lib/session-reader";
import type { HostSubscription } from "@contract/client";
import { getAgentHostClient } from "@/lib/agent-host-client";
import { jsonAgentHostError } from "@/lib/agent-host-http";
import { getRequestId, jsonError, logApiError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events.
// Next no longer owns the event queue: it subscribes to the Agent Host and
// fans the events out to the browser.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const requestId = getRequestId(req);
  const client = getAgentHostClient();

  let filePath: string;
  let cwd: string;
  try {
    const resolved = await resolveSessionPath(id);
    if (!resolved) {
      return jsonError(req, 404, "Session not found", { errorCode: "SESSION_NOT_FOUND" });
    }
    filePath = resolved;
    const header = await getHeaderAsync(filePath);
    cwd = header?.cwd ?? process.cwd();

    const trustGate = await client.call("trust.evaluate", { cwd });
    if (trustGate.action === "prompt") {
      return new Response(JSON.stringify(trustGate.payload), {
        status: 409,
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
        },
      });
    }

    await client.call("agent.ensure", { sessionId: id, filePath, cwd });
  } catch (error) {
    logApiError({
      route: "/api/agent/[id]/events",
      method: "GET",
      requestId,
      error,
      params: { id },
    });
    return jsonAgentHostError(req, error, { route: "/api/agent/[id]/events", method: "GET" });
  }

  // Browsers that auto-reconnect the same EventSource send Last-Event-ID.
  // The renderer usually creates a new EventSource, in which case the host
  // resumes from its last delivered sequence by itself.
  const lastEventId = Number(req.headers.get("last-event-id") ?? "");
  const fromSeq = Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId + 1 : undefined;

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let subscription: HostSubscription | undefined;
  let offStatus: (() => void) | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    subscription?.close();
    offStatus?.();
    try {
      controllerRef?.close();
    } catch {
      /* already closed */
    }
    req.signal?.removeEventListener("abort", cleanup);
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      const encoder = new TextEncoder();
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const sendData = (data: unknown) => send(`data: ${JSON.stringify(data)}\n\n`);
      const sendEvent = (seq: number, event: unknown) =>
        send(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`);

      sendData({ type: "connected", sessionId: id });

      try {
        subscription = await client.subscribeAgent(
          id,
          (event, seq) => sendEvent(seq, event),
          fromSeq !== undefined ? { fromSeq } : {},
        );
      } catch {
        cleanup();
        return;
      }
      if (closed) {
        subscription?.close();
        return;
      }

      offStatus = client.onStatusChange((status) => {
        if (status !== "ready") cleanup();
      });

      heartbeat = setInterval(() => {
        if (controller.desiredSize === null) {
          cleanup();
          return;
        }
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          cleanup();
          return;
        }
        void client.call("agent.keepAlive", { sessionId: id }, { timeoutMs: 2_000 }).catch(() => {
          // The next heartbeat will retry; a dead host also closes the pipe.
        });
      }, 30_000);

      req.signal?.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // 明确告诉任何反代（Nginx / Electron 侧代理）不要缓冲。
      "X-Accel-Buffering": "no",
    },
  });
}
