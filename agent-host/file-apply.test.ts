import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessDeniedError, addAllowedRoot } from "./allowed-roots.ts";
import { FileApplyError, MAX_APPLY_CODE_BYTES, applyCodeToFile } from "./file-apply.ts";

// [新增] 记录所有创建的临时目录，确保测试结束后清理
const createdTempDirs: string[] = [];

afterEach(() => {
  for (const dir of createdTempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  createdTempDirs.length = 0;
});

function tempProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-apply-code-"));
  // [关键修复] 获取真实的绝对路径，解决 macOS 上 /var 和 /private/var 的映射问题
  const realDir = realpathSync(dir); 
  
  // 将真实的绝对路径加入白名单
  addAllowedRoot(realDir);
  createdTempDirs.push(realDir);

  return { 
    dir: realDir, 
    cleanup: () => {
      // 配合 afterEach 进行双重清理，保持原有测试用例结构兼容
      rmSync(realDir, { recursive: true, force: true });
      const index = createdTempDirs.indexOf(realDir);
      if (index !== -1) createdTempDirs.splice(index, 1);
    } 
  };
}

test("applyCodeToFile overwrites the whole file", async () => {
  const { dir, cleanup } = tempProject();
  try {
    const file = join(dir, "src.ts");
    writeFileSync(file, "const old = true;\n");
    const result = await applyCodeToFile({ path: file, content: "export const next = 1;\n", mode: "overwrite" });
    assert.equal(result.mode, "overwrite");
    assert.ok(result.path.endsWith("src.ts"), result.path);
    assert.equal(readFileSync(result.path, "utf-8"), "export const next = 1;\n");
    assert.equal(readFileSync(file, "utf-8"), "export const next = 1;\n");
  } finally {
    cleanup();
  }
});

test("applyCodeToFile appends with a newline separator", async () => {
  const { dir, cleanup } = tempProject();
  try {
    const file = join(dir, "notes.md");
    writeFileSync(file, "# Notes");
    const result = await applyCodeToFile({ path: file, content: "appended", mode: "append" });
    assert.equal(result.mode, "append");
    assert.equal(readFileSync(file, "utf-8"), "# Notes\nappended");
    assert.ok(result.bytes > "appended".length);

    // A file ending in a newline does not gain a blank line.
    writeFileSync(file, "line\n");
    await applyCodeToFile({ path: file, content: "next", mode: "append" });
    assert.equal(readFileSync(file, "utf-8"), "line\nnext");
  } finally {
    cleanup();
  }
});

test("append creates a missing file with just the code", async () => {
  const { dir, cleanup } = tempProject();
  try {
    const file = join(dir, "created.ts");
    assert.equal(existsSync(file), false);
    await applyCodeToFile({ path: file, content: "export {};\n", mode: "append" });
    assert.equal(readFileSync(file, "utf-8"), "export {};\n");
  } finally {
    cleanup();
  }
});

test("paths outside the allowed roots are rejected", async () => {
  const { dir, cleanup } = tempProject();
  try {
    const outside = join(tmpdir(), `pi-outside-${Date.now()}`, "x.ts");
    await assert.rejects(
      () => applyCodeToFile({ path: outside, content: "x", mode: "overwrite" }),
      (error: unknown) => error instanceof AccessDeniedError,
    );
    assert.equal(existsSync(outside), false);
    assert.ok(dir);
  } finally {
    cleanup();
  }
});

test("invalid requests are rejected before touching the filesystem", async () => {
  const { dir, cleanup } = tempProject();
  try {
    const file = join(dir, "a.ts");
    await assert.rejects(
      () => applyCodeToFile({ path: "", content: "x", mode: "overwrite" }),
      (error: unknown) => error instanceof FileApplyError && error.code === "E_INVALID_PARAMS",
    );
    await assert.rejects(
      () => applyCodeToFile({ path: file, content: "x", mode: "replace" as never }),
      (error: unknown) => error instanceof FileApplyError,
    );
    await assert.rejects(
      () => applyCodeToFile({ path: file, content: 42 as never, mode: "overwrite" }),
      (error: unknown) => error instanceof FileApplyError,
    );
    await assert.rejects(
      () => applyCodeToFile({ path: file, content: "x".repeat(MAX_APPLY_CODE_BYTES + 1), mode: "overwrite" }),
      (error: unknown) => error instanceof FileApplyError && /too large/i.test(error.message),
    );
    assert.equal(existsSync(file), false);
  } finally {
    cleanup();
  }
});