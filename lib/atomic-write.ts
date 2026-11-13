/**
 * Atomic file replacement for config files shared across processes
 * (settings.json, desktop-settings.json): write a sibling temp file, then
 * rename it over the target so readers never observe a half-written file.
 */
import { closeSync, ftruncateSync, openSync, renameSync, unlinkSync, writeFileSync, writeSync } from "fs";

const RETRY_INTERVAL_MS = 25;
const MAX_RENAME_ATTEMPTS = 100;

export interface WriteFileAtomicOptions {
  retryIntervalMs?: number;
  maxRenameAttempts?: number;
  /** Test hook: defaults to a blocking Atomics.wait sleep. */
  sleepSync?: (ms: number) => void;
}

function defaultSleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows blocks rename with EPERM/EACCES while another process holds the
// target open (measured: a tight reader loop required hundreds of retries).
// Readers here are short-lived request-path reads, so a bounded retry clears
// them without giving up atomicity.
function isRenameSharedConflict(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

// Windows 上 "w"（写 + 截断）打开带 FILE_ATTRIBUTE_HIDDEN 的文件会被内核直接
// 拒成 EPERM —— 实测 +H 必失败、`attrib -h` 后立刻成功，而同文件的 "r+" / "a"
// 与 rename 覆盖都正常，ACL 也是 Full Control。技能目录里装进来的 SKILL.md 常带
// +H，于是「写临时文件再 rename」以外的路径全炸。这里用已存在文件上的句柄原地
// 重写：不新建目录项，属性与 ACL 原样继承。
function writeInPlace(filePath: string, data: string): void {
  const buffer = Buffer.from(data, "utf8");
  const fd = openSync(filePath, "r+");
  try {
    ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < buffer.length) {
      offset += writeSync(fd, buffer, offset, buffer.length - offset, offset);
    }
  } finally {
    closeSync(fd);
  }
}

export function writeFileAtomic(
  filePath: string,
  data: string,
  options: WriteFileAtomicOptions = {},
): void {
  const retryIntervalMs = options.retryIntervalMs ?? RETRY_INTERVAL_MS;
  const maxRenameAttempts = options.maxRenameAttempts ?? MAX_RENAME_ATTEMPTS;
  const sleepSync = options.sleepSync ?? defaultSleepSync;
  const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;

  try {
    writeFileSync(tmp, data);
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync(tmp, filePath);
        return;
      } catch (err) {
        if (!isRenameSharedConflict(err) || attempt >= maxRenameAttempts) {
          throw err;
        }
        sleepSync(retryIntervalMs);
      }
    }
  } catch (err) {
    // Last resort: a stuck reader must not block persistence. Direct write
    // matches the pre-atomic behavior (torn reads possible); it can still
    // throw (e.g. disk full), which then surfaces to the caller.
    console.error(`writeFileAtomic: rename to ${filePath} failed, falling back to direct write`, err);
    try {
      writeFileSync(filePath, data);
    } catch (directErr) {
      try {
        writeInPlace(filePath, data);
      } catch {
        throw directErr;
      }
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp is gone after a successful rename; ignore.
    }
  }
}
