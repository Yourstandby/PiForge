import type { HostSubscription } from "@contract/client";
import type { Result } from "@contract/methods";
import { getAgentHostClient } from "@/lib/agent-host-client";
import { jsonAgentHostError } from "@/lib/agent-host-http";

export const dynamic = "force-dynamic";

// GET /api/processes/events - SSE stream of the host-owned process list + logs
export async function GET(req: Request) {
  const client = getAgentHostClient();

  let initial: Result<"processes.list">;
  try {
    initial = await client.call("processes.list", {}, { timeoutMs: 3_000 });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/processes/events", method: "GET" });
  }

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let subscription: HostSubscription | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    subscription?.close();
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
      const encode = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };

      // Snapshot from the explicit list call, then the host subscription keeps
      // the panel live. The subscription also sends its own snapshot, which is
      // harmless and covers the gap between the two calls.
      encode({ type: "processes", processes: initial.processes });

      try {
        subscription = await client.subscribe("processes", (payload) => {
          encode({ type: "processes", processes: payload.processes });
        });
      } catch {
        cleanup();
        return;
      }
      if (closed) {
        subscription.close();
        return;
      }

      heartbeat = setInterval(() => {
        if (controller.desiredSize === null) {
          cleanup();
          return;
        }
        try {
          controller.enqueue(new TextEncoder().encode(":\n\n"));
        } catch {
          cleanup();
        }
      }, 30_000);

      req.signal?.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
