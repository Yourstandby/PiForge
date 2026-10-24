#!/usr/bin/env node
/**
 * CI 护栏（静态检查，不需要花 10 分钟打包）：**每个会调 electron-builder 的脚本**
 * 都必须先 `build:static` 再 `build:standalone`。
 *
 * 两个踩过的坑（都是实测，不是推理）：
 *
 *   1. 顺序反了：Next 的 `output: "export"` 构建会清理 `.next/`，把
 *      `.next/standalone`（裁剪依赖 + agent-host 入口）整棵删掉。顺序写反时
 *      electron-builder 复制不到 Host 入口 → 装出来的应用"壳能开、引擎起不来"。
 *   2. 漏了 `build:static`：electron-builder.yml 里 `extraResources.from: out`，
 *      没有 `out/` 就直接 `file source doesn't exist  from=.../out`。
 *      v0.9.1 的 macOS 打包就是这么红的：`dist:mac` 只跑了 `build:standalone`
 *      （产物在 `.next/standalone`，不产生 `out/`），而本地因为 `out/` 是上一次
 *      构建的残留，一直是假绿。
 *
 * 所以这里不再写死 `pack`/`dist` 两个名字，而是扫所有含 `electron-builder` 的脚本。
 *
 *   node scripts/check-pack-order.mjs
 */
import { readFileSync } from "node:fs";
import process from "node:process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const problems = [];

// 只认真正调 CLI 的入口：`npx electron-builder …` 或 `node scripts/build-installer.mjs`。
// （单纯提到 electron-builder 的测试脚本（lib/electron-builder-config.test.mjs）不算打包入口。）
const packScripts = Object.entries(pkg.scripts ?? {}).filter(
  ([, script]) =>
    typeof script === "string" &&
    (script.includes("npx electron-builder") || script.includes("build-installer.mjs")),
);

if (packScripts.length === 0) {
  problems.push("package.json 里找不到任何调用 electron-builder 的脚本（打包入口丢了？）");
}

for (const [name, script] of packScripts) {
  const staticAt = script.indexOf("npm run build:static");
  const standaloneAt = script.indexOf("npm run build:standalone");
  if (staticAt === -1) {
    problems.push(
      `scripts.${name} 没有调用 build:static：electron-builder 的 extraResources 要读 out/，缺了会报 "file source doesn't exist"`,
    );
  }
  if (standaloneAt === -1) {
    problems.push(`scripts.${name} 没有调用 build:standalone（拿不到裁剪后的 node_modules）`);
  }
  if (staticAt !== -1 && standaloneAt !== -1 && staticAt > standaloneAt) {
    problems.push(`scripts.${name} 顺序错了：build:static 必须在 build:standalone 之前（否则 .next/standalone 被清掉）`);
  }
  if (!/smoke-packaged-[\w-]+\.mjs/.test(script)) {
    problems.push(`scripts.${name} 结尾没有跑打包冒烟（smoke-packaged-*.mjs）`);
  }
}

if (problems.length > 0) {
  console.error("check-pack-order: FAIL");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `check-pack-order: PASS（${packScripts.map(([name]) => name).join(" / ")} 都是 static → standalone → 打包 → 冒烟）`,
);
