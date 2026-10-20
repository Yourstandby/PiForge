import { NextResponse } from "next/server";
import { stat } from "fs/promises";
import type { Result } from "@contract/methods";
import {
  resolveSessionPath,
  invalidateSessionPathCache,
  buildSessionContext,
  listAllSessions,
  getSessionEntriesAsync,
  buildTree,
  getLeafId,
  getSessionName,
} from "@/lib/session-reader";
import { getAgentHostClient } from "@/lib/agent-host-client";
import { jsonAgentHostError } from "@/lib/agent-host-http";
import { errorMessage, getRequestId, jsonError, logApiError } from "@/lib/api-error";

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

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const requestId = getRequestId(req);
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
    const tree = buildTree(entries);
    const leafId = getLeafId(entries);
    const context = buildSessionContext(entries, leafId);

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
    const allSessions = await listAllSessions();
    const parentSessionId = allSessions.find((s) => s.id === id)?.parentSessionId;
    const info = header ? {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: getSessionName(entries),
      created: header.timestamp,
      modified,
      messageCount: context.messages.length,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = context.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
    } : null;

    const url = new URL(req.url);
    const agentState = url.searchParams.has("includeState")
      ? hostState.running
        ? { running: true, state: hostState.state }
        : { running: false }
      : undefined;

    return NextResponse.json({
      sessionId: id,
      filePath,
      info,
      tree,
      leafId,
      context,
      ...(agentState !== undefined ? { agentState } : {}),
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
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonAgentHostError(req, error, { route: "/api/sessions/[id]", method: "DELETE" });
  }
}
