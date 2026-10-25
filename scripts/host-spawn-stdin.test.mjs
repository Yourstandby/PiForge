/**
 * 护栏：node 版 agent-host 只能通过 `scripts/lib/host-spawn.mjs` 拉起。
 *
 * 为什么：host 的 stdin 控制通道靠 `PIFORGE_HOST_STDIN_CONTROL=1` **显式**开启（不靠
 * 「stdin 不是 TTY」去猜）。而这些脚本一律 `stdio[0] = "ignore"` —— host 会把 stdin
 * 立刻 EOF 当成「父进程死了」。父进程在 PiForge 自己的终端 / Host 子进程里跑度量时又会
 * 继承 `=1`，于是每个脚本都得自己记得置 0：漏一个就是静默挂死（v0.12.0 实测
 * `measure-prefix` / `smoke:prefix-budget` 零输出卡死 120 s）。手写第二遍还会多出
 * duplicate `env:` key，把前半段 env 整块吞掉（audit-route-heap / measure-host-boot 中过）。
 *
 * 所以判据从「每个脚本都写了这个 key」改成「谁也不许自己写」：
 *   1. 工厂在合并调用方 env **之前**把它写死为 "0"（调用方仍可显式覆盖）；
 *   2. 别的脚本里出现这个 key 就是护栏开始分散的信号；
 *   3. 脚本不许绕过工厂直接 spawn node 版 host。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const GUARD_KEY = "PIFORGE_HOST_STDIN_CONTROL";
const FACTORY = path.join(scriptsDir, "lib", "host-spawn.mjs");

const sources = readdirSync(scriptsDir)
  .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
  .sort()
  .map((name) => ({ name, text: readFileSync(path.join(scriptsDir, name), "utf8") }));

test("the factory pins PIFORGE_HOST_STDIN_CONTROL=0 before merging caller env", () => {
  const text = readFileSync(FACTORY, "utf8");
  assert.match(
    text,
    new RegExp(`${GUARD_KEY}:\\s*"0",\\s*\\.\\.\\.env`),
    "guard must be written before ...env so it applies by default and stays overridable"
  );
});

test("no script hand-rolls the stdin guard", () => {
  const offenders = sources.filter(({ text }) => text.includes(GUARD_KEY)).map(({ name }) => name);
  assert.deepEqual(offenders, [], `import { spawnNodeHost } / { hostChildEnv } instead: ${offenders.join(", ")}`);
});

test("no script spawns the node host without going through the factory", () => {
  const offenders = sources
    .filter(({ text }) => /spawn\(process\.execPath, \[[^\]]*(hostEntry|HOST_ENTRY|\bentry\b)/.test(text))
    .map(({ name }) => name);
  assert.deepEqual(offenders, [], `use spawnNodeHost({ entry, env }) instead: ${offenders.join(", ")}`);
});

test("the factory keeps stdin ignored by default (that is what makes the guard necessary)", () => {
  const text = readFileSync(FACTORY, "utf8");
  assert.match(text, /stdio = \["ignore", "pipe", "pipe"\]/);
});
