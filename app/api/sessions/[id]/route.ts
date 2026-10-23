import { NextResponse } from "../../../../lib/next-server-shim.ts";
import { stat } from "fs/promises";
import type { Result } from "../../../../contract/methods.ts";
import {
  resolveSessionPath,
  invalidateSessionIndex,
  invalidateSessionPathCache,
  buildSessionContext,
  getSessionEntriesAsync,
  getLeafId,
  getSessionName,
} from "../../../../lib/session-reader.ts";
import { getAgentHostClient } from "../../../../lib/agent-host-client.ts";
import { jsonAgentHostError } from "../../../../lib/agent-host-http.ts";
import { errorMessage, getRequestId, jsonError, logApiError } from "../../../../lib/api-error.ts";

/**
 * Read a session's entries, tolerating a not-yet-flushed file for live
 * sessions. The active AgentSession lives in the Agent Host; `live` comes from
 * `sessions.state`.
 */
async function readEntriesTolerant(
  filePath: string,
  live: boolean,
): Promise<Awaited<ReturnType<typeof getSessionEntriesAsync>>> {
  try {
    return await getSessionEntriesAsync(filePath);
  } catch (error) {
    const missing = (error as { code?: string }).code === "ENOENT";
    if (!missing || !live) throw error;
    return [];
  }
}

/** 短预览：分支导航只需一段文本，不把整条消息（含全文）塞进响应。 */
function previewText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content.replace(/\s+/g, " ").trim().slice(0, 60);
  if (Array.isArray(content)) {
    const text = (content.find((b) => (b as { type?: string })?.type === "text") as
      | { text?: string }
      | undefined)?.text;
    return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  }
  return "";
}

/**
 * 分支树瘦身：节点只保留 id/parentId/type/role + 预览 label，
 * 不再携带完整 entry（含全部消息正文）。这是单会话响应 ~18MB 的主因之一
 * （tree 与 context.messages 完全重复）。
 */
function buildBranchTree(entries: Array<Record<string, unknown>>): unknown[] {
  const labels = new Map<string, string>();
  for (const e of entries) {
    if (e.type === "label") {
      const l = e as { targetId: string; label?: string };
      if (l.label) labels.set(l.targetId, l.label);
      else labels.delete(l.targetId);
    }
  }
  type Node = { entry: Record<string, unknown>; children: unknown[]; label: string };
  const nodes = new Map<string, Node>();
  for (const e of entries) {
    const message = e.message as { role?: string; content?: unknown } | undefined;
    const id = String(e.id);
    nodes.set(id, {
      entry: {
        id: e.id,
        parentId: e.parentId,
        type: e.type,
        timestamp: e.timestamp,
        ...(message ? { message: { role: message.role } } : {}),
      },
      children: [],
      label: labels.get(id) ?? (message ? previewText(message) : String(e.type)),
    });
  }
  const roots: unknown[] = [];
  for (const e of entries) {
    const node = nodes.get(String(e.id))!;
    const parent = e.parentId ? nodes.get(String(e.parentId)) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const requestId = getRequestId(req);
  const tStart = performance.now();
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return jsonError(req, 404, "Session not found");
    }

    let hostState: Result<"sessions.state"> = { running: false };
    try {
      hostState = await getAgentHostClient().call("sessions.state", { sessionId: id });
    } catch {
      // Host down: history is still readable from disk.
    }

    const entries = await readEntriesTolerant(filePath, hostState.running);
    const tree = buildBranchTree(entries as unknown as Array<Record<string, unknown>>);
    const leafId = getLeafId(entries);
    const fullContext = buildSessionContext(entries, leafId);
    // ?tail=N：分页首屏只返回最近 N 条消息；不传则全量（向后兼容）。
    // 配套上滚加载：/api/sessions/[id]/context?before=<entryId>。
    const tailParam = Number.parseInt(new URL(req.url).searchParams.get("tail") ?? "", 10);
    const tail = Number.isFinite(tailParam) && tailParam > 0 ? Math.min(tailParam, 1000) : 0;
    const totalMessages = fullContext.messages.length;
    const cut = tail > 0 && totalMessages > tail ? totalMessages - tail : 0;
    const context = cut > 0
      ? {
          ...fullContext,
          messages: fullContext.messages.slice(cut),
          entryIds: fullContext.entryIds.slice(cut),
        }
      : fullContext;
    const hasMore = cut > 0;
    const prevCursor = hasMore ? context.entryIds[0] ?? null : null;
    const diskHeader = entries.length > 0 && (entries[0] as unknown as { type: string }).type === "session"
      ? entries[0] as unknown as { id: string; cwd?: string; timestamp: string }
      : null;
    // A brand-new session is registered in the host before pi flushes the
    // first entry — report what the live session knows instead of 500-ing the
    // renderer that is about to show an extension dialog.
    const header = diskHeader ?? hostState.liveHeader ?? null;
    let modified = header?.timestamp ?? new Date().toISOString();
    try {
      const fileStat = await stat(filePath);
      modified = fileStat.mtime.toISOString();
    } catch { /* use header timestamp */ }
    // 父会话 id 只用于左侧会话树（数据来自 /api/sessions 列表）。单会话加载
    // 不需要，也不再为它跑一次全目录扫描（那会 stat 并读每个
    // 会话文件，是打开历史会话 2-3s 的主要固定开销）。
    const info = header ? {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: getSessionName(entries),
      created: header.timestamp,
      modified,
      // 对话次数 = 用户消息条数（与侧栏列表口径一致）
      messageCount: context.messages.filter((m) => m.role === "user").length,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = context.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
    } : null;

    const url = new URL(req.url);
    const agentState = url.searchParams.has("includeState")
      ? hostState.running
        ? { running: true, state: hostState.state }
        : { running: false }
      : undefined;

    // 体积/耗时探测：用来判断“大会话分页”是否值得做。单条日志开销可忽略，
    // 日志出现在 Next 服务端控制台 / Electron 主进程输出。
    const body = JSON.stringify({
      sessionId: id,
      filePath,
      info,
      tree,
      leafId,
      context,
      hasMore,
      prevCursor,
      ...(agentState !== undefined ? { agentState } : {}),
    });
    const elapsedMs = Math.round(performance.now() - tStart);
    const bodyKb = Math.round(body.length / 1024);
    console.info(
      `[session-load] ${id} entries=${entries.length} msgs=${context.messages.length} tree=${tree.length} body=${bodyKb}KB elapsed=${elapsedMs}ms`,
    );
    return new NextResponse(body, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    logApiError({ route: "/api/sessions/[id]", method: "GET", requestId, error, params: { id } });
    return jsonError(req, 500, errorMessage(error));
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return jsonError(req, 400, "name is required");
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return jsonError(req, 404, "Session not found");
    }
    await getAgentHostClient().call("sessions.rename", { sessionId: id, filePath, name });
    invalidateSessionIndex();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/sessions/[id]", method: "PATCH" });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return jsonError(req, 404, "Session not found");
    }
    await getAgentHostClient().call("sessions.delete", { sessionId: id, filePath });
    invalidateSessionPathCache(id);
    invalidateSessionIndex();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/sessions/[id]", method: "DELETE" });
  }
}
