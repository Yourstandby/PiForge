/**
 * PowerShell execution helpers (v0.5.0 stage 8 step 3).
 *
 * Windows first-class shell: PowerShell 7 (`pwsh.exe`) is preferred, Windows
 * PowerShell 5.1 is the fallback. Commands always run with a fixed
 * non-interactive flag set and UTF-8 console encoding so Chinese output,
 * multiline scripts and quoted arguments survive the trip.
 *
 * This module only *builds* invocations; foreground model commands use the
 * SDK's `powershell` tool, while `run_bg` reuses these helpers so background
 * PowerShell runs go through the managed-process state machine.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export type PowerShellKind = "pwsh" | "windows-powershell";

export interface PowerShellLocation {
  kind: PowerShellKind;
  executable: string;
}

/** Fixed flags; never let a profile or prompt change tool behaviour. */
export const POWERSHELL_BASE_ARGS: readonly string[] = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
];

/**
 * Encoding + noise setup. `[Console]::OutputEncoding` fixes native command
 * output (Python, git, node); `$OutputEncoding` fixes text piped between
 * cmdlets. `$false` means emit UTF-8 without a BOM.
 */
export const POWERSHELL_UTF8_PREFIX = [
  "$ProgressPreference='SilentlyContinue'",
  "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
  "$OutputEncoding=[Console]::OutputEncoding",
  "$env:PYTHONIOENCODING='utf-8'",
].join("; ");

export const POWERSHELL_ENV = {
  POWERSHELL_TELEMETRY_OPTOUT: "1",
  POWERSHELL_UPDATECHECK: "Off",
  PYTHONIOENCODING: "utf-8",
} as const;

export function buildPowerShellArgs(script: string): string[] {
  return [...POWERSHELL_BASE_ARGS, `${POWERSHELL_UTF8_PREFIX}\n${script}`];
}

/** Pure preference rule, testable without touching the machine. */
export function pickPowerShell(
  candidates: { pwsh?: string | null; windowsPowerShell?: string | null },
  fileExists: (path: string) => boolean = existsSync,
): PowerShellLocation | null {
  if (candidates.pwsh && fileExists(candidates.pwsh)) {
    return { kind: "pwsh", executable: candidates.pwsh };
  }
  if (candidates.windowsPowerShell && fileExists(candidates.windowsPowerShell)) {
    return { kind: "windows-powershell", executable: candidates.windowsPowerShell };
  }
  return null;
}

function where(exe: string): string | null {
  try {
    const result = spawnSync("where.exe", [exe], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) return null;
    const first = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

let cached: PowerShellLocation | null | undefined;

/** Resolve once per Host process; PowerShell installations do not move often. */
export function resolvePowerShell(): PowerShellLocation | null {
  if (cached !== undefined) return cached;
  if (process.platform !== "win32") {
    cached = null;
    return cached;
  }
  const programFiles = process.env.ProgramFiles;
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  cached = pickPowerShell({
    pwsh: where("pwsh.exe") ?? (programFiles ? join(programFiles, "PowerShell", "7", "pwsh.exe") : null),
    windowsPowerShell:
      where("powershell.exe") ??
      (systemRoot ? join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : null),
  });
  return cached;
}

/** Test seam: forget a previously resolved executable. */
export function resetPowerShellCacheForTest(): void {
  cached = undefined;
}
