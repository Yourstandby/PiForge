/**
 * Apply a Markdown code block to a project file.
 *
 * Runs in the Agent Host: it reuses the Host's writable-path policy
 * (`authorizePath`), then writes atomically. Next.js only proxies the request.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../lib/atomic-write.ts";
import { authorizePath } from "./allowed-roots.ts";

export type ApplyCodeMode = "overwrite" | "append";

/** Chat code blocks are small; cap to keep accidental giant writes out. */
export const MAX_APPLY_CODE_BYTES = 2 * 1024 * 1024;

export class FileApplyError extends Error {
  readonly code: "E_INVALID_PARAMS" | "INTERNAL";

  constructor(code: "E_INVALID_PARAMS" | "INTERNAL", message: string) {
    super(message);
    this.name = "FileApplyError";
    this.code = code;
  }
}

export interface ApplyCodeResult {
  path: string;
  mode: ApplyCodeMode;
  bytes: number;
}

export async function applyCodeToFile(input: {
  path: string;
  content: string;
  mode: ApplyCodeMode;
}): Promise<ApplyCodeResult> {
  const filePath = typeof input.path === "string" ? input.path.trim() : "";
  if (!filePath) throw new FileApplyError("E_INVALID_PARAMS", "path is required");
  if (typeof input.content !== "string") {
    throw new FileApplyError("E_INVALID_PARAMS", "content must be a string");
  }
  if (input.mode !== "overwrite" && input.mode !== "append") {
    throw new FileApplyError("E_INVALID_PARAMS", "mode must be 'overwrite' or 'append'");
  }
  const bytes = Buffer.byteLength(input.content, "utf8");
  if (bytes > MAX_APPLY_CODE_BYTES) {
    throw new FileApplyError(
      "E_INVALID_PARAMS",
      `Code block is too large (${bytes} bytes; limit ${MAX_APPLY_CODE_BYTES})`,
    );
  }

  // Throws AccessDeniedError when the path is outside the allowed roots or
  // fails the writable-path policy.
  const realPath = await authorizePath(filePath, "write");

  let next = input.content;
  if (input.mode === "append" && existsSync(realPath)) {
    const existing = readFileSync(realPath, "utf8");
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    next = `${existing}${separator}${input.content}`;
  }

  writeFileAtomic(realPath, next);
  return { path: realPath, mode: input.mode, bytes: Buffer.byteLength(next, "utf8") };
}
