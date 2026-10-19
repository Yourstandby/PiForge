/**
 * Helpers for project windows: Electron opens `/?cwd=<absolute path>` for a new
 * project window, and the workbench has to turn that back into a cwd.
 *
 * Kept pure so both the renderer and the tests can use them without touching
 * `window.location`.
 */

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
const UNC_ABSOLUTE = /^\\\\[^\\]/;

export function isAbsolutePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    WINDOWS_ABSOLUTE.test(value) ||
    UNC_ABSOLUTE.test(value)
  );
}

/**
 * Validates the raw `?cwd=` value. Returns null for anything that is not a
 * plausible absolute path, so a malformed deep link falls back to the default
 * project instead of sending the agent an invalid cwd.
 */
export function parseCwdParam(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^["']+|["']+$/g, "");
  if (!trimmed) return null;
  if (!isAbsolutePath(trimmed)) return null;
  // Trailing separators are noise for path policy checks (`D:\proj\`).
  return trimmed.replace(/[\\/]+$/, "") || null;
}

export function buildProjectWindowPath(cwd: string): string {
  return `/?cwd=${encodeURIComponent(cwd)}`;
}

export interface SessionLike {
  id: string;
  cwd: string;
}

/** What the workbench should show on first load. */
export type InitialView<T extends SessionLike = SessionLike> =
  | { kind: "project"; cwd: string }
  | { kind: "session"; session: T }
  | { kind: "recent"; cwd: string | null };

/**
 * Decides the first view from the deep link, in priority order:
 *   1. `?cwd=`      — a project window opened via `electronAPI.openWindow`:
 *                     start a blank session in that folder.
 *   2. `?session=`  — open that specific transcript.
 *   3. no link      — newest project, blank session (hero composer).
 */
export function resolveInitialView<T extends SessionLike>(
  search: string,
  sessions: readonly T[],
): InitialView<T> {
  const params = new URLSearchParams(search);

  const linkedCwd = parseCwdParam(params.get("cwd"));
  if (linkedCwd) return { kind: "project", cwd: linkedCwd };

  const deepLinkId = params.get("session");
  const linked = deepLinkId
    ? sessions.find((session) => session.id === deepLinkId)
    : undefined;
  if (linked) return { kind: "session", session: linked };

  return { kind: "recent", cwd: sessions[0]?.cwd ?? null };
}
