import { listManagedProcesses, onManagedProcessesChange } from "@/lib/managed-processes";

export const dynamic = "force-dynamic";

// GET /api/processes/events - SSE stream of the managed-process list + logs
export async function GET(req: Request) {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let lastSentAt = 0;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (trailing) clearTimeout(trailing);
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
      const send = () => {
        if (closed) return;
        lastSentAt = Date.now();
        encode({ type: "processes", processes: listManagedProcesses() });
      };
      // Coalesce bursts of output into at most ~4 updates/second.
      const schedule = () => {
        if (closed) return;
        const wait = 250 - (Date.now() - lastSentAt);
        if (wait <= 0) {
          send();
          return;
        }
        if (trailing) return;
        trailing = setTimeout(() => {
          trailing = undefined;
          send();
        }, wait);
      };

      send();
      unsubscribe = onManagedProcessesChange(schedule);

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
