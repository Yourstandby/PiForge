/**
 * Cross-platform development tool detection (v0.5.0 stage 3).
 *
 * Runs in the Agent Host: each probe spawns the tool with `--version`, then
 * resolves its path through `where` (Windows) or `which` (POSIX). Results are
 * cached briefly so opening the settings panel repeatedly is cheap.
 */
import { spawn } from "node:child_process";
import type { DevEnvironmentReport, DevToolProbe } from "../contract/domains/dev-environment.ts";

const PROBE_TIMEOUT_MS = 4_000;
const PATH_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 20_000;

export interface DevToolSpec {
  id: string;
  name: string;
  required: boolean;
  /** Tried in order; the first success wins (e.g. python → python3 → py). */
  candidates: Array<{ command: string; args: string[] }>;
}

/**
 * `bash` is required on purpose: Agent workflows assume a POSIX shell (Git
 * Bash on Windows). Node/Git are required for the app's own tooling.
 */
export const DEFAULT_DEV_TOOL_SPECS: DevToolSpec[] = [
  { id: "node", name: "Node.js", required: true, candidates: [{ command: "node", args: ["--version"] }] },
  { id: "npm", name: "npm", required: false, candidates: [{ command: "npm", args: ["--version"] }] },
  {
    id: "python",
    name: "Python",
    required: false,
    candidates: [
      { command: "python", args: ["--version"] },
      { command: "python3", args: ["--version"] },
      { command: "py", args: ["--version"] },
    ],
  },
  { id: "git", name: "Git", required: true, candidates: [{ command: "git", args: ["--version"] }] },
  { id: "bash", name: "Bash", required: true, candidates: [{ command: "bash", args: ["--version"] }] },
  { id: "bun", name: "Bun", required: false, candidates: [{ command: "bun", args: ["--version"] }] },
  { id: "jq", name: "jq", required: false, candidates: [{ command: "jq", args: ["--version"] }] },
];

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Windows resolves `npm`/`bun` through .cmd shims, so those need cmd.exe. The
 * command string is built from fixed literals only (never user input), which
 * also avoids the deprecation warning of `shell: true` with args.
 */
function spawnProbe(command: string, args: string[]): ReturnType<typeof spawn> {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    return spawn(comspec, ["/d", "/s", "/c", [command, ...args].join(" ")], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return spawn(command, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function run(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        // Already gone.
      }
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    try {
      child = spawnProbe(command, args);
    } catch (error) {
      finish({ code: null, stdout, stderr: String(error), timedOut: false });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut: false });
    });
  });
}

/** First non-empty line of version output (`python` writes it to stderr). */
export function firstVersionLine(stdout: string, stderr: string): string | undefined {
  const line = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return line ? line.slice(0, 200) : undefined;
}

async function resolveExecutablePath(command: string): Promise<string | undefined> {
  const resolver = process.platform === "win32" ? "where" : "which";
  const result = await run(resolver, [command], PATH_TIMEOUT_MS);
  const first = result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return first;
}

/** Version output without a dotted number is something else (e.g. a shell error). */
function looksLikeVersion(value: string | undefined): boolean {
  return Boolean(value && /\d+\.\d+/.test(value));
}

async function probeSpec(spec: DevToolSpec): Promise<DevToolProbe> {
  for (const candidate of spec.candidates) {
    const result = await run(candidate.command, candidate.args, PROBE_TIMEOUT_MS);
    if (result.timedOut) continue;
    const version = firstVersionLine(result.stdout, result.stderr);
    // A missing command exits non-zero and prints a shell error, not a version.
    if (result.code !== 0 && !looksLikeVersion(version)) continue;
    return {
      id: spec.id,
      name: spec.name,
      command: candidate.command,
      required: spec.required,
      found: true,
      ...(version ? { version } : {}),
      ...(await resolveExecutablePath(candidate.command).then((path) => (path ? { path } : {}))),
    };
  }
  return {
    id: spec.id,
    name: spec.name,
    command: spec.candidates[0]?.command ?? spec.id,
    required: spec.required,
    found: false,
    error: "not found in PATH",
  };
}

export interface ProbeDevEnvironmentOptions {
  /** Force a fresh scan (the settings panel's "re-check" button). */
  refresh?: boolean;
  /** Test hook: replace the built-in probe list. */
  specs?: DevToolSpec[];
}

let cache: { at: number; report: DevEnvironmentReport } | null = null;

export async function probeDevEnvironment(
  options: ProbeDevEnvironmentOptions = {},
): Promise<DevEnvironmentReport> {
  const specs = options.specs ?? DEFAULT_DEV_TOOL_SPECS;
  if (!options.specs && !options.refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.report;
  }
  const tools = await Promise.all(specs.map((spec) => probeSpec(spec)));
  const report: DevEnvironmentReport = {
    platform: process.platform,
    arch: process.arch,
    hostNode: process.version,
    probedAt: Date.now(),
    tools,
    missingRequired: tools.filter((tool) => tool.required && !tool.found).map((tool) => tool.name),
  };
  if (!options.specs) cache = { at: report.probedAt, report };
  return report;
}

/** Credentials/toolchains may change while the app runs; the next scan re-detects. */
export function invalidateDevToolsCache(): void {
  cache = null;
}
