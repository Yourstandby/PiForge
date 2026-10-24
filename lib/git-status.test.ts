import assert from "node:assert/strict";
import test from "node:test";
import { invalidateGitStatus, parsePorcelainZ, readGitStatus } from "./git-status.ts";

test("parsePorcelainZ reads modified and untracked entries", () => {
  const output = " M src/app.tsx\0?? notes.md\0A  lib/new.ts\0";
  assert.deepEqual(parsePorcelainZ(output), [
    { path: "src/app.tsx", status: " M" },
    { path: "notes.md", status: "??" },
    { path: "lib/new.ts", status: "A " },
  ]);
});

test("parsePorcelainZ skips the original path of a rename", () => {
  const output = "R  src/new-name.ts\0src/old-name.ts\0 M docs/readme.md\0";
  assert.deepEqual(parsePorcelainZ(output), [
    { path: "src/new-name.ts", status: "R " },
    { path: "docs/readme.md", status: " M" },
  ]);
});

test("并发读同一个 cwd 只扫描一次（single-flight，避免 git 抢 index.lock）", async () => {
  const cwd = process.platform === "win32" ? "D:\tmp\single-flight" : "/tmp/single-flight";
  invalidateGitStatus(cwd);
  let calls = 0;
  const runner = async (args: string[]) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return args[0] === "rev-parse"
      ? { code: 0, stdout: `${cwd}
`, stderr: "" }
      : { code: 0, stdout: "", stderr: "" };
  };
  const [a, b, c] = await Promise.all([
    readGitStatus(cwd, runner as never),
    readGitStatus(cwd, runner as never),
    readGitStatus(cwd, runner as never),
  ]);
  assert.equal(calls, 2, "rev-parse + status 各一次：三个并发请求共用同一趟扫描");
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  invalidateGitStatus(cwd);
});

test("invalidate 之后重新扫描（TTL 内也能拿到新结果）", async () => {
  const cwd = process.platform === "win32" ? "D:\tmp\ttl" : "/tmp/ttl";
  invalidateGitStatus(cwd);
  let calls = 0;
  const runner = async (args: string[]) => {
    calls += 1;
    return args[0] === "rev-parse"
      ? { code: 0, stdout: `${cwd}
`, stderr: "" }
      : { code: 0, stdout: "", stderr: "" };
  };
  await readGitStatus(cwd, runner as never);
  await readGitStatus(cwd, runner as never);
  assert.equal(calls, 2, "TTL 内第二次读吃缓存");
  invalidateGitStatus(cwd);
  await readGitStatus(cwd, runner as never);
  assert.equal(calls, 4, "invalidate 之后重新扫描（+2 次调用）");
  invalidateGitStatus();
});
