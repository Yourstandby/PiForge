import type { HostSubscription } from "@contract/client";
import type { Result } from "@contract/methods";
import { getAgentHostClient } from "@/lib/agent-host-client";
import { jsonAgentHostError } from "@/lib/agent-host-http";

export const dynamic = "force-dynamic";

/** GET /api/subagents/events — SSE stream of Host-owned sub-agent status/output. */
export async function GET(req: Request) {
  const client = getAgentHostClient();

  let initial: Result<"subagents.list">;
  try {
    initial = await client.call("subagents.list", {}, { timeoutMs: 3_000 });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/subagents/events", method: "GET" });
  }

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
      const encode = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };

      encode({ type: "subagents", agents: initial.agents });

      try {
        subscription = await client.subscribe("subagents", (payload) => {
          encode({ type: "subagents", agents: payload.agents, event: payload.event });
        });
      } catch {
        cleanup();
        return;
      }
      if (closed) {
        subscription.close();
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
