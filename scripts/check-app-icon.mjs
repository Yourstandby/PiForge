#!/usr/bin/env node
/**
 * Pre-flight check for the brand icons that electron-builder embeds into the
 * packaged app.
 *
 * Why this exists: `win.icon` alone is not enough. electron-builder only writes
 * the icon (and version info) into `PiForge.exe` while the `signAndEditExecutable`
 * step runs rcedit — with that step disabled, `win-unpacked/PiForge.exe` silently
 * keeps the default Electron icon even though every config path looks right.
 * A missing/one-size .ico fails the same way, so both are validated here and the
 * packaging scripts run this before electron-builder.
 *
 *   node scripts/check-app-icon.mjs            # windows/linux checks
 *   node scripts/check-app-icon.mjs --mac      # also requires build/icon.icns
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_ICO_SIZES = [16, 32, 48, 256];

/** Parse the ICONDIR of a .ico file and return the square sizes it carries. */
export function readIcoSizes(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error("不是有效的 .ico 文件（缺少 ICONDIR 头）");
  }
  const count = buffer.readUInt16LE(4);
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    if (entry + 16 > buffer.length) break;
    const width = buffer[entry] === 0 ? 256 : buffer[entry];
    const height = buffer[entry + 1] === 0 ? 256 : buffer[entry + 1];
    if (width === height) sizes.push(width);
  }
  return sizes;
}

function main() {
  const requireMac = process.argv.includes("--mac");
  const problems = [];

  const icoPath = path.join(root, "build", "icon.ico");
  if (!existsSync(icoPath)) {
    problems.push("缺少 build/icon.ico（先运行 npm run icons）");
  } else {
    try {
      const sizes = readIcoSizes(readFileSync(icoPath));
      const missing = REQUIRED_ICO_SIZES.filter((size) => !sizes.includes(size));
      if (missing.length > 0) {
        problems.push(`build/icon.ico 缺少分辨率 ${missing.join("/")}（现有 ${sizes.join("/")}）`);
      }
    } catch (error) {
      problems.push(`build/icon.ico 无效：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const pngPath = path.join(root, "build", "icon.png");
  if (!existsSync(pngPath)) problems.push("缺少 build/icon.png（Linux）");

  if (requireMac && !existsSync(path.join(root, "build", "icon.icns"))) {
    problems.push("缺少 build/icon.icns（macOS）");
  }

  if (problems.length > 0) {
    console.error("应用图标检查未通过：");
    for (const problem of problems) console.error(`  · ${problem}`);
    console.error("\n修复：npm run icons（从 PiForge_ico/PiForge.ico 重新生成全部尺寸）");
    process.exit(1);
  }

  console.log("应用图标检查通过：build/icon.ico（16/32/48/256）、build/icon.png");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
