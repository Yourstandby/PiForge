/**
 * Pending leaf selection for cold sessions.
 *
 * Switching branches on a session that is not live only changes what the user
 * is viewing. If they then send a prompt, the Host has to start the session at
 * that leaf instead of the file's last entry, otherwise the new message would
 * attach to the wrong branch. The selection is kept in memory between the
 * switch RPC and `startRpcSession`.
 */

const pendingLeaves = new Map<string, string | null>();

export function setPendingSessionLeaf(sessionId: string, leafId: string | null): void {
  if (!sessionId) return;
  pendingLeaves.set(sessionId, leafId);
}

export function hasPendingSessionLeaf(sessionId: string): boolean {
  return pendingLeaves.has(sessionId);
}

/** Apply and consume the pending leaf, if any. */
export function applyPendingSessionLeaf(
  sessionId: string,
  manager: { branch(branchFromId: string): void; resetLeaf(): void },
): void {
  if (!pendingLeaves.has(sessionId)) return;
  const leafId = pendingLeaves.get(sessionId) ?? null;
  pendingLeaves.delete(sessionId);
  if (leafId === null) manager.resetLeaf();
  else manager.branch(leafId);
}

export function forgetPendingSessionLeaf(sessionId: string): void {
  pendingLeaves.delete(sessionId);
}

export function clearPendingSessionLeaves(): void {
  pendingLeaves.clear();
}
