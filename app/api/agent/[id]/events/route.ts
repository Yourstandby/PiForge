import { resolveSessionPath, getHeaderAsync } from "../../../../../lib/session-reader.ts";
import type { HostSubscription } from "../../../../../contract/client.ts";
import { getAgentHostClient } from "../../../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../../../lib/agent-host-http.ts";
import { getRequestId, jsonError, logApiError } from "../../../../../lib/api-error.ts";
import { AGENT_ENSURE_TIMEOUT_MS } from "../../../../../lib/agent-commands.ts";

export const dynamic = "force-dynamic";

/** SSE 心跳间隔（也是 keepAlive 探测间隔）。 */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** keepAlive 单次超时：host 忙（长工具）时别 2s 就判死。 */
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
/** 连续多少次 keepAlive 失败（且 host 不在 ready）才认定流已死。 */
const KEEP_ALIVE_MAX_FAILURES = 3;

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

    await client.call(
      "agent.ensure",
      { sessionId: id, filePath, cwd },
      { timeoutMs: AGENT_ENSURE_TIMEOUT_MS },
    );
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
  // 渲染进程每次重连都会新建 EventSource（不带 Last-Event-ID），它把「浏览器真正
  // 收到的最后一条序号」放在 ?lastEventId= 里，两处取向都接受。
  const queryLastEventId = Number(new URL(req.url).searchParams.get("lastEventId") ?? "");
  const resumeAfter = [lastEventId, queryLastEventId]
    .filter((value) => Number.isFinite(value) && value > 0)
    .reduce((max, value) => Math.max(max, value), 0);
  const fromSeq = resumeAfter > 0 ? resumeAfter + 1 : undefined;

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let keepAliveFailures = 0;
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

      // host 管道短暂抖动（connecting / reconnecting / idle）时**不关流**：
      // 本进程里的 agent hub 还挂着监听，host 重连成功后会 resubscribe 并从最后
      // 投递的序号续发，事件直接续到这条 SSE 上，用户看不到任何中断。
      // 原先「status !== ready 就 cleanup」把每次抖动都变成一次浏览器断流重连，
      // 于是长工具跑着（agent 明明在工作）的时候界面反复弹「事件流重连中」。
      offStatus = client.onStatusChange((status) => {
        if (status === "closed") cleanup();
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
        void client
          .call("agent.keepAlive", { sessionId: id }, { timeoutMs: KEEP_ALIVE_TIMEOUT_MS })
          .then(() => {
            keepAliveFailures = 0;
          })
          .catch(() => {
            // 偶发超时（host 正忙）不算断线：hub 自己会续订，别把流关掉。
            if (client.status === "ready") return;
            keepAliveFailures += 1;
            // 连续失败说明 host 真的没了，才收流让浏览器重连并把状态摆上界面。
            if (keepAliveFailures >= KEEP_ALIVE_MAX_FAILURES) cleanup();
          });
      }, HEARTBEAT_INTERVAL_MS);

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
