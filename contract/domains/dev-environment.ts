/**
 * Development environment probes (v0.5.0 stage 3).
 *
 * Scanning PATH for toolchains is a Host-side activity: it spawns processes and
 * inspects the machine. Next.js only proxies the report.
 */

export interface DevToolProbe {
  id: string;
  name: string;
  /** Command that produced the version (first candidate that worked). */
  command: string;
  /** Missing required tools get a warning in the settings panel. */
  required: boolean;
  found: boolean;
  /** First non-empty line of `--version` output, trimmed. */
  version?: string;
  /** Resolved executable path from `where` / `which`, when available. */
  path?: string;
  error?: string;
}

export interface DevEnvironmentReport {
  platform: string;
  arch: string;
  /** Node version of the Agent Host process itself. */
  hostNode: string;
  probedAt: number;
  tools: DevToolProbe[];
  /** Names of required tools that were not found. */
  missingRequired: string[];
}
