/**
 * File-access policy, owned by the Agent Host.
 *
 * Allowed roots are derived from pi session cwds (plus `~/pi-cwd-*` scratch
 * dirs and cwds explicitly registered when a session starts). Every file
 * read/write in the Next file API must pass through `authorizePath`; Next only
 * performs the actual IO on the canonical path returned here.
 */
import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SessionManager } from "./sdk-adapter.ts";
import { validateAgentCwd, validateWritablePath } from "../lib/path-policy.ts";
import { isWindowsAbsolutePath } from "../lib/path-text.ts";

export type FileAccessOp = "read" | "write" | "list";

export class AccessDeniedError extends Error {
  constructor(message = "Access denied") {
    super(message);
    this.name = "AccessDeniedError";
  }
}

const ALLOWED_ROOTS_TTL_MS = 5_000;

let cachedRoots: { roots: Set<string>; expiresAt: number } | null = null;
const extraRoots = new Set<string>();

/**
 * `realpath` removes symlinks and resolves macOS `/var` → `/private/var`.
 * A root that does not exist yet (project added before first session) is kept
 * as an absolute path; authorization will fail-closed until it exists.
 */
async function canonicalRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return path.resolve(root);
  }
}

/** Register a cwd immediately (new/live sessions may not be flushed yet). */
export function addAllowedRoot(cwd: string): void {
  const trimmed = cwd.trim();
  if (!trimmed) return;
  extraRoots.add(trimmed);
  cachedRoots = null;
}

/** 在飞的扫描：并发调用共用一次（预热与真实请求撞车时不再各扫一遍）。 */
let inflightRoots: Promise<Set<string>> | null = null;

export async function getAllowedRoots(): Promise<Set<string>> {
  const now = Date.now();
  if (cachedRoots && cachedRoots.expiresAt > now) return cachedRoots.roots;
  if (inflightRoots) return inflightRoots;
  inflightRoots = computeAllowedRoots().finally(() => {
    inflightRoots = null;
  });
  return inflightRoots;
}

async function computeAllowedRoots(): Promise<Set<string>> {
  const rawRoots = new Set<string>();
  try {
    const sessions = await SessionManager.listAll();
    for (const session of sessions) {
      // Reject dangerous legacy/tampered headers; allow home so an existing
      // session rooted there stays browsable.
      if (session.cwd && !validateAgentCwd(session.cwd, { allowHome: true })) {
        rawRoots.add(session.cwd);
      }
    }
  } catch {
    // Unreadable session store: fall back to explicit roots only.
  }

  for (const root of extraRoots) rawRoots.add(root);

  try {
    const home = homedir();
    const names = await readdir(home);
    for (const name of names) {
      if (/^pi-cwd-\d{8}$/.test(name)) rawRoots.add(path.join(home, name));
    }
  } catch {
    // ignore unreadable home
  }

  // Canonicalize roots before caching: on macOS `/var/...` and
  // `/private/var/...` are the same location, and a target's realpath would
  // otherwise never match the raw root. This is the root-cause fix for the
  // cross-platform AccessDeniedError; no path-prefix bypass is needed.
  const roots = new Set<string>();
  for (const root of rawRoots) roots.add(await canonicalRoot(root));

  cachedRoots = { roots, expiresAt: Date.now() + ALLOWED_ROOTS_TTL_MS };
  return roots;
}

export function isPathAllowed(target: string, allowedRoots: Set<string>): boolean {
  for (const root of allowedRoots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const normalized = resolver.resolve(target);
    const normalizedRoot = resolver.resolve(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) {
      return true;
    }
  }
  return false;
}

/**
 * Canonicalize and authorize a path.
 *
 * - read/list: the target must exist and its realpath must be inside a root.
 * - write: the target may be new; its parent must resolve inside a root, and
 *   the existing writable-path policy (.git, .env, node_modules) applies.
 */
export async function authorizePath(target: string, op: FileAccessOp): Promise<string> {
  let realPath: string;

  if (op === "write") {
    try {
      realPath = await realpath(target);
    } catch {
      let realParent: string;
      try {
        realParent = await realpath(path.dirname(target));
      } catch {
        throw new AccessDeniedError("Parent directory is not accessible");
      }
      realPath = path.join(realParent, path.basename(target));
    }
    const writeError = validateWritablePath(realPath);
    if (writeError) throw new AccessDeniedError(writeError);
  } else {
    try {
      realPath = await realpath(target);
    } catch {
      throw new AccessDeniedError("Path is not accessible");
    }
  }

  const roots = await getAllowedRoots();
  if (!isPathAllowed(realPath, roots)) {
    throw new AccessDeniedError("Path is outside the allowed roots");
  }
  return realPath;
}
