/**
 * 护栏：用 `stdio: ["ignore", ...]` 拉起 agent-host 的脚本，必须把 `PIFORGE_HOST_STDIN_CONTROL`
 * 归零（或显式给 "0"）。
 *
 * 为什么：host 的 stdin 控制通道靠这个环境变量显式开启（不靠「stdin 不是 TTY」去猜）。父进程
 * 若带 `=1`——在 PiForge 自己的终端 / Host 子进程里跑度量就会继承——host 把 stdin 立刻 EOF
 * 当成「父进程死了」，在握手阶段退出；而调用方等 RPC 帧没有超时，于是 `measure-prefix` 与
 * `smoke:prefix-budget` 静默挂死，既不报错也不退出（v0.12.0 实测：120 s 零输出）。
 *
 * 已知踩过坑的参考实现：`smoke-agent-host.mjs` / `smoke-packaged-events.mjs`。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const GUARD_KEY = "PIFORGE_HOST_STDIN_CONTROL";

const files = readdirSync(scriptsDir)
  .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
  .sort();

test("spawns of the host with ignored stdin neutralize PIFORGE_HOST_STDIN_CONTROL", () => {
  const offenders = [];
  for (const name of files) {
    // 打包冒烟拉起的是 PiForge.exe：主进程启动 host 前会剔掉 PIFORGE_HOST_*（electron/env-filter.ts），
    // 所以它们不在本护栏的覆盖范围内。
    if (name.startsWith("smoke-packaged-")) continue;
    const text = readFileSync(path.join(scriptsDir, name), "utf8");
    // 只覆盖真正拉起 node 版 host 的脚本：打包冒烟 / standalone 冒烟打的是别的进程。
    if (!/HOST_ENTRY|hostEntry|agent-host[\\/]dist/.test(text)) continue;
    // 只看「继承父进程 env 且忽略 stdin」的 spawn：完全不继承的 spawn 没这个问题。
    if (!/stdio:\s*\[\s*"ignore"/.test(text)) continue;
    if (!/\.\.\.process\.env/.test(text)) continue;
    const guarded = new RegExp(`${GUARD_KEY}\\s*:\\s*"0"`).test(text);
    if (!guarded) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `these scripts spawn a host with ignored stdin but inherit ${GUARD_KEY}=1 -> silent hang: ${offenders.join(", ")}`
  );
});
