import { NextResponse } from "next/server";
import { stat, writeFile, rename, unlink, readdir, readFile } from "fs/promises";
import { join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  resolveSessionPath,
  invalidateSessionPathCache,
  buildSessionContext,
  listAllSessions,
  getSessionEntriesAsync,
  buildTree,
  getLeafId,
  getSessionName,
  readFirstLineAsync,
} from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { rewriteChildHeader } from "@/lib/session-cascade";
import { withFileLock } from "@/lib/session-lock";
import { errorMessage, getRequestId, jsonError, logApiError } from "@/lib/api-error";

/**
 * Read a session's entries, tolerating a not-yet-flushed file for live sessions.
 * `resolveSessionPath` is populated when the RPC session starts, but the file
 * only appears once pi appends the first entry.
 */
async function readEntriesTolerant(
  filePath: string,
  sessionId: string,
): Promise<Awaited<ReturnType<typeof getSessionEntriesAsync>>> {
  try {
    return await getSessionEntriesAsync(filePath);
  } catch (error) {
    const missing = (error as { code?: string }).code === "ENOENT";
    if (!missing || !getRpcSession(sessionId)?.isAlive()) throw error;
    return [];
  }
}

/** Header for a session that is live in memory but not on disk yet. */
function liveSessionHeader(
  sessionId: string,
): { id: string; cwd: string; timestamp: string } | null {
  const rpc = getRpcSession(sessionId);
  if (!rpc?.isAlive()) return null;
  try {
    const header = rpc.inner.sessionManager.getHeader() as
      | { cwd?: string; timestamp?: string }
      | undefined;
    return {
      id: sessionId,
      cwd: header?.cwd ?? "",
      timestamp: header?.timestamp ?? new Date().toISOString(),
    };
  } catch {
    return { id: sessionId, cwd: "", timestamp: new Date().toISOString() };
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const requestId = getRequestId(req);
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return jsonError(req, 404, "Session not found");
    }

    const entries = await readEntriesTolerant(filePath, id);
    const tree = buildTree(entries);
    const leafId = getLeafId(entries);
    const context = buildSessionContext(entries, leafId);

    const diskHeader = entries.length > 0 && (entries[0] as unknown as { type: string }).type === "session" ? entries[0] as unknown as { id: string; cwd?: string; timestamp: string } : null;
    // A brand-new session is registered in the RPC registry (and its path is
    // cached) before pi flushes the first entry — that gap widens when an
    // extension opens a dialog during session_start, because the run cannot
    // proceed until the user answers. Report what the live session knows
    // instead of 500-ing the renderer that is about to show that dialog.
    const liveHeader = diskHeader ? null : liveSessionHeader(id);
    const header = diskHeader ?? liveHeader;
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
    let agentState: { running: boolean; state?: unknown } | undefined;
    if (url.searchParams.has("includeState")) {
      const rpc = getRpcSession(id);
      if (rpc?.isAlive()) {
        // peekState() is read-only and does NOT reset the idle timer —
        // polling this endpoint must not keep idle sessions alive forever.
        const state = rpc.peekState();
        agentState = { running: true, state };
      } else {
        agentState = { running: false };
      }
    }

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
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const requestId = getRequestId(req);
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return jsonError(req, 400, "name is required");
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return jsonError(req, 404, "Session not found");
    }
    const sm = SessionManager.open(filePath);
    sm.appendSessionInfo(name.trim());
    return NextResponse.json({ ok: true });
  } catch (error) {
    logApiError({ route: "/api/sessions/[id]", method: "PATCH", requestId, error, params: { id } });
    return jsonError(req, 500, errorMessage(error));
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const requestId = getRequestId(_req);
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return jsonError(_req, 404, "Session not found");
    }

    // 1. Read parent's first line to get grandparent path
    let parentSessionPath: string | null = null;
    try {
      const firstLine = await readFirstLineAsync(filePath);
      if (firstLine) {
        const header = JSON.parse(firstLine) as { type?: string; parentSession?: string };
        if (header.type === "session") parentSessionPath = header.parentSession ?? null;
      }
    } catch { /* malformed parent — grandparent remains null */ }

    // 2. Enumerate siblings
    const dir = filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    const siblingFiles: string[] = [];
    try {
      const files = await readdir(dir);
      siblingFiles.push(
        ...files
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => join(dir, f))
          .filter((p) => p !== filePath)
      );
    } catch { /* dir unreadable — no cascade possible */ }

    // 3. Destroy any active RPC wrapper for this session.
    // Done before unlink so no new commands can race into a half-deleted session.
    // Awaited so destroy fully completes before unlink executes — fire-and-forget
    // would leave a race window where new commands could still execute during cleanup.
    try {
      await getRpcSession(id)?.destroy();
    } catch (err) {
      console.error("Error destroying session wrapper:", err);
    }

    // 4. Unlink parent FIRST, before rewriting children (Task D4).
    // Rationale: a concurrent fork calls `SessionManager.open(currentSessionFile)`
    // on this same file. If the parent is still on disk while children are being
    // rewritten, a fork racing through that window can observe a half-cascaded
    // tree (some children still pointing at the soon-to-be-deleted parent) and
    // produce a new .jsonl whose parentSession references a dead path. Unlinking
    // the parent first makes any concurrent fork fail fast (ENOENT on open, or
    // caught by the existsSync guard in rpc-manager.ts fork case) instead of
    // silently creating an orphan. The remaining race window is narrowed to a
    // single child's rewrite, which is acceptable for this destructive + rare
    // operation; fully closing it would require cross-file OS locks (out of scope).
    await withFileLock(filePath, async () => {
      try { await unlink(filePath); } catch { /* race: already deleted */ }
    });
    invalidateSessionPathCache(id);

    // 5. Reparent children to the grandparent (now last).
    // Children remain on disk and may still be read by concurrent forks; each
    // rewrite is atomic + per-file locked, and rewriteChildHeader is idempotent.
    for (const childPath of siblingFiles) {
      let content: string;
      try { content = await readFile(childPath, "utf8"); }
      catch { continue; /* race: child deleted between readdir and read */ }

      const { newContent, changed } = rewriteChildHeader(content, filePath, parentSessionPath);
      if (!changed) continue;

      await withFileLock(childPath, () => atomicWriteFile(childPath, newContent));
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    logApiError({ route: "/api/sessions/[id]", method: "DELETE", requestId, error, params: { id } });
    return jsonError(_req, 500, errorMessage(error));
  }
}

async function atomicWriteFile(p: string, content: string): Promise<void> {
  const tmp = `${p}.tmp`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, p);
  } catch (e) {
    try { await unlink(tmp); } catch { /* best effort */ }
    throw e;
  }
}
