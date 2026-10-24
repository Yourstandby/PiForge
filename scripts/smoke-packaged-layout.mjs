#!/usr/bin/env node
/**
 * CI 护栏：打包产物必须是"静态直出 + Host 入口"的布局（不需要 GUI）。
 *
 *   node scripts/smoke-packaged-layout.mjs
 *   node scripts/smoke-packaged-layout.mjs --exe release/win-unpacked/PiForge.exe
 *
 * 断言（任一不满足即 CI 红）：
 *   1. resources/static/index.html 存在（静态直出产物进包）；
 *   2. resources/standalone/agent-host/index.js 存在（Host 入口进包）；
 *   3. resources/standalone/node_modules/@earendil-works/pi-coding-agent 存在
 *      （Host 的 Pi SDK 依赖进包）；
 *   4. resources/standalone/server.js **不存在**（Next 服务已删除，零内部端口）。
 *
 * 背景：`build:static` 会清掉 `.next/standalone`，所以 pack/dist 的顺序必须是
 * static → standalone。顺序写反时应用会"壳能打开、引擎起不来"，这个脚本让
 * 那种包在 CI 就被拦下（配合 scripts/check-pack-order.mjs 的静态检查）。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const exeIndex = args.indexOf("--exe");
const exe = path.resolve(
  exeIndex === -1
    ? process.platform === "win32"
      ? "release/win-unpacked/PiForge.exe"
      : "release/linux-unpacked/piforge"
    : args[exeIndex + 1],
);

const resourcesDir = path.join(path.dirname(exe), "resources");
const checks = [
  { label: "可执行文件", file: exe, mustExist: true },
  { label: "静态直出 index.html", file: path.join(resourcesDir, "static", "index.html"), mustExist: true },
  { label: "静态直出 chunks", file: path.join(resourcesDir, "static", "_next", "static", "chunks"), mustExist: true },
  { label: "Agent Host 入口", file: path.join(resourcesDir, "standalone", "agent-host", "index.js"), mustExist: true },
  {
    label: "Pi SDK 依赖",
    file: path.join(resourcesDir, "standalone", "node_modules", "@earendil-works", "pi-coding-agent"),
    mustExist: true,
  },
  { label: "Next standalone server.js（应已删除）", file: path.join(resourcesDir, "standalone", "server.js"), mustExist: false },
];

const problems = [];
for (const check of checks) {
  const present = existsSync(check.file);
  if (check.mustExist && !present) problems.push(`缺少${check.label}：${check.file}`);
  if (!check.mustExist && present) problems.push(`${check.label} 仍在包里：${check.file}`);
}

if (problems.length > 0) {
  console.error("smoke-packaged-layout: FAIL（打包布局不对）");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("  常见原因：pack/dist 的顺序写反（先 standalone 再 static）→ `.next/standalone` 被清掉。");
  console.error("  修复：node scripts/check-pack-order.mjs 会指出顺序问题；然后 npm run pack");
  process.exit(1);
}
console.log(`smoke-packaged-layout: PASS（${path.relative(process.cwd(), resourcesDir)}）`);
