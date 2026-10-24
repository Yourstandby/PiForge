#!/usr/bin/env node
/**
 * CI 护栏（静态检查，不需要花 10 分钟打包）：`pack` / `dist` 必须先
 * `build:static` 再 `build:standalone`。
 *
 * 原因（实测）：Next 的 `output: "export"` 构建会清理 `.next/`，把
 * `.next/standalone`（192 MB 裁剪依赖 + agent-host 入口）整棵删掉。顺序写反时
 * electron-builder 复制不到 Host 入口 → 装出来的应用"壳能开、引擎起不来"。
 *
 *   node scripts/check-pack-order.mjs
 */
import { readFileSync } from "node:fs";
import process from "node:process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const problems = [];

for (const name of ["pack", "dist"]) {
  const script = pkg.scripts?.[name];
  if (typeof script !== "string") {
    problems.push(`package.json 缺少 scripts.${name}`);
    continue;
  }
  const staticAt = script.indexOf("npm run build:static");
  const standaloneAt = script.indexOf("npm run build:standalone");
  if (staticAt === -1) problems.push(`scripts.${name} 没有调用 build:static（静态直出产物 out/ 不会更新）`);
  if (standaloneAt === -1) problems.push(`scripts.${name} 没有调用 build:standalone（拿不到裁剪后的 node_modules）`);
  if (staticAt !== -1 && standaloneAt !== -1 && staticAt > standaloneAt) {
    problems.push(`scripts.${name} 顺序错了：build:static 必须在 build:standalone 之前（否则 .next/standalone 被清掉）`);
  }
  if (!/smoke-packaged-(layout|static)\.mjs/.test(script)) {
    problems.push(`scripts.${name} 结尾没有跑打包冒烟（smoke-packaged-layout / smoke-packaged-static）`);
  }
}

if (problems.length > 0) {
  console.error("check-pack-order: FAIL");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("check-pack-order: PASS（pack/dist 都是 static → standalone → 打包 → 冒烟）");
