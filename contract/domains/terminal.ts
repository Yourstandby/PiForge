/**
 * Shell-output log for the right-panel terminal.
 *
 * Two producers feed it:
 *   - `run_bg` managed processes (merged into the panel by process id);
 *   - ordinary `bash` / `powershell` tool calls mirrored by the desktop
 *     terminal extension.
 *
 * ANSI escape sequences are preserved so the renderer can keep colors.
 */

export type TerminalBlockStatus = "running" | "ok" | "error";

export interface TerminalBlock {
  id: string;
  /** The command line shown as the block header. */
  title: string;
  cwd: string | null;
  /** Raw stdout/stderr, ANSI sequences included. */
  text: string;
  status: TerminalBlockStatus;
  at: number;
  updatedAt: number;
}
