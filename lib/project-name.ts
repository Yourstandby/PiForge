/**
 * Folder name of a project cwd, for the session tab breadcrumb.
 *
 * Windows and POSIX separators are both handled (a session's cwd may come from
 * either side), and drive roots keep their "C:" label instead of going blank.
 */
export function projectNameFromCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const trimmed = cwd.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  const parts = trimmed.split(/[\\/]/);
  const name = parts[parts.length - 1]?.trim();
  return name ? name : null;
}
