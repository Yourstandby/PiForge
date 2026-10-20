/**
 * Session metadata mutations that touch `.jsonl` files.
 *
 * These moved into the Agent Host because the live AgentSession also appends to
 * those files: keeping rename/delete in Next would leave two writers without a
 * shared lock. The host delete path preserves the existing cascade ordering:
 * destroy wrapper -> unlink parent first -> reparent children.
 */
import { existsSync } from "node:fs";
import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { rewriteChildHeader } from "../lib/session-cascade.ts";
import { withFileLock } from "../lib/session-lock.ts";
import { getRpcSession } from "./rpc-manager.ts";

function sessionsDir(): string {
  return join(getAgentDir(), "sessions");
}

function assertSessionPath(filePath: string): void {
  const root = resolve(sessionsDir());
  const target = resolve(filePath);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || !rel.endsWith(".jsonl")) {
    throw new Error("Session path is outside the sessions directory");
  }
}

async function readFirstLine(filePath: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const index = content.indexOf("\n");
  return index === -1 ? content : content.slice(0, index);
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, filePath);
  } catch (error) {
    try {
      await unlink(tmp);
    } catch {
      // best effort
    }
    throw error;
  }
}

export async function renameSession(
  sessionId: string,
  filePath: string,
  name: string,
): Promise<void> {
  assertSessionPath(filePath);
  const trimmed = name.trim();
  const live = getRpcSession(sessionId);
  if (live?.isAlive() && typeof live.inner.setSessionName === "function") {
    live.inner.setSessionName(trimmed);
    return;
  }
  const manager = SessionManager.open(filePath);
  manager.appendSessionInfo(trimmed);
}

export async function deleteSession(sessionId: string, filePath: string): Promise<void> {
  assertSessionPath(filePath);

  // 1. Parent path from the header (used to reparent children).
  let parentSessionPath: string | null = null;
  try {
    const firstLine = await readFirstLine(filePath);
    if (firstLine) {
      const header = JSON.parse(firstLine) as { type?: string; parentSession?: string };
      if (header.type === "session") parentSessionPath = header.parentSession ?? null;
    }
  } catch {
    // malformed parent — grandparent remains null
  }

  // 2. Sibling files that may reference this session as their parent.
  const directory = filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  const siblingFiles: string[] = [];
  try {
    const names = await readdir(directory);
    siblingFiles.push(
      ...names
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(directory, name))
        .filter((path) => path !== filePath),
    );
  } catch {
    // unreadable directory — no cascade possible
  }

  // 3. Destroy the live wrapper before unlinking so no command races in.
  try {
    await getRpcSession(sessionId)?.destroy();
  } catch (error) {
    console.error("Error destroying session wrapper:", error);
  }

  // 4. Unlink the parent first (same ordering rationale as the old route).
  await withFileLock(filePath, async () => {
    try {
      await unlink(filePath);
    } catch {
      // race: already deleted
    }
  });

  // 5. Reparent surviving children to the grandparent.
  for (const childPath of siblingFiles) {
    let content: string;
    try {
      content = await readFile(childPath, "utf8");
    } catch {
      continue;
    }
    const { newContent, changed } = rewriteChildHeader(content, filePath, parentSessionPath);
    if (!changed) continue;
    await withFileLock(childPath, () => atomicWriteFile(childPath, newContent));
  }
}

/** True when the path belongs to the sessions directory (used by locate). */
export function isSessionFilePath(filePath: string): boolean {
  try {
    assertSessionPath(filePath);
    return existsSync(filePath);
  } catch {
    return false;
  }
}
