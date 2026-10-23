import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getConfigVersion, onConfigChange, startAgentConfigWatcher } from "../../../../lib/config-watcher.ts";

export const dynamic = "force-dynamic";

// GET /api/config/events - SSE stream of ~/.pi/agent config changes
export async function GET(req: Request) {
  const agentDir = getAgentDir();
  startAgentConfigWatcher(agentDir);

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let cleaned = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    try {
      controllerRef?.close();
    } catch {
      /* already closed */
    }
    req.signal?.removeEventListener("abort", cleanup);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      const encode = (data: unknown) => {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      encode({ type: "connected", version: getConfigVersion() });
      unsubscribe = onConfigChange((change) => {
        encode({ type: "config_changed", ...change });
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
